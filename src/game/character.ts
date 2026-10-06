import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { SwordLook } from '../rpg/items';

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
