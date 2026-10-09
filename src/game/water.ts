import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, cameraViewMatrix, float, mix, mx_noise_float, positionWorld, smoothstep, time, vec2, vec3, vec4,
} from 'three/tsl';
import { heightAt, POND_CENTER, POND_LEVEL, POND_RADIUS, STREAM } from './terrain';

/**
 * Stream ribbon + pond disc. Each vertex stores its water depth (from the
 * carved terrain) for the shallow-to-deep colour and soft shorelines, and flow
 * coordinates so ripples run downstream.
 */
export function createWater(): THREE.Mesh {
  const pos: number[] = [];
  const depth: number[] = [];
  const flow: number[] = [];
  const idx: number[] = [];
  const add = (x: number, y: number, z: number, u: number, v: number, speed: number) => {
    pos.push(x, y, z);
    depth.push(Math.max(0, y - heightAt(x, z)));
    flow.push(u, v, speed);
    return pos.length / 3 - 1;
  };

  // Stream: cross-sections along the centreline, wide enough to reach under the banks.
  const ACROSS = 10;
  for (let i = 0; i < STREAM.length - 1; i++) {
    const p = STREAM[i];
    const n = STREAM[Math.min(STREAM.length - 1, i + 1)], q = STREAM[Math.max(0, i - 1)];
    let sx = -(n.z - q.z), sz = n.x - q.x;
    const len = Math.hypot(sx, sz);
    sx /= len; sz /= len;
    const half = p.width + 2.5;
    for (let k = 0; k <= ACROSS; k++) {
      const a = (k / ACROSS) * 2 - 1;
      add(p.x + sx * a * half, p.level, p.z + sz * a * half, a * half, p.s, 1);
    }
    if (i > 0) {
      const b0 = (i - 1) * (ACROSS + 1), b1 = i * (ACROSS + 1);
      for (let k = 0; k < ACROSS; k++) idx.push(b0 + k, b1 + k, b0 + k + 1, b0 + k + 1, b1 + k, b1 + k + 1);
    }
  }

  // Pond: rings of vertices; ripples drift slowly.
  const RINGS = 9, SIDES = 48;
  const centre = add(POND_CENTER.x, POND_LEVEL, POND_CENTER.y, POND_CENTER.x, POND_CENTER.y, 0.12);
  for (let r = 1; r <= RINGS; r++) {
    const rad = ((POND_RADIUS + 3) * r) / RINGS;
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      const x = POND_CENTER.x + Math.cos(a) * rad, z = POND_CENTER.y + Math.sin(a) * rad;
      add(x, POND_LEVEL, z, x, z, 0.12);
    }
  }
  const ring = (r: number, k: number) => centre + 1 + (r - 1) * SIDES + (k % SIDES);
  for (let k = 0; k < SIDES; k++) idx.push(centre, ring(1, k + 1), ring(1, k));
  for (let r = 1; r < RINGS; r++) {
    for (let k = 0; k < SIDES; k++) idx.push(ring(r, k), ring(r, k + 1), ring(r + 1, k), ring(r, k + 1), ring(r + 1, k + 1), ring(r + 1, k));
  }

  // Make every triangle face up (counter-clockwise seen from above).
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    const cross = (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    if (cross < 0) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('depth', new THREE.Float32BufferAttribute(depth, 1));
  geo.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshPhysicalNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.06, metalness: 0, specularIntensity: 0.55 });
  const d = attribute<'float'>('depth');
  const f = attribute<'vec3'>('flow');
  // Two octaves of noise scrolled downstream; the gradient tilts the normal.
  const uv0 = vec2(f.x, f.y.sub(time.mul(f.z).mul(1.6)));
  const ripple = (p: THREE.Node<'vec2'>) => mx_noise_float(vec3(p.mul(0.45), time.mul(0.3))).add(mx_noise_float(vec3(p.mul(1.4), time.mul(0.5))).mul(0.35));
  const e = 0.1;
  const h0 = ripple(uv0);
  const gx = ripple(uv0.add(vec2(e, 0))).sub(h0).div(e);
  const gz = ripple(uv0.add(vec2(0, e))).sub(h0).div(e);
  // Calmer with distance so far ripples do not sparkle.
  const strength = mix(float(0.04), float(0.1), f.z).div(positionWorld.sub(cameraPosition).length().mul(0.04).add(1));
  const nWorld = vec3(gx.mul(strength).negate(), 1, gz.mul(strength).negate()).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();

  const deep = vec3(0.006, 0.022, 0.02);
  const shallow = vec3(0.06, 0.075, 0.045);
  const depthT = smoothstep(0.05, 1.3, d);
  // Foam where the stream is shallow and lively.
  const foam = smoothstep(0.12, 0.0, d).mul(smoothstep(0.2, 0.6, h0.add(0.2))).mul(f.z).mul(0.3);
  mat.colorNode = mix(mix(shallow, deep, depthT), vec3(0.7, 0.72, 0.68), foam);
  mat.opacityNode = smoothstep(0.0, 0.2, d).mul(mix(float(0.3), float(0.88), depthT)).max(foam);
  mat.roughnessNode = mix(float(0.05), float(0.4), foam);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}
