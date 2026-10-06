import * as THREE from 'three/webgpu';
import type { Input } from '../input/input';
import type { ColliderWorld } from './colliders';
import { createSword, type CharacterModel } from './character';
import { heightAt, PLAY_HALF } from './terrain';

const WALK_SPEED = 2.2;
const RUN_SPEED = 4.6;
const SPRINT_SPEED = 7.2;
const ACCEL = 12;
const TURN_SPEED = 12;
const RADIUS = 0.4;
const DODGE_TIME = 0.6;
const DODGE_SPEED = 7.5;
const DODGE_COOLDOWN = 0.2;
const ATTACK_TIME = 0.8;
const FADE = 0.18;

type OneShot = 'roll' | 'attack';

/** The swordswoman: movement, collision and animation state. */
export class Player {
  readonly root = new THREE.Group();
  readonly position = this.root.position;
  readonly velocity = new THREE.Vector3();
  /** Facing angle around Y; 0 looks down +Z. */
  facing = Math.PI;
  /** Height of the camera look-at point above the feet. */
  readonly eyeHeight = 1.45;

  private dodgeTimer = 0;
  private dodgeCooldown = 0;
  private dodgeDir = new THREE.Vector3();
  private attackTimer = 0;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;

  constructor(model: CharacterModel) {
    this.root.add(model.root);
    this.mixer = model.mixer;
    for (const [name, clip] of model.clips) {
      const action = this.mixer.clipAction(clip);
      if (name === 'roll' || name === 'attack' || name === 'hit' || name === 'death') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }
    this.play('idle', 0);

    const hand = model.bones.get('hand_r');
    if (hand) {
      const sword = createSword();
      // Hand bone axes: Y runs along the fingers. Rotate the blade out of the fist.
      sword.rotation.set(0, 0, -Math.PI / 2);
      sword.position.set(0.02, 0.09, 0.025);
      hand.add(sword);
    }
  }

  spawn(x: number, z: number): void {
    this.position.set(x, heightAt(x, z), z);
  }

  private play(name: string, fade = FADE, oneShot?: OneShot, duration?: number): void {
    const next = this.actions.get(name);
    if (!next || (next === this.current && !oneShot)) return;
    next.reset();
    if (duration) next.setDuration(duration);
    else next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    if (this.current) next.crossFadeFrom(this.current, fade, false);
    next.play();
    this.current = next;
  }

  /** `cameraYaw` is the camera's orbit angle; input is relative to it. */
  update(dt: number, input: Input, cameraYaw: number, colliders: ColliderWorld): void {
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);

    // Camera-relative move direction. Camera sits at yaw, looking toward -yaw.
    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    const wish = new THREE.Vector3(fx * input.move.y - fz * input.move.x, 0, fz * input.move.y + fx * input.move.x);
    const wishLen = Math.min(1, wish.length());

    if (input.wasPressed('dodge') && this.dodgeTimer <= 0 && this.dodgeCooldown <= 0) {
      this.dodgeTimer = DODGE_TIME;
      this.attackTimer = 0;
      if (wishLen > 0.1) this.dodgeDir.copy(wish).normalize();
      else this.dodgeDir.set(Math.sin(this.facing), 0, Math.cos(this.facing));
      this.facing = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
      this.play('roll', 0.08, 'roll', DODGE_TIME + 0.1);
    }
    if (input.wasPressed('attack') && this.dodgeTimer <= 0 && this.attackTimer <= 0) {
      this.attackTimer = ATTACK_TIME;
      this.play('attack', 0.1, 'attack', ATTACK_TIME);
    }

    if (this.dodgeTimer > 0) {
      this.dodgeTimer -= dt;
      const k = Math.max(0, this.dodgeTimer / DODGE_TIME);
      this.velocity.copy(this.dodgeDir).multiplyScalar(DODGE_SPEED * (0.35 + 0.65 * k));
      if (this.dodgeTimer <= 0) this.dodgeCooldown = DODGE_COOLDOWN;
    } else {
      this.attackTimer = Math.max(0, this.attackTimer - dt);
      const attacking = this.attackTimer > 0;
      let speed = input.sprint ? SPRINT_SPEED : wishLen > 0.6 ? RUN_SPEED : WALK_SPEED;
      if (attacking) speed *= 0.15;
      const target = wish.clone().normalize().multiplyScalar(wishLen > 0.05 ? speed : 0);
      this.velocity.lerp(target, 1 - Math.exp(-ACCEL * dt));
      if (wishLen > 0.05 && !attacking) {
        this.facing = dampAngle(this.facing, Math.atan2(wish.x, wish.z), TURN_SPEED, dt);
      }
      if (!attacking) this.updateLocomotion();
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    colliders.resolve(this.position, RADIUS);
    this.position.x = THREE.MathUtils.clamp(this.position.x, -PLAY_HALF, PLAY_HALF);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -PLAY_HALF, PLAY_HALF);
    this.position.y = heightAt(this.position.x, this.position.z);
    this.root.rotation.y = this.facing;

    this.mixer.update(dt);
  }

  private updateLocomotion(): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const state = speed < 0.4 ? 'idle' : speed < (WALK_SPEED + RUN_SPEED) / 2 ? 'walk' : speed < (RUN_SPEED + SPRINT_SPEED) / 2 ? 'run' : 'sprint';
    this.play(state);
    // Match cadence to ground speed to reduce foot sliding.
    const cadence: Record<string, number> = { walk: WALK_SPEED, run: RUN_SPEED, sprint: SPRINT_SPEED };
    if (this.current && cadence[state]) this.current.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / cadence[state], 0.6, 1.4));
  }
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return current + diff * (1 - Math.exp(-lambda * dt));
}
