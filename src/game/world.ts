import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import type { QualitySettings } from '../engine/quality';
import { ColliderWorld } from './colliders';
import { rng } from './noise';
import { SUN_DIRECTION, type Atmosphere } from './sky';
import { createWater } from './water';
import {
  createTerrain, heightAt, normalAt, roadDistance, waterDistance, bridgeDeck, BRIDGE, PLAY_HALF,
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
  /** Keeps the sky dome and sun shadow centred on the player and blends the ruins' mist. */
  follow(target: THREE.Vector3, dt: number): void;
}

export function createWorld(quality: QualitySettings, terrainMaterial: THREE.Material, atmosphere: Atmosphere, fogNode: THREE.Node): World {
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

  buildVillage(scene, colliders, cameraBlockers);
  buildRuins(scene, colliders, cameraBlockers);
  buildCamp(scene, colliders, cameraBlockers);
  buildRocks(scene, colliders, cameraBlockers, quality.vegetationDensity);
  buildBridge(scene, colliders);
  scene.add(createWater());

  let mist = 0;
  return {
    scene, sun, colliders, cameraBlockers, terrain,
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

// ---------------------------------------------------------------- materials
const plaster = new THREE.MeshStandardMaterial({ color: 0xd8cbb0, roughness: 0.92 });
const timber = new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.85 });
const thatch = new THREE.MeshStandardMaterial({ color: 0x8a6d3e, roughness: 1 });
const stone = new THREE.MeshStandardMaterial({ color: 0x8d877c, roughness: 0.9 });
const mossStone = new THREE.MeshStandardMaterial({ color: 0x6f7560, roughness: 0.95 });
const bark = new THREE.MeshStandardMaterial({ color: 0x4b3a2a, roughness: 0.95 });
const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true });

function place(obj: THREE.Object3D, x: number, z: number, rotY = 0, sink = 0): THREE.Object3D {
  obj.position.set(x, heightAt(x, z) - sink, z);
  obj.rotation.y = rotY;
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return obj;
}

// ---------------------------------------------------------------- village
function makeHouse(w: number, d: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const foundation = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.8, d + 0.3), stone);
  foundation.position.y = 0.1;
  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), plaster);
  walls.position.y = h / 2 + 0.5;
  g.add(foundation, walls);
  // Timber frame: corner posts + a mid beam.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, h, 0.25), timber);
      post.position.set((sx * w) / 2, h / 2 + 0.5, (sz * d) / 2);
      g.add(post);
    }
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.2, d + 0.1), timber);
  beam.position.y = h * 0.55 + 0.5;
  g.add(beam);
  // Gable roof: triangular prism along the house's depth.
  const roofH = w * 0.45;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 - 0.5, 0);
  shape.lineTo(0, roofH);
  shape.lineTo(w / 2 + 0.5, 0);
  shape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: d + 1, bevelEnabled: false });
  roofGeo.translate(0, 0, -(d + 1) / 2);
  const roof = new THREE.Mesh(roofGeo, thatch);
  roof.position.y = h + 0.5;
  g.add(roof);
  // Door and window.
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2, 0.1), timber);
  door.position.set(0, 1.5, d / 2 + 0.03);
  g.add(door);
  for (const sx of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.1), timber);
    win.position.set((sx * w) / 3.2, h * 0.75, d / 2 + 0.03);
    g.add(win);
  }
  return g;
}

function buildVillage(scene: THREE.Scene, colliders: ColliderWorld, blockers: THREE.Object3D[]): void {
  const { x: vx, y: vz } = VILLAGE_CENTER;
  // [offsetX, offsetZ, width, depth, height] — houses face the square.
  const houses: [number, number, number, number, number][] = [
    [-16, -6, 7, 6, 3.4],
    [17, -4, 6, 5.5, 3.2],
    [-18, 14, 6, 6, 3.2],
    [16, 16, 7.5, 6.5, 3.6],
    [0, 26, 10, 7, 4.2], // village chief
    [-30, 2, 5.5, 5, 3],
    [31, 4, 6, 5, 3],
  ];
  for (const [ox, oz, w, d, h] of houses) {
    const x = vx + ox;
    const z = vz + oz;
    const rot = Math.atan2(vx - x, vz - z);
    const house = makeHouse(w, d, h);
    place(house, x, z, rot, 0.3);
    scene.add(house);
    blockers.push(house);
    colliders.add({ kind: 'box', x, z, hw: w / 2 + 0.2, hd: d / 2 + 0.2, rot });
  }

  // Central well.
  const well = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.4, 1, 16, 1, true), stone.clone());
  ring.position.y = 0.5;
  ring.material.side = THREE.DoubleSide;
  const water = new THREE.Mesh(new THREE.CircleGeometry(1.2, 16), new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.1 }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.3;
  well.add(ring, water);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.4, 0.2), timber);
    post.position.set(sx * 1.2, 1.2, 0);
    well.add(post);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(3, 0.15, 1.4), thatch);
  top.position.y = 2.45;
  well.add(top);
  place(well, vx, vz);
  scene.add(well);
  colliders.add({ kind: 'circle', x: vx, z: vz, r: 1.5 });

  // Fence posts along part of the perimeter.
  const postGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.2, 6);
  const fence = new THREE.InstancedMesh(postGeo, timber, 80);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let a = 0; a < Math.PI * 2 && n < 80; a += 0.075) {
    const x = vx + Math.cos(a) * (VILLAGE_RADIUS - 6);
    const z = vz + Math.sin(a) * (VILLAGE_RADIUS - 6);
    if (roadDistance(x, z) < 5) continue;
    m.makeTranslation(x, heightAt(x, z) + 0.5, z);
    fence.setMatrixAt(n++, m);
  }
  fence.count = n;
  fence.castShadow = true;
  scene.add(fence);
}

// ---------------------------------------------------------------- ruins
function buildRuins(scene: THREE.Scene, colliders: ColliderWorld, blockers: THREE.Object3D[]): void {
  const { x: rx, y: rz } = RUINS_CENTER;
  const rand = rng(77);

  // Ring of columns, some broken.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = rx + Math.cos(a) * 14;
    const z = rz + Math.sin(a) * 14;
    const broken = rand() < 0.45;
    const h = broken ? 1.5 + rand() * 3 : 7;
    const col = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, h, 12), rand() < 0.5 ? stone : mossStone);
    shaft.position.y = h / 2;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 1.8), stone);
    base.position.y = 0.25;
    col.add(shaft, base);
    if (!broken) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 1.7), stone);
      cap.position.y = h;
      col.add(cap);
    } else {
      // Fallen drum lying nearby.
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 2, 12), mossStone);
      drum.rotation.z = Math.PI / 2;
      drum.rotation.y = rand() * Math.PI;
      drum.position.set(Math.cos(a) * 2.5, 0.5, Math.sin(a) * 2.5);
      col.add(drum);
    }
    place(col, x, z, 0, 0.2);
    scene.add(col);
    blockers.push(col);
    colliders.add({ kind: 'circle', x, z, r: 1 });
  }

  // Crumbling outer walls with a gate gap facing the road (south).
  const walls: [number, number, number, number, number][] = [
    // [offsetX, offsetZ, length, height, rotation]
    [-22, -8, 16, 4.5, Math.PI / 2],
    [22, -6, 20, 3.2, Math.PI / 2],
    [0, -26, 30, 5, 0],
    [-15, 20, 12, 2.6, 0],
    [16, 20, 10, 3.6, 0],
  ];
  for (const [ox, oz, len, h, rot] of walls) {
    const x = rx + ox;
    const z = rz + oz;
    const wall = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, h, 1.2), stone);
    body.position.y = h / 2;
    wall.add(body);
    // Jagged top blocks.
    for (let b = -len / 2 + 1; b < len / 2; b += 2) {
      if (rand() < 0.4) continue;
      const block = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6 + rand(), 1.3), rand() < 0.5 ? stone : mossStone);
      block.position.set(b, h + 0.3, 0);
      wall.add(block);
    }
    place(wall, x, z, rot, 0.4);
    scene.add(wall);
    blockers.push(wall);
    colliders.add({ kind: 'box', x, z, hw: len / 2, hd: 0.7, rot });
  }

  // Altar dais in the centre — the boss arena later.
  const dais = new THREE.Mesh(new THREE.CylinderGeometry(5, 5.6, 0.8, 24), stone);
  dais.position.y = 0.2;
  const daisGroup = new THREE.Group().add(dais);
  const altar = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 1.2), mossStone);
  altar.position.y = 1.2;
  daisGroup.add(altar);
  place(daisGroup, rx, rz - 6);
  scene.add(daisGroup);
  colliders.add({ kind: 'box', x: rx, z: rz - 6, hw: 1.2, hd: 0.6, rot: 0 });
}

// ---------------------------------------------------------------- bandit camp
function buildCamp(scene: THREE.Scene, colliders: ColliderWorld, blockers: THREE.Object3D[]): void {
  const { x: cx, y: cz } = BANDIT_CAMP;
  const canvas = new THREE.MeshStandardMaterial({ color: 0x8b7b5e, roughness: 0.95, side: THREE.DoubleSide });
  const tents: [number, number, number][] = [[-7, 6, 0.6], [7, 7, -0.4], [0, -9, 3.1], [-9, -4, 1.8]];
  for (const [ox, oz, rot] of tents) {
    const tent = new THREE.Group();
    const cloth = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 2.4, 2.6, 3, 1, true), canvas);
    cloth.rotation.z = Math.PI / 2;
    cloth.scale.set(1, 1.6, 1);
    cloth.position.y = 1.15;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6), timber);
    pole.position.y = 1.3;
    tent.add(cloth, pole);
    const x = cx + ox;
    const z = cz + oz;
    place(tent, x, z, rot, 0.1);
    scene.add(tent);
    blockers.push(tent);
    colliders.add({ kind: 'box', x, z, hw: 1.8, hd: 2.2, rot });
  }
  // Campfire: stone ring, logs and an emissive ember core with a warm point light.
  const fire = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), stone);
    rock.position.set(Math.cos(a) * 0.75, 0.1, Math.sin(a) * 0.75);
    fire.add(rock);
  }
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1, 6), bark);
    log.rotation.set(Math.PI / 2.6, (i / 3) * Math.PI * 2, 0);
    log.position.y = 0.25;
    fire.add(log);
  }
  const embers = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), new THREE.MeshStandardMaterial({ color: 0x220800, emissive: 0xff6a1a, emissiveIntensity: 4 }));
  embers.position.y = 0.25;
  embers.scale.y = 0.6;
  fire.add(embers);
  const light = new THREE.PointLight(0xff8a3a, 30, 14, 2);
  light.position.y = 1;
  fire.add(light);
  place(fire, cx, cz);
  embers.castShadow = false;
  scene.add(fire);
  colliders.add({ kind: 'circle', x: cx, z: cz, r: 0.9 });
  // Crates and a log bench.
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x6e5134, roughness: 0.85 });
  const crates: [number, number][] = [[3, 3], [3.8, 3.6], [-3, -2.5]];
  for (const [ox, oz] of crates) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), crateMat);
    crate.position.y = 0.45;
    const g = new THREE.Group().add(crate);
    place(g, cx + ox, cz + oz, Math.random());
    scene.add(g);
    colliders.add({ kind: 'circle', x: cx + ox, z: cz + oz, r: 0.6 });
  }
}

// ---------------------------------------------------------------- bridge
/** Timber footbridge carrying the road over the stream (walkable via groundAt). */
function buildBridge(scene: THREE.Scene, colliders: ColliderWorld): void {
  const { centre, dir, half, width, yaw } = BRIDGE;
  const rand = rng(404);
  const planks = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 });
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
    deck.setColorAt(i, c.setHSL(0.07 + rand() * 0.02, 0.32, 0.2 + rand() * 0.08));
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

function buildRocks(scene: THREE.Scene, colliders: ColliderWorld, blockers: THREE.Object3D[], density: number): void {
  const rand = rng(1234);
  const ROCKS = Math.round(260 * density);
  const randomSpot = (clearRoad: number, extent = PLAY_HALF + 25): [number, number] | null => {
    for (let tries = 0; tries < 20; tries++) {
      const x = (rand() * 2 - 1) * extent;
      const z = (rand() * 2 - 1) * extent;
      if (canGrow(x, z, clearRoad)) return [x, z];
    }
    return null;
  };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  let n = 0;

  // Rocks — the large ones block movement and the camera.
  const rockGeo = new THREE.DodecahedronGeometry(1, 1);
  jitter(rockGeo, 0.25, rand);
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
  const normal = new THREE.Vector3();
  for (let i = 0; i < ROCKS; i++) {
    const spot = randomSpot(4);
    if (!spot) continue;
    const [x, z] = spot;
    const size = 0.4 + Math.pow(rand(), 3) * 2.6;
    normalAt(x, z, normal);
    q.setFromUnitVectors(up, normal).multiply(new THREE.Quaternion().setFromAxisAngle(up, rand() * Math.PI * 2));
    s.set(size * (1 + rand() * 0.5), size * (0.6 + rand() * 0.3), size * (1 + rand() * 0.4));
    p.set(x, heightAt(x, z) - size * 0.25, z);
    m.compose(p, q, s);
    rocks.setMatrixAt(n, m);
    color.setHSL(0.1, 0.05 + rand() * 0.06, 0.32 + rand() * 0.12);
    rocks.setColorAt(n, color);
    if (size > 0.9) colliders.add({ kind: 'circle', x, z, r: size * 0.9 });
    n++;
  }
  rocks.count = n;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);
  blockers.push(rocks);
}

function jitter(geo: THREE.BufferGeometry, amount: number, rand: () => number): void {
  // Move coincident vertices together so the surface stays closed.
  const pos = geo.attributes.position;
  const offsets = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let k = offsets.get(key);
    if (k === undefined) offsets.set(key, (k = 1 + (rand() * 2 - 1) * amount));
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
}
