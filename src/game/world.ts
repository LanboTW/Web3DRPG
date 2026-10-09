import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import type { QualitySettings } from '../engine/quality';
import { ColliderWorld } from './colliders';
import { rng } from './noise';
import { SUN_DIRECTION, type Atmosphere } from './sky';
import { createWater } from './water';
import type { PropLibrary } from './props';
import {
  createTerrain, heightAt, normalAt, roadDistance, waterDistance, bridgeDeck, BRIDGE, DAIS, PLAY_HALF,
  VILLAGE_CENTER, VILLAGE_RADIUS, RUINS_CENTER, RUINS_RADIUS, BANDIT_CAMP, CAMP_RADIUS,
} from './terrain';

const SUN_GOLD = new THREE.Color(0xffc690);
const SUN_COLD = new THREE.Color(0xb4c8e6);
const ENV_INTENSITY = 1.5;

export interface World {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  colliders: ColliderWorld;
  /** Meshes the camera must not clip through. */
  cameraBlockers: THREE.Object3D[];
  terrain: THREE.Mesh;
  chests: Chest[];
  /** Keeps the sky dome and sun shadow centred on the player and blends the ruins' mist. */
  follow(target: THREE.Vector3, dt: number): void;
}

/** A lootable treasure chest. */
export interface Chest {
  id: string;
  object: THREE.Object3D;
  position: THREE.Vector3;
  loot: { gold: number; items: Record<string, number> };
}

export function createWorld(quality: QualitySettings, terrainMaterial: THREE.Material, atmosphere: Atmosphere, fogNode: THREE.Node, props: PropLibrary): World {
  const scene = new THREE.Scene();
  scene.fogNode = fogNode;
  scene.environment = atmosphere.environment;
  scene.environmentIntensity = ENV_INTENSITY;
  const sky = atmosphere.dome;
  scene.add(sky);

  const sun = new THREE.DirectionalLight(SUN_GOLD, 3.4);
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  if (quality.cascades > 0) {
    // The cascades pick up the camera from the first render that uses them.
    sun.shadow.mapSize.setScalar(2048);
    Object.assign(sun.shadow.camera, { near: 1, far: 400 });
    const csm = new CSMShadowNode(sun, { cascades: quality.cascades, maxFar: quality.fogFar * 0.8, mode: 'practical', lightMargin: 60 });
    csm.fade = true;
    sun.shadow.shadowNode = csm;
  } else {
    sun.shadow.mapSize.setScalar(quality.shadowMapSize);
    const S = 22;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 160 });
  }
  scene.add(sun, sun.target);

  const terrain = createTerrain(quality.terrainSegments, terrainMaterial);
  scene.add(terrain);

  const colliders = new ColliderWorld();
  const cameraBlockers: THREE.Object3D[] = [];
  const chests: Chest[] = [];

  buildVillage(scene, props, colliders, cameraBlockers, chests);
  buildRuins(scene, props, colliders, cameraBlockers);
  buildCamp(scene, props, colliders, cameraBlockers, chests);
  buildRocks(scene, props, colliders, cameraBlockers, quality.vegetationDensity);
  buildBridge(scene, props, colliders);
  scene.add(createWater());

  let mist = 0;
  return {
    scene, sun, colliders, cameraBlockers, terrain, chests,
    follow(target, dt) {
      sky.position.copy(target);
      sun.position.copy(target).addScaledVector(SUN_DIRECTION, 100);
      sun.target.position.copy(target);
      // Cold mist hangs over the knight's ruins; ease in/out as the player walks.
      const d = Math.hypot(target.x - RUINS_CENTER.x, target.z - RUINS_CENTER.y);
      const goal = 1 - THREE.MathUtils.smoothstep(d, RUINS_RADIUS - 6, RUINS_RADIUS + 45);
      mist += (goal - mist) * Math.min(1, dt * 1.5);
      atmosphere.mist.value = mist;
      sun.color.copy(SUN_GOLD).lerp(SUN_COLD, mist);
      sun.intensity = THREE.MathUtils.lerp(3.4, 1.3, mist);
      scene.environmentIntensity = THREE.MathUtils.lerp(ENV_INTENSITY, ENV_INTENSITY * 0.7, mist);
    },
  };
}

// ---------------------------------------------------------------- placement
const UP = new THREE.Vector3(0, 1, 0);

/** Lowest ground under a rotated footprint, so nothing floats on a slope. */
function footprintGround(x: number, z: number, hw: number, hd: number, rot: number): number {
  let h = heightAt(x, z);
  const c = Math.cos(rot), s = Math.sin(rot);
  for (const [lx, lz] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) h = Math.min(h, heightAt(x + lx * c + lz * s, z - lx * s + lz * c));
  return h;
}

function placeProp(scene: THREE.Scene, props: PropLibrary, name: string, x: number, z: number, rot = 0, opts: { sink?: number; scale?: number | [number, number, number]; y?: number; shadows?: boolean } = {}): THREE.Object3D {
  const obj = props.clone(name, opts.shadows ?? true);
  const size = props.size(name);
  const scale = opts.scale ?? 1;
  if (typeof scale === 'number') obj.scale.setScalar(scale);
  else obj.scale.fromArray(scale);
  const y = opts.y ?? footprintGround(x, z, (size.x * obj.scale.x) / 2, (size.z * obj.scale.z) / 2, rot);
  obj.position.set(x, y - (opts.sink ?? 0), z);
  obj.rotation.y = rot;
  scene.add(obj);
  return obj;
}

/** World position of a point given in an object's local frame (x right, z front). */
function local(x: number, z: number, rot: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [x + lx * c + lz * s, z - lx * s + lz * c];
}

// ---------------------------------------------------------------- village
function buildVillage(scene: THREE.Scene, props: PropLibrary, colliders: ColliderWorld, blockers: THREE.Object3D[], chests: Chest[]): void {
  const { x: vx, y: vz } = VILLAGE_CENTER;
  const rand = rng(31);
  // [offsetX, offsetZ, asset] — houses face the square.
  const houses: [number, number, string][] = [
    [-16, -6, 'house_a'],
    [17, -4, 'house_b'],
    [-18, 14, 'house_d'],
    [16, 16, 'house_c'],
    [0, 26, 'house_chief'],
    [-30, 2, 'house_d'],
    [31, 4, 'house_b'],
  ];
  const clutter = ['barrel', 'crate_small', 'crate_long', 'bucket'];
  houses.forEach(([ox, oz, asset], i) => {
    const x = vx + ox;
    const z = vz + oz;
    const rot = Math.atan2(vx - x, vz - z);
    const size = props.size(asset);
    // The eaves overhang the walls by ~0.75 m on each side.
    const w = size.x - 1.5, d = size.z - 1.4;
    const house = placeProp(scene, props, asset, x, z, rot, { sink: 0.15 });
    blockers.push(house);
    colliders.add({ kind: 'box', x, z, hw: w / 2, hd: d / 2, rot });
    // A little clutter beside the front corners.
    for (const side of [-1, 1]) {
      if (rand() < 0.25) continue;
      const name = clutter[Math.floor(rand() * clutter.length)];
      const [px, pz] = local(x, z, rot, side * (w / 2 + 0.9), d / 2 - 0.6 - rand() * 1.5);
      placeProp(scene, props, name, px, pz, rot + (rand() - 0.5) * 1.2);
      colliders.add({ kind: 'circle', x: px, z: pz, r: 0.5 });
      if (name === 'barrel' && rand() < 0.5) placeProp(scene, props, 'lantern', px, pz, rand() * 6, { y: heightAt(px, pz) + 0.86 });
    }
    if (i === 2) {
      const [px, pz] = local(x, z, rot, -1.8, d / 2 + 1.1);
      placeProp(scene, props, 'spinning_wheel', px, pz, rot + 2.2);
      const [sx, sz] = local(x, z, rot, -2.6, d / 2 + 0.9);
      placeProp(scene, props, 'stool', sx, sz, rot + 0.4, { scale: 1.6 });
    }
  });

  // Merchant's goods and the hunter's chopping spot.
  placeProp(scene, props, 'crate_long', vx - 11.2, vz - 6.2, 0.6);
  placeProp(scene, props, 'barrel', vx - 10.2, vz - 7.3, 0);
  placeProp(scene, props, 'barrel', vx - 11.6, vz - 4.6, 0);
  const chest = placeProp(scene, props, 'chest', vx - 12, vz - 2.8, 1.2);
  chests.push({ id: 'village', object: chest, position: chest.position, loot: { gold: 30, items: { potion: 2 } } });
  colliders.add({ kind: 'circle', x: vx - 11, z: vz - 5.5, r: 1.6 });
  colliders.add({ kind: 'circle', x: vx - 12, z: vz - 2.8, r: 0.55 });
  placeProp(scene, props, 'log', vx + 13.5, vz - 10, 0.4, { scale: [1, 1.5, 1.5] });
  placeProp(scene, props, 'log', vx + 13.4, vz - 9.4, 0.5, { scale: [1, 1.5, 1.5], y: heightAt(vx + 13.4, vz - 9.4) + 0.3 });
  const axe = placeProp(scene, props, 'axe', vx + 12.6, vz - 9.4, 1.0, { y: heightAt(vx + 12.6, vz - 9.4) + 0.05 });
  axe.rotation.z = 0.35;
  colliders.add({ kind: 'box', x: vx + 13.5, z: vz - 9.7, hw: 1.5, hd: 0.4, rot: 0.45 });

  // Central well with log benches.
  placeProp(scene, props, 'well', vx, vz);
  colliders.add({ kind: 'circle', x: vx, z: vz, r: 1.5 });
  for (const a of [0.9, 2.6, 4.5]) {
    const bx = vx + Math.cos(a) * 4.2, bz = vz + Math.sin(a) * 4.2;
    placeProp(scene, props, 'log', bx, bz, -a, { scale: [0.7, 1.7, 1.7], y: heightAt(bx, bz) - 0.08 });
  }

  // Rail fence along part of the perimeter.
  const fence: THREE.Matrix4[] = [];
  const R = VILLAGE_RADIUS - 6;
  const step = 3.05 / R;
  for (let a = 0; a < Math.PI * 2; a += step) {
    const x = vx + Math.cos(a + step / 2) * R;
    const z = vz + Math.sin(a + step / 2) * R;
    if (roadDistance(x, z) < 5) continue;
    const rot = -(a + step / 2) + Math.PI / 2;
    fence.push(new THREE.Matrix4().compose(new THREE.Vector3(x, heightAt(x, z) - 0.05, z), new THREE.Quaternion().setFromAxisAngle(UP, rot), new THREE.Vector3(1, 1, 1)));
    // The rail runs along the fence's local X.
    colliders.add({ kind: 'box', x, z, hw: 1.55, hd: 0.15, rot });
  }
  scene.add(props.instanced('fence', fence));
}

// ---------------------------------------------------------------- ruins
function buildRuins(scene: THREE.Scene, props: PropLibrary, colliders: ColliderWorld, blockers: THREE.Object3D[]): void {
  const { x: rx, y: rz } = RUINS_CENTER;
  const rand = rng(77);

  // Ring of columns, some broken with a fallen drum beside them.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = rx + Math.cos(a) * 14;
    const z = rz + Math.sin(a) * 14;
    const broken = rand() < 0.45;
    const col = placeProp(scene, props, broken ? (rand() < 0.5 ? 'column_broken_a' : 'column_broken_b') : 'column', x, z, rand() * 6, { sink: 0.2 });
    blockers.push(col);
    colliders.add({ kind: 'circle', x, z, r: 1 });
    if (broken) {
      const dx = x + Math.cos(a) * 2.6, dz = z + Math.sin(a) * 2.6;
      placeProp(scene, props, 'column_drum', dx, dz, rand() * Math.PI, { sink: 0.25 });
      colliders.add({ kind: 'circle', x: dx, z: dz, r: 0.8 });
    }
  }

  // Crumbling curtain walls; the gate faces the road (south).
  const walls: [string, number, number, number][] = [
    ['ruin_wall_b', -22, -8, Math.PI / 2],
    ['ruin_wall_c', -22, 5, Math.PI / 2],
    ['ruin_wall_a', 22, -6, -Math.PI / 2],
    ['ruin_wall_a', -8, -26, 0],
    ['ruin_wall_c', 6, -26, Math.PI],
    ['ruin_wall_a', -15.5, 20, Math.PI],
    ['ruin_wall_c', 16, 20, 0],
  ];
  for (const [asset, ox, oz, rot] of walls) {
    const x = rx + ox, z = rz + oz;
    const size = props.size(asset);
    blockers.push(placeProp(scene, props, asset, x, z, rot, { sink: 0.5 }));
    colliders.add({ kind: 'box', x, z, hw: size.x / 2, hd: size.z / 2, rot });
  }
  const gx = rx + 1, gz = rz + 20;
  blockers.push(placeProp(scene, props, 'ruin_gate', gx, gz, 0, { sink: 0.4 }));
  for (const side of [-1, 1]) colliders.add({ kind: 'box', x: gx + side * 2.65, z: gz, hw: 1.05, hd: 1.35, rot: 0 });
  blockers.push(placeProp(scene, props, 'ruin_corner', rx - 22, rz - 26, 0, { sink: 0.5 }));
  colliders.add({ kind: 'box', x: rx - 22, z: rz - 26, hw: 2.9, hd: 2.9, rot: 0 });
  blockers.push(placeProp(scene, props, 'ruin_tower', rx + 25, rz - 28, 2.4, { sink: 0.6, scale: 0.7 }));
  colliders.add({ kind: 'circle', x: rx + 25, z: rz - 28, r: 5.4 });

  // Rubble from the fallen masonry.
  const small = ['rock_07', 'rock_08', 'rock_09', 'rock_10', 'rock_12'];
  const rubble = new Map<string, THREE.Matrix4[]>();
  for (let i = 0; i < 46; i++) {
    const a = rand() * Math.PI * 2, r = 9 + rand() * 18;
    const x = rx + Math.cos(a) * r, z = rz + Math.sin(a) * r;
    if (Math.hypot(x - DAIS.x, z - DAIS.z) < 7) continue;
    const name = small[Math.floor(rand() * small.length)];
    const s = 0.25 + rand() * 0.35;
    const list = rubble.get(name) ?? [];
    list.push(new THREE.Matrix4().compose(new THREE.Vector3(x, heightAt(x, z) - 0.05, z), new THREE.Quaternion().setFromAxisAngle(UP, rand() * 6), new THREE.Vector3(s, s, s)));
    rubble.set(name, list);
  }
  for (const [name, list] of rubble) scene.add(props.instanced(name, list, undefined, false));

  // Altar dais in the centre — the boss arena. Its steps are walkable (terrain.groundAt).
  placeProp(scene, props, 'dais', DAIS.x, DAIS.z, 0, { y: heightAt(DAIS.x, DAIS.z) });
  colliders.add({ kind: 'box', x: DAIS.x, z: DAIS.z, hw: 1.3, hd: 0.65, rot: 0 });
}

// ---------------------------------------------------------------- bandit camp
function buildCamp(scene: THREE.Scene, props: PropLibrary, colliders: ColliderWorld, blockers: THREE.Object3D[], chests: Chest[]): void {
  const { x: cx, y: cz } = BANDIT_CAMP;
  const tents: [number, number, string][] = [[-7, 6, 'tent'], [7, 7, 'tent_small'], [0, -9, 'tent'], [-9, -4, 'tent_small']];
  for (const [ox, oz, asset] of tents) {
    const x = cx + ox;
    const z = cz + oz;
    // Open side faces the fire.
    const face = Math.atan2(-ox, -oz);
    blockers.push(placeProp(scene, props, asset, x, z, face, { sink: 0.05 }));
    const big = asset === 'tent';
    colliders.add({ kind: 'box', x, z, hw: big ? 1.6 : 1.25, hd: big ? 1.7 : 1.3, rot: face });
  }
  // Campfire: stone pit, an ember core and a warm point light; logs to sit on.
  placeProp(scene, props, 'fire_pit', cx, cz, 0.3, { sink: 0.05 });
  const embers = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), new THREE.MeshStandardMaterial({ color: 0x220800, emissive: 0xff6a1a, emissiveIntensity: 4 }));
  embers.position.set(cx, heightAt(cx, cz) + 0.12, cz);
  embers.scale.y = 0.6;
  const light = new THREE.PointLight(0xff8a3a, 30, 14, 2);
  light.position.set(cx, heightAt(cx, cz) + 1, cz);
  scene.add(embers, light);
  colliders.add({ kind: 'circle', x: cx, z: cz, r: 0.9 });
  for (const a of [0.4, 2.3, 4.2]) {
    const lx = cx + Math.cos(a) * 2.6, lz = cz + Math.sin(a) * 2.6;
    placeProp(scene, props, 'log', lx, lz, -a + Math.PI / 2, { scale: [0.6, 1.7, 1.7], y: heightAt(lx, lz) - 0.08 });
  }
  // Loot and supplies.
  const goods: [string, number, number, number][] = [
    ['crate_long', 3.4, 3.2, 0.7], ['crate_small', 3.9, 4.6, 0.2], ['barrel', -3.2, -2.6, 0], ['barrel', -3.9, -1.7, 0],
    ['chest', 0.4, -6.3, 3.0], ['barrel', 9.2, 4.4, 0], ['crate_small', -6.4, 2.9, 1.9],
  ];
  for (const [name, ox, oz, rot] of goods) {
    const obj = placeProp(scene, props, name, cx + ox, cz + oz, rot);
    if (name === 'chest') chests.push({ id: 'camp', object: obj, position: obj.position, loot: { gold: 80, items: { potion: 3 } } });
    colliders.add({ kind: 'circle', x: cx + ox, z: cz + oz, r: 0.6 });
  }
  const shield = placeProp(scene, props, 'shield', cx + 3.2, cz + 2.45, 0.7);
  shield.rotation.x = -0.25;
  const axe = placeProp(scene, props, 'axe', cx - 3.6, cz - 3.2, 2.0, { y: heightAt(cx - 3.6, cz - 3.2) + 0.02 });
  axe.rotation.z = 0.3;
}

// ---------------------------------------------------------------- bridge
/** Timber footbridge carrying the road over the stream (walkable via groundAt). */
function buildBridge(scene: THREE.Scene, props: PropLibrary, colliders: ColliderWorld): void {
  const { centre, dir, half, width, yaw } = BRIDGE;
  const rand = rng(404);
  const timber = props.material('timber')!;
  const planks = timber;
  const bridge = new THREE.Group();
  const at = (along: number, across: number) => {
    const x = centre.x + dir.x * along + dir.y * across;
    const z = centre.y + dir.y * along - dir.x * across;
    return { x, z, y: bridgeDeck(x, z) };
  };
  // Local frame: +Z runs along the road, +X across it.
  const local = (along: number, across: number, y: number) => new THREE.Vector3(across, y, along);
  const slope = (along: number) => Math.atan2(at(along + 0.5, 0).y - at(along - 0.5, 0).y, 1);

  // Deck planks with a little irregularity.
  const PITCH = 0.3;
  const count = Math.floor((half * 2) / PITCH);
  const deck = new THREE.InstancedMesh(new THREE.BoxGeometry(width, 0.08, PITCH - 0.03), planks, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const along = -half + (i + 0.5) * PITCH;
    const p = at(along, 0);
    e.set(-slope(along), (rand() - 0.5) * 0.03, (rand() - 0.5) * 0.02);
    m.compose(local(along, (rand() - 0.5) * 0.08, p.y - 0.04), q.setFromEuler(e), new THREE.Vector3(1 + (rand() - 0.5) * 0.06, 1, 1));
    deck.setMatrixAt(i, m);
    const v = 0.75 + rand() * 0.3;
    deck.setColorAt(i, c.setRGB(v, v * 0.95, v * 0.9));
  }
  bridge.add(deck);

  // Stringers under the deck and rails on top, in short segments that follow the arch.
  const SEG = 1.5;
  for (let along = -half; along < half - 0.01; along += SEG) {
    const mid = along + SEG / 2;
    const p = at(mid, 0);
    for (const across of [-width / 2 + 0.25, 0, width / 2 - 0.25]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, SEG + 0.04), timber);
      beam.position.copy(local(mid, across, p.y - 0.21));
      beam.rotation.x = -slope(mid);
      bridge.add(beam);
    }
    for (const across of [-width / 2, width / 2]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, SEG + 0.04), timber);
      rail.position.copy(local(mid, across, p.y + 0.98));
      rail.rotation.x = -slope(mid);
      const lower = rail.clone();
      lower.position.y -= 0.45;
      bridge.add(rail, lower);
    }
  }
  // Posts: rail posts on the deck, and piles from the deck down into the stream bed.
  for (let along = -half; along <= half + 0.01; along += SEG) {
    for (const across of [-width / 2, width / 2]) {
      const p = at(along, across);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.2, 0.16), timber);
      post.position.copy(local(along, across, p.y + 0.5));
      bridge.add(post);
      const ground = heightAt(p.x, p.z);
      if (p.y - ground > 0.5) {
        const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, p.y - ground + 0.6, 8), timber);
        pile.position.copy(local(along, across + Math.sign(across) * 0.12, (p.y + ground - 0.6) / 2));
        bridge.add(pile);
      }
    }
  }
  bridge.position.set(centre.x, 0, centre.y);
  bridge.rotation.y = yaw;
  bridge.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  scene.add(bridge);
  // Rails keep walkers on the deck (and out from under it).
  for (const side of [-1, 1]) {
    const ox = Math.cos(yaw) * side * (width / 2 + 0.05), oz = -Math.sin(yaw) * side * (width / 2 + 0.05);
    colliders.add({ kind: 'box', x: centre.x + ox, z: centre.y + oz, hw: 0.1, hd: half, rot: yaw });
  }
}

// ---------------------------------------------------------------- open land
/** Keeps trees, bushes and rocks off settlements, roads, the stream and the bridge. */
export function canGrow(x: number, z: number, clearance: number): boolean {
  if (Math.hypot(x - VILLAGE_CENTER.x, z - VILLAGE_CENTER.y) < VILLAGE_RADIUS) return false;
  if (Math.hypot(x - RUINS_CENTER.x, z - RUINS_CENTER.y) < RUINS_RADIUS - 6) return false;
  if (roadDistance(x, z) < clearance) return false;
  if (Math.hypot(x - BANDIT_CAMP.x, z - BANDIT_CAMP.y) < CAMP_RADIUS) return false;
  if (waterDistance(x, z) < clearance * 0.5) return false;
  return true;
}

function buildRocks(scene: THREE.Scene, props: PropLibrary, colliders: ColliderWorld, blockers: THREE.Object3D[], density: number): void {
  const rand = rng(1234);
  const ROCKS = Math.round(260 * density);
  const LOGS = Math.round(60 * density);
  const randomSpot = (clearRoad: number, extent = PLAY_HALF + 25): [number, number] | null => {
    for (let tries = 0; tries < 20; tries++) {
      const x = (rand() * 2 - 1) * extent;
      const z = (rand() * 2 - 1) * extent;
      if (canGrow(x, z, clearRoad)) return [x, z];
    }
    return null;
  };
  const big = ['rock_01', 'rock_02', 'rock_03', 'rock_04', 'rock_05', 'rock_06'];
  const all = [...big, 'rock_07', 'rock_08', 'rock_09', 'rock_10', 'rock_11', 'rock_12', 'rock_13'];
  const placed = new Map<string, { m: THREE.Matrix4[]; c: THREE.Color[] }>();
  const add = (name: string, m: THREE.Matrix4, c = new THREE.Color(1, 1, 1)) => {
    const e = placed.get(name) ?? { m: [], c: [] };
    e.m.push(m);
    e.c.push(c);
    placed.set(name, e);
  };
  const normal = new THREE.Vector3();
  const q = new THREE.Quaternion();

  // Rocks — the large ones block movement and the camera.
  for (let i = 0; i < ROCKS; i++) {
    const spot = randomSpot(4);
    if (!spot) continue;
    const [x, z] = spot;
    const size = 0.4 + Math.pow(rand(), 3) * 2.6;
    const pool = size > 1.2 ? big : all;
    const name = pool[Math.floor(rand() * pool.length)];
    const dim = props.size(name);
    const s = (size * 2 * (1 + rand() * 0.3)) / Math.max(dim.x, dim.z);
    normalAt(x, z, normal);
    const yaw = rand() * Math.PI * 2;
    q.setFromUnitVectors(UP, normal.lerp(UP, 0.4).normalize()).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
    const sy = s * (0.8 + rand() * 0.4);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, heightAt(x, z) - dim.y * s * 0.22, z), q, new THREE.Vector3(s, sy, s));
    const v = 0.8 + rand() * 0.25;
    add(name, m, new THREE.Color(v, v * (0.97 + rand() * 0.05), v * 0.94));
    // Knee-high rocks can be stepped over; the rest get a collider slightly inside
    // the visible footprint (a box for elongated rocks, a circle for round ones).
    if (dim.y * (sy - s * 0.22) < 0.5) continue;
    const hw = ((dim.x * s) / 2) * 0.8;
    const hd = ((dim.z * s) / 2) * 0.8;
    if (Math.max(hw, hd) / Math.min(hw, hd) > 1.3) colliders.add({ kind: 'box', x, z, hw, hd, rot: yaw });
    else colliders.add({ kind: 'circle', x, z, r: Math.min(hw, hd) });
  }
  // Fallen trunks in the woods.
  for (let i = 0; i < LOGS; i++) {
    const spot = randomSpot(3);
    if (!spot) continue;
    const [x, z] = spot;
    const yaw = rand() * Math.PI * 2;
    const s = 0.9 + rand() * 0.6;
    // Tilt along the slope by sampling the ground at both ends.
    const dx = Math.cos(yaw) * 1.5 * s, dz = -Math.sin(yaw) * 1.5 * s;
    const tilt = Math.atan2(heightAt(x + dx, z + dz) - heightAt(x - dx, z - dz), 3 * s);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, heightAt(x, z) - 0.06, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, tilt, 'YXZ')), new THREE.Vector3(s, s * 1.3, s * 1.3));
    add('log', m);
  }
  for (const [name, { m, c }] of placed) {
    const g = props.instanced(name, m, c);
    scene.add(g);
    if (name !== 'log') blockers.push(g);
  }
}
