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

/** Natural height with the village, ruins and camp levelled. */
function settledHeight(x: number, z: number): number {
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
  return h;
}

/** Height of the land before the stream is carved in. */
function landHeight(x: number, z: number): number {
  const h = settledHeight(x, z);
  // Roads cut a gentle, smoothed bed into the hills (but never into the levelled sites).
  const road = roadDistance(x, z);
  if (road < 9) {
    const blurred = (settledHeight(x + 4, z) + settledHeight(x - 4, z) + settledHeight(x, z + 4) + settledHeight(x, z - 4)) / 4;
    return THREE.MathUtils.lerp(Math.min(h, blurred), h, smoothstep(3, 9, road));
  }
  return h;
}

// ---------------------------------------------------------------- stream
/**
 * A stream springs from the western hills, crosses the road under a wooden
 * bridge and ends in a pond in the low ground south-west of the bandit camp.
 */
const STREAM_PATH: THREE.Vector2[] = [
  new THREE.Vector2(-166, -44),
  new THREE.Vector2(-140, -48),
  new THREE.Vector2(-95, -40),
  new THREE.Vector2(-55, -47),
  new THREE.Vector2(-20, -54),
  new THREE.Vector2(4, -50),
  new THREE.Vector2(40, -62),
  new THREE.Vector2(70, -55),
];
export const POND_CENTER = new THREE.Vector2(84, -55);
export const POND_RADIUS = 13;
const STREAM_DEPTH = 0.9;
const POND_DEPTH = 1.8;

export interface StreamSample {
  x: number;
  z: number;
  /** Water surface height. */
  level: number;
  /** Half-width of the open water. */
  width: number;
  /** Distance along the stream from the spring. */
  s: number;
}

/** Dense, meandering centreline with a water level that only ever falls. */
export const STREAM: StreamSample[] = (() => {
  const raw: THREE.Vector2[] = [];
  for (let i = 0; i < STREAM_PATH.length - 1; i++) {
    const a = STREAM_PATH[i], b = STREAM_PATH[i + 1];
    const n = Math.ceil(a.distanceTo(b) / 3);
    for (let k = 0; k < n; k++) raw.push(a.clone().lerp(b, k / n));
  }
  raw.push(STREAM_PATH[STREAM_PATH.length - 1].clone(), POND_CENTER.clone());
  const out: StreamSample[] = [];
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) s += raw[i].distanceTo(raw[i - 1]);
    // Sideways meander that fades out at the bridge and the pond.
    const prev = raw[Math.max(0, i - 1)], next = raw[Math.min(raw.length - 1, i + 1)];
    const side = new THREE.Vector2(-(next.y - prev.y), next.x - prev.x).normalize();
    const bridgeFade = smoothstep(4, 24, Math.hypot(raw[i].x - 4, raw[i].y + 50));
    const endFade = 1 - smoothstep(0.85, 1, i / (raw.length - 1));
    const wiggle = (fbm(s * 0.025, 3.7, 2, 61) - 0.5) * 14 * bridgeFade * endFade;
    const p = raw[i].clone().addScaledVector(side, wiggle);
    out.push({ x: p.x, z: p.y, level: 0, width: 1.4 + 1.6 * (i / raw.length) + fbm(s * 0.05, 9.1, 2, 67) * 0.8, s });
  }
  // Water level: running minimum of the land below the bed, then smoothed so it
  // never climbs downstream.
  let low = Infinity;
  for (const p of out) {
    low = Math.min(low, landHeight(p.x, p.z) - 0.55);
    p.level = low;
  }
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 1; i < out.length - 1; i++) out[i].level = Math.min(out[i - 1].level, (out[i - 1].level + out[i].level + out[i + 1].level) / 3);
  }
  return out;
})();
export const POND_LEVEL = STREAM[STREAM.length - 1].level;

/** Nearest point on the stream: distance, water level and half-width there. */
export function streamQuery(x: number, z: number): { dist: number; level: number; width: number; s: number; x: number; z: number } {
  let best = Infinity, level = 0, width = 0, s = 0, px = 0, pz = 0;
  for (let i = 0; i < STREAM.length - 1; i++) {
    const a = STREAM[i], b = STREAM[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz)));
    const d = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
    if (d < best) {
      best = d;
      level = a.level + (b.level - a.level) * t;
      width = a.width + (b.width - a.width) * t;
      s = a.s + (b.s - a.s) * t;
      px = a.x + abx * t;
      pz = a.z + abz * t;
    }
  }
  return { dist: best, level, width, s, x: px, z: pz };
}

/** Distance to open water (stream or pond edge), negative inside the pond. */
export function waterDistance(x: number, z: number): number {
  if (z > -5 || z < -100) return Infinity;
  const q = streamQuery(x, z);
  return Math.min(q.dist - q.width, Math.hypot(x - POND_CENTER.x, z - POND_CENTER.y) - POND_RADIUS);
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

export function heightAt(x: number, z: number): number {
  const h = landHeight(x, z);
  // Everything the stream touches lies between z = -5 and -100.
  if (z > -5 || z < -100) return h;
  const q = streamQuery(x, z);
  const bed = (d: number, w: number, level: number, depth: number) =>
    level - depth * Math.max(0, 1 - (d / w) ** 2) + Math.max(0, d - w) * 0.45 + 0.25;
  let carve = bed(q.dist, q.width, q.level, STREAM_DEPTH);
  const dp = Math.hypot(x - POND_CENTER.x, z - POND_CENTER.y);
  carve = Math.min(carve, bed(dp, POND_RADIUS, POND_LEVEL, POND_DEPTH));
  return smin(h, carve, 1.2);
}

// ---------------------------------------------------------------- bridge
/** Wooden footbridge where the road crosses the stream. */
export const BRIDGE = (() => {
  // Road segment (10,-35) → (-5,-70) crosses the stream near (4, -50).
  const dir = new THREE.Vector2(-15, -35).normalize();
  const centre = new THREE.Vector2(10, -35).addScaledVector(dir, (-50 + 35) / dir.y);
  const half = 7.5;
  const a = centre.clone().addScaledVector(dir, -half);
  const b = centre.clone().addScaledVector(dir, half);
  return { centre, dir, half, width: 3.4, endA: landHeight(a.x, a.y), endB: landHeight(b.x, b.y), yaw: Math.atan2(dir.x, dir.y) };
})();

/** Bridge deck height at (x, z), or -Infinity off the bridge. */
export function bridgeDeck(x: number, z: number): number {
  const rx = x - BRIDGE.centre.x, rz = z - BRIDGE.centre.y;
  const along = rx * BRIDGE.dir.x + rz * BRIDGE.dir.y;
  const across = rx * BRIDGE.dir.y - rz * BRIDGE.dir.x;
  if (Math.abs(along) > BRIDGE.half || Math.abs(across) > BRIDGE.width / 2) return -Infinity;
  const t = along / BRIDGE.half;
  return THREE.MathUtils.lerp(BRIDGE.endA, BRIDGE.endB, (t + 1) / 2) + 0.35 * (1 - t * t) + 0.12;
}

/** Walkable height: terrain, or the bridge deck where it is higher. */
/** Two-step octagonal dais in the ruins (boss arena); its top is walkable. */
export const DAIS = { x: RUINS_CENTER.x, z: RUINS_CENTER.y - 6, steps: [[5.45, 0.35], [4.55, 0.75]] as const };
let daisBase: number | undefined;
export function daisTop(x: number, z: number): number {
  const d = Math.hypot(x - DAIS.x, z - DAIS.z);
  if (d > DAIS.steps[0][0]) return -Infinity;
  daisBase ??= heightAt(DAIS.x, DAIS.z);
  return daisBase + (d > DAIS.steps[1][0] ? DAIS.steps[0][1] : DAIS.steps[1][1]);
}
export function groundAt(x: number, z: number): number {
  return Math.max(heightAt(x, z), bridgeDeck(x, z), daisTop(x, z));
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
      // Wet, muddy banks.
      (1 - smoothstep(0.5, 3.5, waterDistance(x, z))) * 0.9,
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
