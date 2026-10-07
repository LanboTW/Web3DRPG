import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import {
  cameraPosition, equirectUV, exp, float, fog, Fn, mix, normalize, positionLocal, positionWorld,
  smoothstep, texture, uniform, vec2, vec3,
} from 'three/tsl';
import type { QualitySettings } from '../engine/quality';

/**
 * Golden-hour sky from the Poly Haven HDRI "Table Mountain 1 (Pure Sky)" (CC0).
 * The background is a Reinhard-encoded JPEG strip of the upper hemisphere
 * (tools/blender/bake_sky.py); the 1k HDR feeds image-based lighting and the
 * fog colour, so distant hills fade into exactly the sky behind them.
 */

/** Where the sun sits in the HDRI (azimuth 49.5°, elevation 12.9°). */
const SKY_AZIMUTH = 0.8633;
export const SKY_SUN = dirFrom(SKY_AZIMUTH, 12.85);
/**
 * The light that casts shadows comes from the same azimuth, a little higher,
 * so the play area is not half in shadow from long grazing rays.
 */
export const SUN_DIRECTION = dirFrom(SKY_AZIMUTH, 24);

/** Linear-HDR multiplier shared by the sky, its fog colour and the IBL. */
const SKY_INTENSITY = 2.2;
/** Fraction of the equirect height covered by the background strip. */
const STRIP = 0.52;

function dirFrom(azimuth: number, elevationDeg: number): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  // Matches three.js equirectUV: u = atan(z, x) / 2π + 0.5.
  return new THREE.Vector3(Math.cos(azimuth) * Math.cos(el), Math.sin(el), Math.sin(azimuth) * Math.cos(el));
}

export interface Atmosphere {
  /** Equirect HDR for scene.environment (PMREM'd by the renderer). */
  environment: THREE.Texture;
  dome: THREE.Mesh;
  /** 0 = open golden-hour valley, 1 = cold mist of the knight's ruins. */
  mist: { value: number };
}

export async function createAtmosphere(quality: QualitySettings, radius: number, fogFar: number): Promise<{ atmosphere: Atmosphere; fogNode: ReturnType<typeof fog> }> {
  const base = import.meta.env.BASE_URL;
  const file = { low: 'sky_low', medium: 'sky', high: 'sky_hd' }[quality.tier];
  const [strip, hdr] = await Promise.all([
    new THREE.TextureLoader().loadAsync(`${base}textures/sky/${file}.jpg`),
    new HDRLoader().setDataType(THREE.FloatType).loadAsync(`${base}textures/sky/env.hdr`),
  ]);
  strip.colorSpace = THREE.SRGBColorSpace;
  strip.generateMipmaps = false;
  strip.minFilter = THREE.LinearFilter;
  strip.wrapS = THREE.RepeatWrapping;

  const environment = prepareEnvironment(hdr);
  const haze = hazeTexture(hdr);

  const mist = uniform(0);
  const sunDir = uniform(SKY_SUN);

  // Sky dome: decode the strip back to linear HDR so it is tone mapped and
  // bloomed together with the rest of the frame.
  const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  domeMat.colorNode = Fn(() => {
    const dir = normalize(positionLocal);
    const uv = equirectUV(dir);
    const v = uv.y.sub(1 - STRIP).div(STRIP).clamp(0.003, 1);
    const s = texture(strip, vec2(uv.x, v)).level(float(0)).rgb.min(0.996);
    const sky = s.div(s.oneMinus()).mul(SKY_INTENSITY).toVar();
    // Below the horizon (hidden by terrain except at the map edge) use the haze.
    const below = smoothstep(float(-0.06), float(0), dir.y).oneMinus();
    const ground = texture(haze, equirectUV(vec3(dir.x, 0.04, dir.z).normalize())).level(float(0)).rgb.mul(SKY_INTENSITY);
    sky.assign(mix(sky, ground, below));
    // The ruins' mist greys the sky over them.
    return mix(sky, mistColor(sky), mist.mul(0.55));
  })();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), domeMat);
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  dome.castShadow = false;
  dome.receiveShadow = false;

  // Aerial perspective: colour comes from the blurred sky in the view direction
  // with warm in-scattering toward the sun, density thickens near the ground.
  const fogNode = Fn(() => {
    const view = positionWorld.sub(cameraPosition);
    const dist = view.length();
    const dir = view.div(dist);
    const horizon = vec3(dir.x, dir.y.clamp(0.03, 0.3), dir.z).normalize();
    const skyCol = texture(haze, equirectUV(horizon)).level(float(0)).rgb.mul(SKY_INTENSITY);
    const toSun = dir.dot(sunDir).max(0);
    const glow = toSun.pow(6).mul(0.45).add(toSun.pow(48).mul(0.8));
    const haze0 = skyCol.add(vec3(1.0, 0.62, 0.3).mul(glow));
    // Cap brightness: toward the low sun the raw sky is so bright that even
    // light haze would bleach the village out.
    const hazeLum = haze0.dot(vec3(0.2126, 0.7152, 0.0722));
    const capped = haze0.div(hazeLum.div(1.4).max(1));
    const color = mix(capped, mistColor(skyCol), mist);

    const height = positionWorld.y.max(0);
    const groundHaze = exp(height.mul(-0.07)).mul(0.6).add(0.4);
    const density = mix(float(1.15 / fogFar), float(1 / 30), mist.mul(mist));
    // Mist pools in the ruins' hollow; open slopes above stay clearer.
    const pool = mix(float(1), exp(height.sub(11).max(0).mul(-0.35)).mul(0.8).add(0.2), mist);
    const factor = exp(dist.mul(density).mul(groundHaze).mul(pool).negate()).oneMinus()
      .max(smoothstep(float(fogFar * 0.8), float(fogFar), dist));
    return fog(color, factor);
  })();

  return { atmosphere: { environment, dome, mist }, fogNode };
}

/** Cold, desaturated blue-grey derived from the local sky brightness. */
function mistColor(sky: THREE.Node<'vec3'>) {
  const lum = sky.dot(vec3(0.2126, 0.7152, 0.0722));
  return vec3(0.62, 0.7, 0.8).mul(lum.mul(0.8).add(0.15));
}

/**
 * IBL source: the sun's 100k-nit core is clamped (the directional light does
 * that job) and the mirrored lower half of the "pure sky" is replaced with a
 * dim earth tone so nothing is lit from below like a frozen lake.
 */
function prepareEnvironment(hdr: THREE.DataTexture): THREE.DataTexture {
  const { width, height, data } = hdr.image as { width: number; height: number; data: Float32Array };
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    // HDR rows run top-down (uploaded with flipY), so the ground is the bottom half.
    const groundT = THREE.MathUtils.smoothstep(y / height, 0.5, 0.54);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const sky = Math.min(data[i + c], 12);
        const earth = [0.075, 0.062, 0.042][c];
        out[i + c] = sky + (earth - sky) * groundT;
      }
      out[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}

/** 64×32 box-filtered copy of the HDR for fog colour (sun clamped). */
function hazeTexture(hdr: THREE.DataTexture): THREE.DataTexture {
  const { width, height, data } = hdr.image as { width: number; height: number; data: Float32Array };
  const W = 64, H = 32;
  const out = new Float32Array(W * H * 4);
  const bx = width / W, by = height / H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = Math.floor(y * by); sy < (y + 1) * by; sy++) {
        for (let sx = Math.floor(x * bx); sx < (x + 1) * bx; sx++) {
          const i = (sy * width + sx) * 4;
          r += Math.min(data[i], 3); g += Math.min(data[i + 1], 3); b += Math.min(data[i + 2], 3); n++;
        }
      }
      out.set([r / n, g / n, b / n, 1], (y * W + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}
