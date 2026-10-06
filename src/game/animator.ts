import * as THREE from 'three/webgpu';

const ONE_SHOTS = new Set(['roll', 'attack', 'attack2', 'hit', 'death', 'castEnter', 'cast', 'interact']);

/** Thin cross-fading wrapper around AnimationMixer. */
export class Animator {
  readonly mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  current: THREE.AnimationAction | null = null;
  currentName = '';

  constructor(root: THREE.Object3D, clips: Map<string, THREE.AnimationClip>) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const [name, clip] of clips) {
      const action = this.mixer.clipAction(clip);
      if (ONE_SHOTS.has(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  /**
   * Cross-fades to `name`. Looping clips already playing are left alone unless
   * `restart`; one-shots always restart. `duration` stretches the clip.
   */
  play(name: string, { fade = 0.18, duration, restart = false, from = 0 }: { fade?: number; duration?: number; restart?: boolean; from?: number } = {}): void {
    const next = this.actions.get(name);
    if (!next) return;
    if (next === this.current && !restart && !ONE_SHOTS.has(name)) return;
    next.reset();
    next.enabled = true;
    if (duration) next.setDuration(duration);
    else next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    if (from) next.time = from * next.getClip().duration;
    if (this.current && this.current !== next) next.crossFadeFrom(this.current, fade, false);
    next.play();
    this.current = next;
    this.currentName = name;
  }

  setSpeed(scale: number): void {
    this.current?.setEffectiveTimeScale(scale);
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }
}
