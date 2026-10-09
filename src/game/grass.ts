import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, cameraViewMatrix, cos, dot, float, Fn, instanceIndex, max, mix, positionGeometry,
  positionWorld, pow, sin, smoothstep, step, texture, time, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import type { QualitySettings } from '../engine/quality';
import { rng } from './noise';
import { SKY_SUN } from './sky';
import { WORLD_SIZE, waterDistance } from './terrain';

/**
 * GPU grass: a grid of 2 m tiles that follows the camera. Every blade finds its
 * height, density and tint in a texture baked from the terrain mesh, so the
 * CPU never touches individual blades. A dense ring near the player plus a
 * sparser, wider-bladed ring further out; blades sway in rolling gusts and
 * bend away from the player.
 */

const TILE = 2;
const WIND = new THREE.Vector2(0.8, 0.6).normalize();

export interface Grass {
  update(camera: THREE.Camera, player: THREE.Vector3): void;
}

interface Ring {
  radius: number;
  inner: number;
  perM2: number;
  segments: number;
  width: number;
}

function bladeTile(ring: Ring, seed: number): THREE.BufferGeometry {
  const rand = rng(seed);
  const blades = Math.round(ring.perM2 * TILE * TILE);
  const pos: number[] = [], blade: number[] = [], idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const lx = rand() * TILE, lz = rand() * TILE, yaw = rand() * Math.PI * 2, r = rand();
    const base = pos.length / 3;
    for (let k = 0; k < ring.segments; k++) {
      const y = k / ring.segments;
      const w = ring.width * (1 - y * 0.85) * 0.5;
      pos.push(-w, y, 0, w, y, 0);
      blade.push(lx, lz, yaw, r, lx, lz, yaw, r);
    }
    pos.push(0, 1, 0);
    blade.push(lx, lz, yaw, r);
    for (let k = 0; k < ring.segments - 1; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const a = base + (ring.segments - 1) * 2;
    idx.push(a, a + 1, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('blade', new THREE.Float32BufferAttribute(blade, 4));
  g.setIndex(idx);
  return g;
}

/** Height, grass density, brightness and dryness per terrain vertex (half float, filterable). */
function terrainData(terrain: THREE.Mesh): { tex: THREE.DataTexture; size: number } {
  const geo = terrain.geometry;
  const pos = geo.attributes.position, splat = geo.attributes.splat, col = geo.attributes.color;
  const size = Math.round(Math.sqrt(pos.count));
  const data = new Uint16Array(size * size * 4);
  const seg = size - 1;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const cx = Math.round(((x + WORLD_SIZE / 2) / WORLD_SIZE) * seg);
    const cz = Math.round(((z + WORLD_SIZE / 2) / WORLD_SIZE) * seg);
    const wet = THREE.MathUtils.smoothstep(waterDistance(x, z), 0.3, 2.5);
    const density = (1 - splat.getX(i)) * (1 - splat.getY(i)) * (1 - splat.getZ(i)) * wet;
    const g = col.getY(i), b = col.getZ(i);
    const dry = THREE.MathUtils.clamp((1 - b / g) / 0.155, 0, 1);
    const o = (cz * size + cx) * 4;
    data[o] = THREE.DataUtils.toHalfFloat(pos.getY(i));
    data[o + 1] = THREE.DataUtils.toHalfFloat(density);
    data[o + 2] = THREE.DataUtils.toHalfFloat(g * 1.6);
    data[o + 3] = THREE.DataUtils.toHalfFloat(dry);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, size };
}

export function createGrass(quality: QualitySettings, terrain: THREE.Mesh, grassTexture: THREE.Texture, scene: THREE.Scene): Grass {
  const rings: Ring[] = {
    low: [{ radius: 12, inner: 0, perM2: 26, segments: 2, width: 0.08 }],
    medium: [
      { radius: 15, inner: 0, perM2: 32, segments: 3, width: 0.075 },
      { radius: 30, inner: 11, perM2: 7, segments: 2, width: 0.14 },
    ],
    high: [
      { radius: 19, inner: 0, perM2: 50, segments: 3, width: 0.07 },
      { radius: 44, inner: 14, perM2: 10, segments: 2, width: 0.13 },
    ],
  }[quality.tier];

  const { tex, size } = terrainData(terrain);
  const centre = uniform(new THREE.Vector2());
  const player = uniform(new THREE.Vector3(0, -999, 0));
  const sunDir = vec3(SKY_SUN.x, SKY_SUN.y, SKY_SUN.z);
  const meshes: THREE.InstancedMesh[] = [];

  rings.forEach((ring, ri) => {
    const n = Math.ceil((ring.radius * 2) / TILE) + 1;
    const geo = bladeTile(ring, 7 + ri);
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
    const blade = attribute<'vec4'>('blade');
    const g = positionGeometry;

    // Root of this blade in the world.
    const ix = instanceIndex.mod(n), iz = instanceIndex.div(n);
    const tileOrigin = centre.add(vec2(float(ix), float(iz)).sub(Math.floor(n / 2))).mul(TILE);
    const root = tileOrigin.add(blade.xy);
    const sampleAt = (xz: THREE.Node<'vec2'>) => {
      const uvT = xz.add(WORLD_SIZE / 2).div(WORLD_SIZE).mul((size - 1) / size).add(0.5 / size);
      return texture(tex, uvT).level(float(0));
    };
    const data = sampleAt(root);
    const dist = root.sub(cameraPosition.xz).length();

    const height = Fn(() => {
      // Thin out by terrain density, then fade across this ring's band.
      const keep = step(blade.w, data.y.mul(1.15).sub(0.1));
      const outer = smoothstep(ring.radius, ring.radius * 0.72, dist);
      const inner = ring.inner > 0 ? smoothstep(ring.inner * 0.85, ring.inner * 1.15, dist) : float(1);
      const fade = step(blade.w, outer.mul(inner).mul(1.05));
      return keep.mul(fade).mul(blade.w.mul(0.28).add(0.16)).mul(data.y.mul(0.4).add(0.6));
    })();

    mat.positionNode = Fn(() => {
      const y = g.y;
      // Rolling gusts travel across the field; each blade adds its own jitter.
      const along = dot(root, vec2(WIND.x, WIND.y));
      const gust = sin(along.mul(0.18).sub(time.mul(1.6))).mul(0.5).add(0.5);
      const jitter = sin(time.mul(2.7).add(blade.w.mul(40)).add(root.x.mul(0.7)));
      const lean = gust.mul(0.45).add(jitter.mul(0.08)).add(0.12);
      const bend = vec2(WIND.x, WIND.y).mul(lean).toVar();
      // Push away from the player's feet.
      const away = root.sub(player.xz);
      const near = smoothstep(1.3, 0.2, away.length()).mul(step(player.y.sub(1), data.x));
      bend.addAssign(away.normalize().mul(near).mul(1.1));
      const curve = pow(y, 1.6);
      const yaw = blade.z;
      const side = vec2(cos(yaw), sin(yaw)).mul(g.x);
      const droop = float(1).sub(bend.length().min(1.2).mul(0.3).mul(curve));
      return vec3(root.x.add(side.x).add(bend.x.mul(curve).mul(height)), data.x.add(y.mul(height).mul(droop)).sub(0.02), root.y.add(side.y).add(bend.y.mul(curve).mul(height)));
    })();

    // Up-facing normals light the grass like the ground it grows from.
    const facing = vec3(sin(blade.z).negate(), 0, cos(blade.z));
    mat.normalNode = cameraViewMatrix.mul(vec4(facing.mul(0.25).add(vec3(0, 1, 0)).normalize(), 0)).xyz.normalize();

    // Colour: the terrain's own grass texture under the blade, darker at the root,
    // sun-bleached and drier toward the tips.
    const ground = mix(texture(grassTexture, root.div(4)).rgb, texture(grassTexture, root.div(18.8)).rgb, 0.4).mul(vec3(0.74, 1.06, 0.52)).mul(data.z);
    const tipCol = mix(ground.mul(vec3(1.15, 1.25, 0.95)), vec3(0.4, 0.37, 0.17), data.w.mul(0.15).add(blade.w.mul(0.06)));
    const albedo = mix(ground.mul(0.6), tipCol, g.y);
    mat.colorNode = albedo;
    const toCam = cameraPosition.sub(positionWorld).normalize();
    const back = pow(max(dot(toCam, sunDir.negate()), 0), 3);
    mat.emissiveNode = albedo.mul(vec3(1.0, 0.75, 0.4)).mul(back).mul(g.y).mul(0.5);

    const mesh = new THREE.InstancedMesh(geo, mat, n * n);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = `grass${ri}`;
    scene.add(mesh);
    meshes.push(mesh);
  });

  return {
    update(camera, playerPos) {
      centre.value.set(Math.floor(camera.position.x / TILE), Math.floor(camera.position.z / TILE));
      player.value.copy(playerPos);
    },
  };
}
