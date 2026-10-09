import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { QualitySettings } from '../engine/quality';
import { assetUrl } from './character';

/**
 * Static world assets from tools/props (Poly Haven CC0 models, ruined fort
 * pieces and procedurally modelled houses). Each asset is a top-level node,
 * origin at the centre of its footprint, ground at y = 0, front facing +Z.
 */
export class PropLibrary {
  private readonly nodes = new Map<string, THREE.Object3D>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly sizes = new Map<string, THREE.Vector3>();

  constructor(scene: THREE.Object3D, anisotropy: number) {
    for (const node of scene.children) {
      this.nodes.set(node.name, node);
      node.updateMatrixWorld(true);
      this.sizes.set(node.name, new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3()));
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
          this.materials.set(m.name, m);
          for (const t of [m.map, m.normalMap, m.roughnessMap, m.aoMap]) if (t) t.anisotropy = anisotropy;
        }
      });
    }
  }

  has(name: string): boolean {
    return this.nodes.has(name);
  }

  /** Bounding size of an asset in metres. */
  size(name: string): THREE.Vector3 {
    return this.sizes.get(name)!;
  }

  material(name: string): THREE.Material | undefined {
    return this.materials.get(name);
  }

  /** A fresh copy (geometry and materials shared) for one-off placement. */
  clone(name: string, shadows = true): THREE.Object3D {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`unknown prop ${name}`);
    // Wrap: meshopt quantization stores a dequantizing transform on the node itself.
    const copy = new THREE.Group().add(node.clone());
    copy.name = name;
    copy.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = shadows;
        o.receiveShadow = true;
      }
    });
    return copy;
  }

  /** Many copies of one asset, one InstancedMesh per primitive. */
  instanced(name: string, matrices: THREE.Matrix4[], colors?: THREE.Color[], shadows = true): THREE.Group {
    const group = new THREE.Group();
    group.name = `${name}×${matrices.length}`;
    const node = this.nodes.get(name);
    if (!node || matrices.length === 0) return group;
    const m = new THREE.Matrix4();
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Bake each primitive's transform (including dequantization) into the instances.
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, matrices.length);
      matrices.forEach((mat, i) => inst.setMatrixAt(i, m.multiplyMatrices(mat, mesh.matrixWorld)));
      if (colors) colors.forEach((c, i) => inst.setColorAt(i, c));
      inst.castShadow = shadows;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      group.add(inst);
    });
    return group;
  }
}

export async function loadProps(quality: QualitySettings, onProgress?: (f: number) => void): Promise<PropLibrary> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const dir = quality.tier === 'low' ? 'low/' : '';
  const gltf = await loader.loadAsync(assetUrl(`models/${dir}props.glb`), (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });
  return new PropLibrary(gltf.scene, quality.tier === 'high' ? 8 : 4);
}
