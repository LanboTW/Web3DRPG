import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { ShieldLook, SwordLook } from '../rpg/items';

export interface CharacterModel {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  bones: Map<string, THREE.Bone>;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** Asset URLs are relative to the Vite base so they work on GitHub Pages. */
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

export async function loadCharacter(path: string, onProgress?: (fraction: number) => void): Promise<CharacterModel> {
  const gltf = await loader.loadAsync(assetUrl(path), (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });
  const root = gltf.scene;
  const bones = new Map<string, THREE.Bone>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Skinned bounds don't follow the animation; avoid popping at screen edges.
    mesh.frustumCulled = false;
    fixMaterial(mesh);
  });

  const clips = new Map<string, THREE.AnimationClip>();
  const pelvis = bones.get('pelvis');
  for (const clip of gltf.animations) {
    if (pelvis) stripRootMotion(clip, pelvis);
    clips.set(clip.name, clip);
  }
  return { root, mixer: new THREE.AnimationMixer(root), clips, bones };
}

/**
 * MPFB exports every material as alpha-blended. Only cards like hair, brows
 * and lashes need alpha; everything else is opaque so it sorts and shadows
 * correctly.
 */
function fixMaterial(mesh: THREE.Mesh): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats as THREE.MeshStandardMaterial[]) {
    const id = `${mesh.name} ${m.name}`;
    const alphaCard = /hair|ponytail|braid|bob|short0|eyebrow|eyelash/i.test(id);
    m.transparent = false;
    m.depthWrite = true;
    if (alphaCard) {
      m.alphaTest = 0.5;
      m.alphaToCoverage = true;
      m.side = THREE.DoubleSide;
    } else {
      m.side = THREE.FrontSide;
    }
    if (/body/i.test(id)) m.roughness = 0.55;
    m.needsUpdate = true;
  }
}

/**
 * Removes horizontal pelvis travel so clips play in place; the game moves the
 * character itself. Vertical motion (crouch in a roll) is kept.
 */
function stripRootMotion(clip: THREE.AnimationClip, pelvis: THREE.Bone): void {
  const track = clip.tracks.find((t) => t.name === `${pelvis.name}.position`);
  if (!track) return;
  // World up expressed in the pelvis parent's space.
  const parentQuat = new THREE.Quaternion();
  pelvis.parent?.getWorldQuaternion(parentQuat);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQuat.invert()).normalize();
  const v = track.values;
  const first = new THREE.Vector3(v[0], v[1], v[2]);
  const firstHorizontal = first.clone().addScaledVector(up, -first.dot(up));
  const p = new THREE.Vector3();
  for (let i = 0; i < v.length; i += 3) {
    p.set(v[i], v[i + 1], v[i + 2]);
    const h = p.dot(up);
    p.copy(firstHorizontal).addScaledVector(up, h);
    v[i] = p.x;
    v[i + 1] = p.y;
    v[i + 2] = p.z;
  }
}

/**
 * Seats a sword in the right fist. The grip runs from the pinky to the index
 * knuckles with the edge facing the knuckles; derived from the grip pose that
 * build_character.py bakes into every clip.
 */
export function placeSword(sword: THREE.Object3D): void {
  sword.rotation.set(3.044, 0.812, -1.843);
  sword.position.set(-0.012, 0.069, -0.005);
}

/** Straps a shield to the outside of the left forearm, face toward the back of the hand. */
export function placeShield(shield: THREE.Object3D): void {
  shield.rotation.set(0, -1.448, 0);
  shield.position.set(-0.05, 0.165, 0.006);
}

/** A simple PBR one-handed sword, parented to the right hand bone. */
export function createSword(scale = 1, look?: SwordLook): THREE.Group {
  const steel = new THREE.MeshStandardMaterial({ color: look?.blade ?? 0xd0d4d8, metalness: 1, roughness: 0.28 });
  if (look?.emissive) {
    steel.emissive = new THREE.Color(look.emissive);
    steel.emissiveIntensity = 1.6;
  }
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a211b, roughness: 0.7 });
  const brass = new THREE.MeshStandardMaterial({ color: look?.guard ?? 0xb08d57, metalness: 1, roughness: 0.35 });
  scale *= look?.scale ?? 1;
  const sword = new THREE.Group();
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(-0.022, 0);
  bladeShape.lineTo(0.022, 0);
  bladeShape.lineTo(0.018, 0.74);
  bladeShape.lineTo(0, 0.82);
  bladeShape.lineTo(-0.018, 0.74);
  bladeShape.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 1 });
  bladeGeo.translate(0, 0.07, -0.003);
  sword.add(new THREE.Mesh(bladeGeo, steel));
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.022, 0.03), brass);
  guard.position.y = 0.06;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.12, 8), dark);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), brass);
  pommel.position.y = -0.065;
  sword.add(guard, grip, pommel);
  sword.traverse((o) => (o.castShadow = true));
  sword.scale.setScalar(scale);
  return sword;
}

/**
 * A round shield facing +Z: domed face, metal rim and a central boss. The
 * origin sits at the arm strap on the back so it can hang off the forearm.
 */
export function createShield(look: ShieldLook): THREE.Group {
  const r = look.radius;
  const face = new THREE.MeshStandardMaterial({ color: look.face, metalness: look.metal ? 0.85 : 0, roughness: look.metal ? 0.4 : 0.8 });
  const rim = new THREE.MeshStandardMaterial({ color: look.rim, metalness: 0.9, roughness: 0.35 });
  const boss = new THREE.MeshStandardMaterial({ color: look.boss ?? look.rim, metalness: 0.95, roughness: 0.25 });
  if (look.emissive) {
    boss.emissive = new THREE.Color(look.emissive);
    boss.emissiveIntensity = 1.4;
  }
  const shield = new THREE.Group();
  // A shallow spherical cap reads as a domed face.
  const capAngle = 0.42;
  const sphereR = r / Math.sin(capAngle);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(sphereR, 40, 6, 0, Math.PI * 2, 0, capAngle), face);
  dome.rotation.x = Math.PI / 2;
  dome.position.z = 0.04 - sphereR * Math.cos(capAngle);
  const back = new THREE.Mesh(new THREE.CircleGeometry(r, 40), face);
  back.rotation.y = Math.PI;
  back.position.z = 0.04;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.016, 8, 48), rim);
  ring.position.z = 0.04;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(r * 0.22, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), boss);
  knob.rotation.x = Math.PI / 2;
  knob.position.z = 0.04 + sphereR * (1 - Math.cos(capAngle));
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.03), new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.8 }));
  strap.position.z = 0.02;
  shield.add(dome, back, ring, knob, strap);
  // Rivets just inside the rim, seated on the dome surface.
  const rivetGeo = new THREE.SphereGeometry(0.011, 8, 6);
  const rr = r * 0.86;
  const rz = 0.04 - sphereR * Math.cos(capAngle) + Math.sqrt(sphereR * sphereR - rr * rr);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const rivet = new THREE.Mesh(rivetGeo, rim);
    rivet.position.set(Math.cos(a) * rr, Math.sin(a) * rr, rz);
    shield.add(rivet);
  }
  shield.traverse((o) => (o.castShadow = true));
  return shield;
}
