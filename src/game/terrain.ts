import * as THREE from 'three/webgpu';
import { fbm } from './noise';

export const WORLD_SIZE = 420;
/** Players can walk inside this half-extent; the rim beyond rises into hills. */
export const PLAY_HALF = 175;

export const VILLAGE_CENTER = new THREE.Vector2(0, 40);
export const VILLAGE_RADIUS = 48;
export const VILLAGE_HEIGHT = 2;
export const RUINS_CENTER = new THREE.Vector2(15, -115);
export const RUINS_RADIUS = 36;
export const RUINS_HEIGHT = 9;
export const BANDIT_CAMP = new THREE.Vector2(72, -5);
export const CAMP_RADIUS = 16;

/** Main road from the village gate north to the ruins. */
const ROAD: THREE.Vector2[] = [
  new THREE.Vector2(0, 40),
  new THREE.Vector2(-8, 0),
  new THREE.Vector2(10, -35),
  new THREE.Vector2(-5, -70),
  new THREE.Vector2(15, -115),
];

function distToSegment(px: number, pz: number, a: THREE.Vector2, b: THREE.Vector2): number {
  const abx = b.x - a.x;
  const abz = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (pz - a.y) * abz) / (abx * abx + abz * abz)));
  return Math.hypot(px - (a.x + abx * t), pz - (a.y + abz * t));
}

export function roadDistance(x: number, z: number): number {
  let d = Infinity;
  for (let i = 0; i < ROAD.length - 1; i++) d = Math.min(d, distToSegment(x, z, ROAD[i], ROAD[i + 1]));
  return d;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Raw height before flattening of settlements and roads. */
function naturalHeight(x: number, z: number): number {
  let h = fbm(x * 0.008, z * 0.008, 5, 3) * 26 - 8;
  h += fbm(x * 0.04, z * 0.04, 3, 11) * 2.5;
  // Rising rim keeps players inside the map without invisible walls.
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h += smoothstep(PLAY_HALF - 25, WORLD_SIZE / 2, edge) * 45;
  return h;
}

export function heightAt(x: number, z: number): number {
  let h = naturalHeight(x, z);
  const dv = Math.hypot(x - VILLAGE_CENTER.x, z - VILLAGE_CENTER.y);
  h = THREE.MathUtils.lerp(VILLAGE_HEIGHT + fbm(x * 0.05, z * 0.05, 2, 5) * 0.6, h, smoothstep(VILLAGE_RADIUS * 0.75, VILLAGE_RADIUS * 1.4, dv));
  const dr = Math.hypot(x - RUINS_CENTER.x, z - RUINS_CENTER.y);
  h = THREE.MathUtils.lerp(RUINS_HEIGHT + fbm(x * 0.06, z * 0.06, 2, 9) * 0.8, h, smoothstep(RUINS_RADIUS * 0.7, RUINS_RADIUS * 1.5, dr));
  const dc = Math.hypot(x - BANDIT_CAMP.x, z - BANDIT_CAMP.y);
  if (dc < CAMP_RADIUS * 1.6) {
    const campH = naturalHeight(BANDIT_CAMP.x, BANDIT_CAMP.y);
    h = THREE.MathUtils.lerp(campH, h, smoothstep(CAMP_RADIUS * 0.6, CAMP_RADIUS * 1.6, dc));
  }
  // Roads cut a gentle, smoothed bed into the hills.
  const road = roadDistance(x, z);
  if (road < 9) {
    const blurred = (naturalHeight(x + 4, z) + naturalHeight(x - 4, z) + naturalHeight(x, z + 4) + naturalHeight(x, z - 4)) / 4;
    h = THREE.MathUtils.lerp(Math.min(h, blurred), h, smoothstep(3, 9, road));
  }
  return h;
}

export function normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 0.5;
  return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
}

export function createTerrain(segments: number, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const normals = geo.attributes.normal;
  // Tint (vertex colour, ~0.625 = neutral) and splat weights (mud, rock, stone).
  const colors = new Float32Array(pos.count * 3);
  const splat = new Float32Array(pos.count * 3);
  const tint = new THREE.Color();
  const dry = new THREE.Color(0.75, 0.68, 0.42);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const slope = 1 - normals.getY(i);
    const dv = Math.hypot(x - VILLAGE_CENTER.x, z - VILLAGE_CENTER.y);
    const dr = Math.hypot(x - RUINS_CENTER.x, z - RUINS_CENTER.y);
    const dc = Math.hypot(x - BANDIT_CAMP.x, z - BANDIT_CAMP.y);
    const mud = Math.max(
      1 - smoothstep(2, 4.5, roadDistance(x, z)),
      (1 - smoothstep(10, 16, dv)) * 0.8,
      (1 - smoothstep(6, 12, dc)) * 0.85,
      smoothstep(0.62, 0.8, fbm(x * 0.05, z * 0.05, 3, 51)) * 0.7,
    );
    const rock = smoothstep(0.1, 0.26, slope);
    const stoneFloor = (1 - smoothstep(14, 22, dr)) * 0.9;
    splat.set([mud, rock, stoneFloor], i * 3);
    tint.setRGB(1, 1, 1).lerp(dry, smoothstep(0.55, 0.8, fbm(x * 0.012, z * 0.012, 3, 31)) * 0.5);
    tint.multiplyScalar(0.625 * (0.85 + fbm(x * 0.08, z * 0.08, 2, 41) * 0.3));
    colors.set([tint.r, tint.g, tint.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('splat', new THREE.BufferAttribute(splat, 3));
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}
