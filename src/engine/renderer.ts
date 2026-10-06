import * as THREE from 'three/webgpu';
import type { QualitySettings } from './quality';

export function webGPUAvailable(): boolean {
  if (new URLSearchParams(location.search).has('webgl')) return false;
  return 'gpu' in navigator;
}

/**
 * WebGPURenderer picks WebGPU when available and falls back to its WebGL2
 * backend on its own; `?webgl` in the URL forces the fallback for testing.
 */
export async function createRenderer(container: HTMLElement, quality: QualitySettings): Promise<THREE.WebGPURenderer> {
  const renderer = new THREE.WebGPURenderer({
    antialias: quality.antialias,
    forceWebGL: !webGPUAvailable(),
    powerPreference: 'high-performance',
  });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  return renderer;
}

export function backendName(renderer: THREE.WebGPURenderer): string {
  const backend = renderer.backend as { isWebGPUBackend?: boolean };
  return backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
}

/**
 * Lowers the render scale when frames run long and raises it back when there
 * is headroom, so phones hold their frame-rate target.
 */
export class DynamicResolution {
  scale = 1;
  private accum = 0;
  private frames = 0;

  constructor(private renderer: THREE.WebGPURenderer, private quality: QualitySettings) {}

  update(dt: number): void {
    this.accum += dt;
    this.frames++;
    if (this.accum < 2) return;
    const fps = this.frames / this.accum;
    this.accum = 0;
    this.frames = 0;
    const target = this.quality.targetFps;
    let next = this.scale;
    if (fps < target * 0.85) next = Math.max(0.6, this.scale - 0.1);
    else if (fps > target * 1.15 && this.scale < 1) next = Math.min(1, this.scale + 0.05);
    if (next !== this.scale) {
      this.scale = next;
      this.apply();
    }
  }

  apply(): void {
    const dpr = Math.min(window.devicePixelRatio, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(dpr * this.scale);
  }
}
