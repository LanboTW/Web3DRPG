import * as THREE from 'three/webgpu';
import {
  dot, float, Fn, int, luminance, mix, mrt, normalView, output, pass, renderOutput, smoothstep, uniform,
  uv, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
import type { QualitySettings } from './quality';

/**
 * Per-tier post stack:
 *   high   – GTAO, bloom, sun shafts, grading
 *   medium – bloom, grading
 *   low    – grading only
 * Tone mapping happens inside the stack so grading works on display values.
 */
export class PostStack {
  private pipeline: THREE.RenderPipeline;
  private sunUv = uniform(new THREE.Vector2(0.5, 0.5));
  private sunVisible = uniform(0);
  /** Sun shaft strength (tweakable from the dev console). */
  readonly shaftStrength = uniform(1);
  private readonly sunWorld = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, private camera: THREE.PerspectiveCamera, quality: QualitySettings, private sunDir: THREE.Vector3) {
    const post = quality.post;
    // GTAO cannot read a multisampled depth buffer, so the AO tier swaps MSAA for FXAA.
    const scenePass = pass(scene, camera, post.ao ? { samples: 0 } : {});
    if (post.ao) scenePass.setMRT(mrt({ output, normal: normalView }));
    const color = scenePass.getTextureNode('output');
    let hdr = color.rgb;

    if (post.ao) {
      const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 0.6;
      aoPass.thickness.value = 1.2;
      // Soften it a little: full GTAO darkens grass and foliage too much.
      hdr = hdr.mul(mix(float(1), aoPass.getTextureNode().r, 0.85));
    }

    if (post.bloom) {
      const glow = bloom(vec4(hdr, 1), 0.18, 0.45, 2.2);
      hdr = hdr.add(glow.rgb);
    }

    if (post.shafts) {
      // Bright sky pixels near the sun, smeared radially toward it.
      const depth = scenePass.getTextureNode('depth');
      const source = Fn(() => {
        const sky = smoothstep(0.99999, 1.0, depth.r);
        const d = uv().sub(this.sunUv).mul(vec2(camera.aspect, 1)).length();
        const near = smoothstep(0.0, 0.75, d).oneMinus();
        // Normalised hue times a 0..1 brightness key, so the sun's huge HDR
        // values do not flood the blur.
        const lum = luminance(color.rgb).max(1e-3);
        const key = smoothstep(1.5, 8.0, lum);
        return vec4(color.rgb.div(lum).mul(key).mul(sky).mul(near), 1);
      })();
      const shafts = radialBlur(source, { center: this.sunUv, weight: float(0.85), decay: float(0.96), count: int(quality.tier === 'high' ? 48 : 24), exposure: float(1.2) });
      hdr = hdr.add((shafts as unknown as THREE.Node<'vec4'>).rgb.mul(vec3(1.0, 0.78, 0.5)).mul(this.sunVisible).mul(this.shaftStrength));
    }

    // Tone map + sRGB, then grade in display space.
    const display = renderOutput(vec4(hdr, 1));
    const graded = Fn(() => {
      const c = display.rgb.toVar();
      // Gentle S-curve.
      c.assign(mix(c, c.mul(c).mul(c.mul(-2).add(3)), 0.25));
      // Split tone: cool shadows, warm highlights.
      const l = luminance(c);
      c.assign(c.add(mix(vec3(-0.012, 0.0, 0.025), vec3(0.025, 0.008, -0.02), smoothstep(0.15, 0.85, l))));
      // A touch more saturation.
      c.assign(mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.08));
      // Vignette.
      const v = uv().sub(0.5).length();
      c.mulAssign(smoothstep(0.35, 0.95, v).oneMinus().mul(0.22).add(0.78));
      return vec4(c, 1);
    })();

    this.pipeline = new THREE.RenderPipeline(renderer, post.ao ? fxaa(graded) : graded);
    this.pipeline.outputColorTransform = false;
  }

  render(): void {
    // Sun position on screen for the shafts; fade out when it is off-screen or behind.
    this.sunWorld.copy(this.camera.position).addScaledVector(this.sunDir, 1000).project(this.camera);
    this.sunUv.value.set(this.sunWorld.x * 0.5 + 0.5, 0.5 - this.sunWorld.y * 0.5);
    this.camera.getWorldDirection(this.camDir);
    const facing = THREE.MathUtils.smoothstep(this.camDir.dot(this.sunDir), 0.1, 0.6);
    const edge = Math.max(Math.abs(this.sunWorld.x), Math.abs(this.sunWorld.y));
    this.sunVisible.value = facing * (1 - THREE.MathUtils.smoothstep(edge, 0.9, 1.6));
    this.pipeline.render();
  }
}
