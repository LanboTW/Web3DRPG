import * as THREE from 'three/webgpu';
import { attribute, float, mix, normalMap, positionWorld, texture, vec3, vertexColor } from 'three/tsl';
import type { QualitySettings } from '../engine/quality';

const LAYERS = ['leafy_grass', 'brown_mud_leaves_01', 'rock_face_03', 'cobblestone_floor_08'] as const;
/** Metres per texture repeat for each layer. */
const TILE = [4, 3.5, 6, 3];

const loader = new THREE.TextureLoader();

function load(res: string, name: string, map: 'diff' | 'nor_gl', anisotropy: number): Promise<THREE.Texture> {
  return loader.loadAsync(`${import.meta.env.BASE_URL}textures/${res}/${name}_${map}.webp`).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = map === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = anisotropy;
    return t;
  });
}

/**
 * Splat-mapped PBR terrain: grass base with mud, rock and stone layers weighted
 * by the `splat` vertex attribute (x = mud, y = rock, z = stone). The vertex
 * colour stays as a subtle tint so large-scale variation survives.
 */
export async function createTerrainMaterial(quality: QualitySettings): Promise<{ material: THREE.MeshStandardNodeMaterial; upgrade: () => Promise<void> }> {
  const useNormals = quality.tier !== 'low';
  const anisotropy = quality.tier === 'high' ? 8 : 4;
  const diff = await Promise.all(LAYERS.map((n) => load('1k', n, 'diff', anisotropy)));
  const nor = useNormals ? await Promise.all(LAYERS.map((n) => load('1k', n, 'nor_gl', anisotropy))) : [];

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const splat = attribute('splat', 'vec3');
  const wMud = splat.x;
  const wRock = splat.y;
  const wStone = splat.z;
  const xz = positionWorld.xz;
  const diffNodes = diff.map((t, i) => texture(t, xz.div(TILE[i])));
  // A second, larger-scale grass sample hides the obvious tiling of the base layer.
  // Leafy grass leans autumnal; push it toward summer green.
  const grass = mix(diffNodes[0].rgb, texture(diff[0], xz.div(TILE[0] * 4.7)).rgb, float(0.4)).mul(vec3(0.82, 1.08, 0.62));
  let color = grass;
  color = mix(color, diffNodes[1].rgb, wMud);
  color = mix(color, diffNodes[2].rgb, wRock);
  color = mix(color, diffNodes[3].rgb, wStone);
  material.colorNode = color.mul(vertexColor().mul(1.6));

  if (useNormals) {
    const norNodes = nor.map((t, i) => texture(t, xz.div(TILE[i])).rgb);
    let n = norNodes[0];
    n = mix(n, norNodes[1], wMud);
    n = mix(n, norNodes[2], wRock);
    n = mix(n, norNodes[3], wStone);
    material.normalNode = normalMap(vec3(n));
  }

  /** On the high tier, swap in 2K textures once the game is running. */
  const upgrade = async () => {
    if (quality.tier !== 'high') return;
    const [d2, n2] = await Promise.all([
      Promise.all(LAYERS.map((n) => load('2k', n, 'diff', anisotropy))),
      Promise.all(LAYERS.map((n) => load('2k', n, 'nor_gl', anisotropy))),
    ]);
    d2.forEach((t, i) => {
      diff[i].image = t.image;
      diff[i].needsUpdate = true;
    });
    n2.forEach((t, i) => {
      nor[i].image = t.image;
      nor[i].needsUpdate = true;
    });
  };
  return { material, upgrade };
}
