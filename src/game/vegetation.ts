import * as THREE from 'three/webgpu';
import {
  atan, attribute, cameraPosition, cameraViewMatrix, color, cos, dot, floor, Fn, max, mod, normalMap,
  normalWorld, positionGeometry, positionLocal, positionWorld, pow, sin, texture, time, uv,
  vec2, vec3, vec4,
} from 'three/tsl';
import type { QualitySettings } from '../engine/quality';
import type { ColliderWorld } from './colliders';
import { fbm, rng } from './noise';
import { SKY_SUN } from './sky';
import { heightAt, normalAt, PLAY_HALF } from './terrain';

/**
 * Forest of ez-tree trees and bushes (baked by tools/trees/bake_trees.mjs).
 * Near the camera every tree is a real instanced mesh swaying in the wind;
 * further out it becomes an impostor: a camera-facing card showing one of
 * eight pre-rendered views (albedo + normals, so it is still lit, shadowed and
 * fogged like the meshes).
 */

interface Part {
  vertices: number;
  indices: number;
  index32: boolean;
  position: number;
  normal: number;
  uv: number;
  ao?: number;
  index: number;
}
interface VariantHeader {
  name: string;
  bark: string;
  leaf: string;
  barkTint: number;
  leafTint: number;
  barkRepeat: [number, number];
  alphaTest: number;
  height: number;
  radius: number;
  branches: Part;
  leaves: Part;
}

type Species = 'pine' | 'broad' | 'bush';
const SPECIES: Record<Species, string[]> = { pine: ['pine_a', 'pine_b'], broad: ['oak_a', 'oak_b', 'ash_a'], bush: ['bush_a', 'bush_b'] };

/** Where trees may grow. */
export type CanGrow = (x: number, z: number, clearance: number) => boolean;

export interface Vegetation {
  /** Re-sorts trees into mesh / impostor sets when the camera has moved. */
  update(camera: THREE.Camera): void;
  /** Changes the mesh/impostor switch distance (bushes switch at half of it). */
  setNearRadius(r: number): void;
}

const VIEWS = 8;
const WIND = new THREE.Vector2(0.8, 0.6).normalize();

function geometry(bin: ArrayBuffer, part: Part, withAo: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, part.position, part.vertices * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bin, part.normal, part.vertices * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bin, part.uv, part.vertices * 2), 2));
  if (withAo && part.ao !== undefined) g.setAttribute('ao', new THREE.BufferAttribute(new Float32Array(bin, part.ao, part.vertices), 1));
  const index = part.index32 ? new Uint32Array(bin, part.index, part.indices) : new Uint16Array(bin, part.index, part.indices);
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Wind: the whole tree leans and sways with height², outer branches a little
 * more, leaves add a fast flutter. Phase comes from world position so
 * neighbouring trees move together like a gust passing through.
 */
function windNode(height: number, radius: number, strength: number, flutter: boolean) {
  return Fn(() => {
    const p = positionLocal;
    const g = positionGeometry;
    const phase = dot(p.xz, vec2(0.045, 0.035));
    const bend = pow(g.y.div(height).clamp(0, 1), 2).add(g.xz.length().div(radius).mul(0.35));
    const sway = sin(time.mul(0.9).add(phase)).mul(0.55).add(sin(time.mul(2.1).add(phase.mul(1.7))).mul(0.2)).add(0.3);
    const amount = bend.mul(sway).mul(strength);
    const offset = vec3(amount.mul(WIND.x), amount.mul(-0.15).mul(bend), amount.mul(WIND.y)).toVar();
    if (flutter) {
      const f = sin(time.mul(6.5).add(dot(p, vec3(2.3, 1.7, 2.9)))).mul(0.05).mul(uv().y).mul(bend.min(1).add(0.3));
      offset.addAssign(vec3(f, f.mul(0.5), f.negate()));
    }
    return p.add(offset);
  })();
}

const sunDir = vec3(SKY_SUN.x, SKY_SUN.y, SKY_SUN.z);

/** Golden backlight through thin leaves (cheap translucency). */
function leafGlow(albedo: THREE.Node<'vec3'>) {
  const toCam = cameraPosition.sub(positionWorld).normalize();
  const back = pow(max(dot(toCam, sunDir.negate()), 0), 4);
  return albedo.mul(vec3(1.0, 0.72, 0.38)).mul(back).mul(0.9);
}

export async function createVegetation(
  renderer: THREE.WebGPURenderer, quality: QualitySettings, scene: THREE.Scene, colliders: ColliderWorld, canGrow: CanGrow,
): Promise<Vegetation> {
  const base = import.meta.env.BASE_URL;
  const [header, bin] = await Promise.all([
    fetch(`${base}models/trees.json`).then((r) => r.json() as Promise<{ variants: VariantHeader[] }>),
    fetch(`${base}models/trees.bin`).then((r) => r.arrayBuffer()),
  ]);
  const suffix = quality.tier === 'low' ? '_low' : '';
  const loader = new THREE.TextureLoader();
  const textures = new Map<string, Promise<THREE.Texture>>();
  const tex = (file: string, srgb: boolean) => {
    if (!textures.has(file)) {
      textures.set(file, loader.loadAsync(`${base}textures/trees/${file}${suffix}.webp`).then((t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 4;
        return t;
      }));
    }
    return textures.get(file)!;
  };

  const nearRadius = { low: 26, medium: 40, high: 55 }[quality.tier];
  const farRadius = quality.fogFar;
  const frame = { low: 128, medium: 192, high: 256 }[quality.tier];
  const useNormalMaps = quality.tier !== 'low';

  // ------------------------------------------------------------ placement
  const rand = rng(1234);
  const counts: Record<Species, number> = {
    pine: Math.round(650 * quality.vegetationDensity),
    broad: Math.round(380 * quality.vegetationDensity),
    bush: Math.round(700 * quality.vegetationDensity),
  };
  type Inst = { x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color };
  const placed = new Map<string, Inst[]>(header.variants.map((v) => [v.name, []]));
  const normal = new THREE.Vector3();
  const extent = PLAY_HALF + 30;
  for (const species of Object.keys(SPECIES) as Species[]) {
    const names = SPECIES[species];
    for (let i = 0, tries = 0; i < counts[species] && tries < counts[species] * 30; tries++) {
      const x = (rand() * 2 - 1) * extent;
      const z = (rand() * 2 - 1) * extent;
      // Woods grow in clumps with clearings between; pines like the high ground.
      const woods = fbm(x * 0.012, z * 0.012, 3, 91);
      const h = heightAt(x, z);
      const want = species === 'pine' ? woods * 1.4 + THREE.MathUtils.smoothstep(h, 4, 22) * 0.5 - 0.35
        : species === 'broad' ? woods * 1.4 - THREE.MathUtils.smoothstep(h, 10, 24) * 0.4 - 0.2
          : woods * 1.1 - 0.05;
      if (rand() > want) continue;
      if (!canGrow(x, z, species === 'bush' ? 2.5 : 5.5)) continue;
      if (normalAt(x, z, normal).y < 0.8) continue;
      const name = names[Math.floor(rand() * names.length)];
      const scale = species === 'bush' ? 0.7 + rand() * 0.7 : 0.75 + rand() * 0.5;
      const tint = new THREE.Color().setHSL(0, 0, 1).offsetHSL((rand() - 0.5) * 0.04, (rand() - 0.5) * 0.15, (rand() - 0.5) * 0.12);
      placed.get(name)!.push({ x, y: h - 0.15, z, scale, yaw: rand() * Math.PI * 2, tint });
      i++;
    }
  }

  // ------------------------------------------------------------ variants
  const bakeScene = new THREE.Scene();
  const variants = await Promise.all(header.variants.map(async (v) => {
    const instances = placed.get(v.name)!;
    const branchGeo = geometry(bin, v.branches, false);
    const leafGeo = geometry(bin, v.leaves, true);
    const [barkColor, barkNormal, leafMap] = await Promise.all([
      tex(`${v.bark}_bark_color`, true), useNormalMaps ? tex(`${v.bark}_bark_normal`, false) : null, tex(`${v.leaf}_leaves`, true),
    ]);
    const isBush = v.name.startsWith('bush');
    const windStrength = isBush ? 0.12 : v.height * 0.022;

    // Trunk collider sized to the visible trunk, not the flared roots or low branches
    // (which made invisible walls). Trunk rings are sparse, so take the innermost
    // vertex between knee and head height: that is the trunk ring's radius.
    const bp = branchGeo.attributes.position;
    const ring: number[] = [];
    for (let i = 0; i < bp.count; i++) {
      const y = bp.getY(i);
      if (y > 0.3 && y < 2) ring.push(Math.hypot(bp.getX(i), bp.getZ(i)));
    }
    const inner = ring.length ? Math.min(...ring) : 0.3;
    const trunk = ring.reduce((m, d) => (d <= inner * 1.5 ? Math.max(m, d) : m), inner);
    if (!isBush) {
      for (const t of instances) {
        if (Math.abs(t.x) < PLAY_HALF + 5 && Math.abs(t.z) < PLAY_HALF + 5) colliders.add({ kind: 'circle', x: t.x, z: t.z, r: Math.max(0.2, trunk * t.scale) });
      }
    }

    const barkUv = uv().mul(vec2(v.barkRepeat[0], v.barkRepeat[1] * (isBush ? 0.3 : 0.15)));
    const bark = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    bark.colorNode = texture(barkColor, barkUv).rgb.mul(color(v.barkTint));
    if (barkNormal) bark.normalNode = normalMap(texture(barkNormal, barkUv).rgb);
    bark.positionNode = windNode(v.height, v.radius, windStrength, false);

    const leafTex = texture(leafMap);
    const leaves = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.75, metalness: 0, alphaTest: v.alphaTest });
    const leafAlbedo = leafTex.rgb.mul(color(v.leafTint)).mul(vec3(0.92, 1.0, 0.85));
    leaves.colorNode = leafAlbedo;
    leaves.opacityNode = leafTex.a;
    leaves.aoNode = attribute<'float'>('ao');
    leaves.emissiveNode = leafGlow(leafAlbedo).mul(attribute<'float'>('ao'));
    leaves.positionNode = windNode(v.height, v.radius, windStrength, true);

    const cap = Math.max(1, instances.length);
    const branchMesh = new THREE.InstancedMesh(branchGeo, bark, cap);
    const leafMesh = new THREE.InstancedMesh(leafGeo, leaves, cap);
    leafMesh.instanceMatrix = branchMesh.instanceMatrix;
    for (const m of [branchMesh, leafMesh]) {
      m.count = 0;
      m.frustumCulled = false;
      // Bushes are too low to throw shadows worth their cost.
      m.castShadow = !isBush;
      m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
    // Per-tree tint goes on the leaves only.
    leafMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    leafMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    // -------------------------------------------------------- impostor bake
    // Frame: square of side S, trunk base at the bottom centre.
    const S = Math.max(v.radius * 2, v.height) * 1.04;
    const albedoMat = (m: 'bark' | 'leaf') => {
      const mat = new THREE.MeshBasicNodeMaterial({ side: m === 'leaf' ? THREE.DoubleSide : THREE.FrontSide, alphaTest: m === 'leaf' ? v.alphaTest : 0 });
      if (m === 'leaf') {
        // Solid alpha where a leaf survives the cutout, so mipmaps keep coverage.
        mat.colorNode = vec4(leafAlbedo.mul(attribute<'float'>('ao')), 1);
        mat.opacityNode = leafTex.a;
      } else {
        mat.colorNode = vec4(texture(barkColor, barkUv).rgb.mul(color(v.barkTint)).mul(0.8), 1);
      }
      return mat;
    };
    const normalMat = (m: 'bark' | 'leaf') => {
      const mat = new THREE.MeshBasicNodeMaterial({ side: m === 'leaf' ? THREE.DoubleSide : THREE.FrontSide, alphaTest: m === 'leaf' ? v.alphaTest : 0 });
      mat.colorNode = vec4(normalWorld.mul(0.5).add(0.5), 1);
      if (m === 'leaf') mat.opacityNode = leafTex.a;
      return mat;
    };
    const bake = (kind: 'albedo' | 'normal') => {
      const target = new THREE.RenderTarget(frame * VIEWS, frame, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
      const make = kind === 'albedo' ? albedoMat : normalMat;
      const bm = make('bark'), lm = make('leaf');
      const group = new THREE.Group();
      for (let i = 0; i < VIEWS; i++) {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(branchGeo, bm), new THREE.Mesh(leafGeo, lm));
        g.rotation.y = (-i / VIEWS) * Math.PI * 2;
        g.position.x = (i + 0.5) * S - (VIEWS * S) / 2;
        group.add(g);
      }
      bakeScene.add(group);
      const cam = new THREE.OrthographicCamera((-VIEWS * S) / 2, (VIEWS * S) / 2, S, 0, 0.1, 400);
      cam.position.set(0, 0, 200);
      cam.lookAt(0, 0, 0);
      const prevTarget = renderer.getRenderTarget();
      const prevColor = renderer.getClearColor(new THREE.Color());
      const prevAlpha = renderer.getClearAlpha();
      // Clear to the average foliage colour so mipmaps do not get dark fringes.
      renderer.setClearColor(kind === 'albedo' ? 0x3a4a22 : 0x8080ff, 0);
      renderer.setRenderTarget(target);
      renderer.render(bakeScene, cam);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevColor, prevAlpha);
      bakeScene.remove(group);
      bm.dispose();
      lm.dispose();
      return target.texture;
    };
    const albedoAtlas = bake('albedo');
    const normalAtlas = bake('normal');

    // -------------------------------------------------------- impostor mesh
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    const card = new THREE.InstancedBufferGeometry();
    card.index = quad.index;
    card.setAttribute('position', quad.attributes.position);
    card.setAttribute('uv', quad.attributes.uv);
    const inst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); // x, y, z, scale
    const inst2 = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); // yaw, tint rgb
    inst.setUsage(THREE.DynamicDrawUsage);
    inst2.setUsage(THREE.DynamicDrawUsage);
    card.setAttribute('inst', inst);
    card.setAttribute('inst2', inst2);
    card.instanceCount = 0;

    const imp = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, alphaTest: 0.5 });
    const I = attribute<'vec4'>('inst');
    const I2 = attribute<'vec4'>('inst2');
    const toCamXZ = cameraPosition.xz.sub(I.xz);
    imp.positionNode = Fn(() => {
      const dir = toCamXZ.normalize();
      const right = vec3(dir.y, 0, dir.x.negate());
      const size = I.w.mul(S);
      return I.xyz.add(right.mul(positionGeometry.x.mul(size))).add(vec3(0, positionGeometry.y.mul(size), 0));
    })();
    // Which baked view faces the camera, in the tree's own frame.
    const TAU = Math.PI * 2;
    const view = Fn(() => {
      // Camera azimuth around the tree (atan(x, z)) minus the tree's yaw.
      const a = mod(atan(toCamXZ.x, toCamXZ.y).sub(I2.x).add(TAU * 4), TAU);
      return mod(floor(a.div(TAU / VIEWS).add(0.5)), VIEWS);
    })();
    // Render-target rows run top-down.
    const atlasUv = vec2(view.add(uv().x).div(VIEWS), uv().y.oneMinus());
    const albedo = texture(albedoAtlas, atlasUv);
    imp.colorNode = albedo.rgb.mul(I2.yzw);
    // Mip levels average coverage down; boost it so distant crowns stay full.
    imp.opacityNode = albedo.a.mul(1.7);
    const nFrame = texture(normalAtlas, atlasUv).rgb.mul(2).sub(1);
    const phi = I2.x.add(view.mul(TAU / VIEWS));
    const c = cos(phi), s = sin(phi);
    const nWorld = vec3(nFrame.x.mul(c).add(nFrame.z.mul(s)), nFrame.y, nFrame.x.negate().mul(s).add(nFrame.z.mul(c))).normalize();
    imp.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
    imp.emissiveNode = leafGlow(albedo.rgb).mul(0.6);
    const impostor = new THREE.Mesh(card, imp);
    impostor.frustumCulled = false;
    impostor.castShadow = quality.tier !== 'low' && !isBush;
    impostor.receiveShadow = true;
    scene.add(impostor);

    const r = isBush ? nearRadius * 0.5 : nearRadius;
    return { v, instances, branchMesh, leafMesh, card, inst, inst2, near: new Uint8Array(instances.length), in2: r * r, out2: (r + 5) ** 2 };
  }));

  // ------------------------------------------------------------ LOD sorting
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const lastSort = new THREE.Vector3(Infinity, 0, 0);
  const far2 = farRadius * farRadius;

  return {
    setNearRadius(r) {
      for (const t of variants) {
        const rr = t.v.name.startsWith('bush') ? r * 0.5 : r;
        t.in2 = rr * rr;
        t.out2 = (rr + 5) ** 2;
      }
      lastSort.set(Infinity, 0, 0);
    },
    update(camera) {
      const cp = camera.position;
      if (cp.distanceToSquared(lastSort) < 4) return;
      lastSort.copy(cp);
      for (const t of variants) {
        let nNear = 0, nFar = 0;
        const ia = t.inst.array as Float32Array, ib = t.inst2.array as Float32Array;
        const colors = t.leafMesh.instanceColor!.array as Float32Array;
        for (let i = 0; i < t.instances.length; i++) {
          const it = t.instances[i];
          const d2 = (it.x - cp.x) ** 2 + (it.z - cp.z) ** 2;
          // Hysteresis so trees on the boundary do not flicker between forms.
          const isNear = d2 < t.in2 || (t.near[i] === 1 && d2 < t.out2);
          t.near[i] = isNear ? 1 : 0;
          if (isNear) {
            q.setFromAxisAngle(up, it.yaw);
            m.compose(p.set(it.x, it.y, it.z), q, s.setScalar(it.scale));
            t.branchMesh.setMatrixAt(nNear, m);
            colors.set([it.tint.r, it.tint.g, it.tint.b], nNear * 3);
            nNear++;
          } else if (d2 < far2) {
            ia.set([it.x, it.y, it.z, it.scale], nFar * 4);
            ib.set([it.yaw, it.tint.r, it.tint.g, it.tint.b], nFar * 4);
            nFar++;
          }
        }
        t.branchMesh.count = t.leafMesh.count = nNear;
        t.branchMesh.instanceMatrix.needsUpdate = true;
        t.leafMesh.instanceColor!.needsUpdate = true;
        t.card.instanceCount = nFar;
        t.inst.needsUpdate = true;
        t.inst2.needsUpdate = true;
      }
    },
  };
}

