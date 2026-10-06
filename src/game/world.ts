import * as THREE from 'three/webgpu';
import type { QualitySettings } from '../engine/quality';
import { ColliderWorld } from './colliders';
import { rng } from './noise';
import {
  createTerrain, heightAt, normalAt, roadDistance, PLAY_HALF,
  VILLAGE_CENTER, VILLAGE_RADIUS, RUINS_CENTER, RUINS_RADIUS,
} from './terrain';

export const SUN_DIRECTION = new THREE.Vector3(-0.45, 0.75, 0.35).normalize();
const SKY_ZENITH = new THREE.Color(0x4a78b5);
const SKY_HORIZON = new THREE.Color(0xc9d6df);
const FOG_COLOR = new THREE.Color(0xb7c4cc);

export interface World {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  colliders: ColliderWorld;
  /** Meshes the camera must not clip through. */
  cameraBlockers: THREE.Object3D[];
  terrain: THREE.Mesh;
  /** Keeps the sky dome and sun shadow frustum centred on the player. */
  follow(target: THREE.Vector3): void;
}

export function createWorld(quality: QualitySettings, cameraFar: number): World {
  const scene = new THREE.Scene();
  scene.background = FOG_COLOR.clone();
  scene.fog = new THREE.Fog(FOG_COLOR, quality.fogNear, quality.fogFar);

  const sky = createSkyDome(cameraFar * 0.9);
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4030, 1.1);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(quality.shadowMapSize);
  const S = quality.tier === 'low' ? 22 : 34;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 160 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const terrain = createTerrain(quality.terrainSegments);
  scene.add(terrain);

  const colliders = new ColliderWorld();
  const cameraBlockers: THREE.Object3D[] = [];

  buildVillage(scene, colliders, cameraBlockers);
  buildRuins(scene, colliders, cameraBlockers);
  buildForest(scene, colliders, cameraBlockers, quality.vegetationDensity);

  return {
    scene, sun, colliders, cameraBlockers, terrain,
    follow(target) {
      sky.position.copy(target);
      sun.position.copy(target).addScaledVector(SUN_DIRECTION, 80);
      sun.target.position.copy(target);
    },
  };
}

function createSkyDome(radius: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 32, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    const up = Math.max(0, dir.y);
    c.copy(SKY_HORIZON).lerp(SKY_ZENITH, Math.pow(up, 0.55));
    // Warm glow toward the sun.
    const sunAmount = Math.pow(Math.max(0, dir.dot(SUN_DIRECTION)), 8);
    c.lerp(new THREE.Color(0xfff0d0), sunAmount * 0.6);
    if (dir.y < 0) c.copy(FOG_COLOR);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------- materials
const plaster = new THREE.MeshStandardMaterial({ color: 0xd8cbb0, roughness: 0.92 });
const timber = new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.85 });
const thatch = new THREE.MeshStandardMaterial({ color: 0x8a6d3e, roughness: 1 });
const stone = new THREE.MeshStandardMaterial({ color: 0x8d877c, roughness: 0.9 });
const mossStone = new THREE.MeshStandardMaterial({ color: 0x6f7560, roughness: 0.95 });
const bark = new THREE.MeshStandardMaterial({ color: 0x4b3a2a, roughness: 0.95 });
const pineLeaves = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
const broadLeaves = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
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

// ---------------------------------------------------------------- forest
function buildForest(scene: THREE.Scene, colliders: ColliderWorld, blockers: THREE.Object3D[], density: number): void {
  const rand = rng(1234);
  const PINES = Math.round(900 * density);
  const BROADS = Math.round(450 * density);
  const ROCKS = Math.round(260 * density);

  const canPlace = (x: number, z: number, clearRoad: number) => {
    if (Math.hypot(x - VILLAGE_CENTER.x, z - VILLAGE_CENTER.y) < VILLAGE_RADIUS) return false;
    if (Math.hypot(x - RUINS_CENTER.x, z - RUINS_CENTER.y) < RUINS_RADIUS - 6) return false;
    if (roadDistance(x, z) < clearRoad) return false;
    return true;
  };
  const randomSpot = (clearRoad: number, extent = PLAY_HALF + 25): [number, number] | null => {
    for (let tries = 0; tries < 20; tries++) {
      const x = (rand() * 2 - 1) * extent;
      const z = (rand() * 2 - 1) * extent;
      if (canPlace(x, z, clearRoad)) return [x, z];
    }
    return null;
  };

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);

  // Pines: trunk + three stacked cones merged per tier into one instanced mesh each.
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.32, 4, 7);
  trunkGeo.translate(0, 2, 0);
  const coneGeos = [0, 1, 2].map((i) => {
    const g = new THREE.ConeGeometry(2.4 - i * 0.65, 3.4 - i * 0.4, 9);
    g.translate(0, 3 + i * 1.9, 0);
    return g;
  });
  const pineTrunks = new THREE.InstancedMesh(trunkGeo, bark, PINES);
  const pineCones = coneGeos.map((g) => new THREE.InstancedMesh(g, pineLeaves, PINES));

  let n = 0;
  for (let i = 0; i < PINES; i++) {
    const spot = randomSpot(6);
    if (!spot) continue;
    const [x, z] = spot;
    const scale = 0.8 + rand() * 0.9;
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    s.setScalar(scale);
    p.set(x, heightAt(x, z) - 0.2, z);
    m.compose(p, q, s);
    pineTrunks.setMatrixAt(n, m);
    color.setHSL(0.27 + rand() * 0.06, 0.35 + rand() * 0.2, 0.16 + rand() * 0.08);
    pineCones.forEach((c) => {
      c.setMatrixAt(n, m);
      c.setColorAt(n, color);
    });
    if (Math.abs(x) < PLAY_HALF + 5 && Math.abs(z) < PLAY_HALF + 5) colliders.add({ kind: 'circle', x, z, r: 0.35 * scale });
    n++;
  }
  for (const im of [pineTrunks, ...pineCones]) {
    im.count = n;
    im.castShadow = true;
    im.receiveShadow = true;
    scene.add(im);
  }

  // Broadleaf trees: trunk + lumpy icosahedron crown.
  const broadTrunk = new THREE.CylinderGeometry(0.22, 0.4, 3.5, 7);
  broadTrunk.translate(0, 1.75, 0);
  const crownGeo = new THREE.IcosahedronGeometry(2.6, 1);
  jitter(crownGeo, 0.45, rand);
  crownGeo.scale(1, 0.85, 1);
  crownGeo.translate(0, 5, 0);
  const broadTrunks = new THREE.InstancedMesh(broadTrunk, bark, BROADS);
  const crowns = new THREE.InstancedMesh(crownGeo, broadLeaves, BROADS);
  n = 0;
  for (let i = 0; i < BROADS; i++) {
    const spot = randomSpot(7);
    if (!spot) continue;
    const [x, z] = spot;
    const scale = 0.8 + rand() * 0.6;
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    s.setScalar(scale);
    p.set(x, heightAt(x, z) - 0.2, z);
    m.compose(p, q, s);
    broadTrunks.setMatrixAt(n, m);
    crowns.setMatrixAt(n, m);
    color.setHSL(0.2 + rand() * 0.08, 0.4 + rand() * 0.2, 0.2 + rand() * 0.1);
    crowns.setColorAt(n, color);
    if (Math.abs(x) < PLAY_HALF + 5 && Math.abs(z) < PLAY_HALF + 5) colliders.add({ kind: 'circle', x, z, r: 0.45 * scale });
    n++;
  }
  for (const im of [broadTrunks, crowns]) {
    im.count = n;
    im.castShadow = true;
    im.receiveShadow = true;
    scene.add(im);
  }

  // Rocks — the large ones block movement and the camera.
  const rockGeo = new THREE.DodecahedronGeometry(1, 1);
  jitter(rockGeo, 0.25, rand);
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
  const normal = new THREE.Vector3();
  n = 0;
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
