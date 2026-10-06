import * as THREE from 'three/webgpu';
import type { Input } from '../input/input';
import { Animator } from './animator';
import type { ColliderWorld } from './colliders';
import { createSword, type CharacterModel } from './character';
import { inArc, inRadius, rollDamage, type CombatEvents, type Combatant, type HitInfo, type Stats } from './combat';
import type { Enemy } from './enemy';
import { heightAt, PLAY_HALF } from './terrain';
import type { Vfx } from './vfx';

const WALK_SPEED = 2.2;
const RUN_SPEED = 4.6;
const SPRINT_SPEED = 7.2;
const ACCEL = 12;
const TURN_SPEED = 12;
const DODGE_TIME = 0.6;
/** I-frames cover the first part of the roll. */
const DODGE_IFRAMES = 0.42;
const DODGE_SPEED = 7.5;
const DODGE_COOLDOWN = 0.2;
const LOCK_RANGE = 22;
const ULT_COST = 100;

interface Move {
  clip: string;
  duration: number;
  /** Seconds into the move when damage is applied (one entry per hit). */
  hits: number[];
  range: number;
  /** Frontal arc in degrees; 360 = all around. */
  arc: number;
  mult: number;
  knockback: number;
  heavy: boolean;
  /** Forward speed during the first `lungeTime` seconds. */
  lunge: number;
  lungeTime: number;
  /** After this many seconds a buffered attack chains into the next combo step. */
  chainAt?: number;
  iframes?: boolean;
  spin?: boolean;
  vfx?: 'whirl' | 'thrust' | 'ult';
  cooldown?: number;
}

const COMBO: Move[] = [
  { clip: 'attack', duration: 0.55, hits: [0.28], range: 2.3, arc: 120, mult: 1, knockback: 3, heavy: false, lunge: 2.5, lungeTime: 0.2, chainAt: 0.33 },
  { clip: 'attack2', duration: 0.5, hits: [0.22], range: 2.3, arc: 100, mult: 1.15, knockback: 3, heavy: false, lunge: 3, lungeTime: 0.18, chainAt: 0.3 },
  { clip: 'attack', duration: 0.8, hits: [0.45], range: 2.8, arc: 160, mult: 2, knockback: 9, heavy: true, lunge: 4.5, lungeTime: 0.35 },
];

export const SKILLS: Record<'skill1' | 'skill2' | 'ultimate', Move> = {
  skill1: { clip: 'attack', duration: 0.7, hits: [0.25, 0.45], range: 3.2, arc: 360, mult: 1.4, knockback: 6, heavy: false, lunge: 0, lungeTime: 0, spin: true, vfx: 'whirl', cooldown: 6 },
  skill2: { clip: 'attack2', duration: 0.6, hits: [0.18, 0.34], range: 1.9, arc: 360, mult: 2.2, knockback: 8, heavy: true, lunge: 12, lungeTime: 0.35, iframes: true, vfx: 'thrust', cooldown: 8 },
  ultimate: { clip: 'cast', duration: 1.15, hits: [0.6], range: 6.5, arc: 360, mult: 5, knockback: 13, heavy: true, lunge: 0, lungeTime: 0, iframes: true, vfx: 'ult' },
};

type SkillName = keyof typeof SKILLS;

/** The swordswoman: movement, combat and animation state. */
export class Player implements Combatant {
  readonly root = new THREE.Group();
  readonly position = this.root.position;
  readonly velocity = new THREE.Vector3();
  readonly radius = 0.4;
  /** Facing angle around Y; 0 looks down +Z. */
  facing = Math.PI;
  /** Height of the camera look-at point above the feet. */
  readonly eyeHeight = 1.45;

  stats: Stats = { maxHp: 120, atk: 12, def: 4, critChance: 0.1 };
  hp = this.stats.maxHp;
  ultCharge = 0;
  readonly cooldowns: Record<SkillName, number> = { skill1: 0, skill2: 0, ultimate: 0 };
  lockTarget: Enemy | null = null;
  /** Called with the enemy whenever one is killed by the player. */
  onKill: ((enemy: Enemy) => void) | null = null;

  private model: THREE.Object3D;
  private animator: Animator;
  private dodgeTimer = 0;
  private dodgeCooldown = 0;
  private dodgeDir = new THREE.Vector3();
  private move: Move | null = null;
  private moveTime = 0;
  private hitsDone = 0;
  private comboStep = 0;
  private attackQueued = false;
  private staggerTimer = 0;
  private knock = new THREE.Vector3();

  constructor(model: CharacterModel) {
    this.model = model.root;
    this.root.add(model.root);
    this.animator = new Animator(model.root, model.clips);
    this.animator.play('idle', { fade: 0 });

    const hand = model.bones.get('hand_r');
    if (hand) {
      const sword = createSword();
      // Hand bone axes: Y runs along the fingers. Rotate the blade out of the fist.
      sword.rotation.set(0, 0, -Math.PI / 2);
      sword.position.set(0.02, 0.09, 0.025);
      hand.add(sword);
    }
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  get invulnerable(): boolean {
    if (this.dodgeTimer > DODGE_TIME - DODGE_IFRAMES) return true;
    return !!this.move?.iframes;
  }

  spawn(x: number, z: number): void {
    this.position.set(x, heightAt(x, z), z);
  }

  revive(x: number, z: number): void {
    this.hp = this.stats.maxHp;
    this.cancelMove();
    this.staggerTimer = 0;
    this.dodgeTimer = 0;
    this.lockTarget = null;
    this.spawn(x, z);
    this.animator.play('idle', { fade: 0.3 });
  }

  receiveHit(hit: HitInfo): number {
    if (!this.alive || this.invulnerable) return 0;
    this.hp = Math.max(0, this.hp - hit.amount);
    this.ultCharge = Math.min(ULT_COST, this.ultCharge + 4);
    this.knock.set(this.position.x - hit.from.x, 0, this.position.z - hit.from.z).normalize().multiplyScalar(hit.knockback);
    if (this.hp <= 0) {
      this.cancelMove();
      this.animator.play('death', { fade: 0.1 });
      return hit.amount;
    }
    // Light hits don't interrupt the finisher or skills; everything else staggers.
    if (!this.move || !this.move.heavy || hit.heavy) {
      this.cancelMove();
      this.staggerTimer = hit.heavy ? 0.6 : 0.35;
      this.animator.play('hit', { fade: 0.05, duration: this.staggerTimer + 0.1 });
    }
    return hit.amount;
  }

  /** Picks the enemy closest to where the camera looks, or clears the lock. */
  toggleLock(enemies: Enemy[], cameraYaw: number): void {
    if (this.lockTarget) {
      this.lockTarget = null;
      return;
    }
    this.lockTarget = this.findLockTarget(enemies, cameraYaw);
  }

  private findLockTarget(enemies: Enemy[], cameraYaw: number, exclude?: Enemy): Enemy | null {
    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    let best: Enemy | null = null;
    let bestScore = Infinity;
    for (const e of enemies) {
      if (!e.alive || e === exclude) continue;
      const dx = e.position.x - this.position.x;
      const dz = e.position.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d > LOCK_RANGE) continue;
      const facingDot = (dx * fx + dz * fz) / Math.max(d, 0.001);
      const score = d * (1.6 - facingDot);
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  /** `cameraYaw` is the camera's orbit angle; input is relative to it. */
  update(dt: number, input: Input, cameraYaw: number, colliders: ColliderWorld, enemies: Enemy[], events: CombatEvents, vfx: Vfx): void {
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    for (const k of Object.keys(this.cooldowns) as SkillName[]) this.cooldowns[k] = Math.max(0, this.cooldowns[k] - dt);

    if (this.lockTarget && (!this.lockTarget.alive || this.lockTarget.position.distanceTo(this.position) > LOCK_RANGE + 4)) {
      // Hop to the next enemy when the target dies, like most action games.
      this.lockTarget = this.lockTarget.alive ? null : this.findLockTarget(enemies, cameraYaw, this.lockTarget);
    }

    if (!this.alive) {
      this.velocity.set(0, 0, 0);
      this.animator.update(dt);
      return;
    }

    // Camera-relative move direction. Camera sits at yaw, looking toward -yaw.
    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    const wish = new THREE.Vector3(fx * input.move.y - fz * input.move.x, 0, fz * input.move.y + fx * input.move.x);
    const wishLen = Math.min(1, wish.length());

    if (input.wasPressed('lock')) this.toggleLock(enemies, cameraYaw);

    const busy = this.staggerTimer > 0 || this.dodgeTimer > 0;
    const canAct = !busy && (!this.move || (this.move.chainAt !== undefined && this.moveTime >= this.move.chainAt));

    if (input.wasPressed('dodge') && this.staggerTimer <= 0 && this.dodgeTimer <= 0 && this.dodgeCooldown <= 0 && !this.move?.iframes) {
      this.cancelMove();
      this.dodgeTimer = DODGE_TIME;
      if (wishLen > 0.1) this.dodgeDir.copy(wish).normalize();
      else this.dodgeDir.set(Math.sin(this.facing), 0, Math.cos(this.facing));
      this.facing = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
      this.animator.play('roll', { fade: 0.06, duration: DODGE_TIME + 0.1 });
    }

    if (input.wasPressed('attack')) this.attackQueued = true;
    for (const skill of ['skill1', 'skill2', 'ultimate'] as SkillName[]) {
      if (!input.wasPressed(skill) || !canAct || this.cooldowns[skill] > 0) continue;
      if (skill === 'ultimate') {
        if (this.ultCharge < ULT_COST) continue;
        this.ultCharge = 0;
      }
      this.cooldowns[skill] = SKILLS[skill].cooldown ?? 0;
      this.startMove(SKILLS[skill], enemies, wish, wishLen);
      this.comboStep = 0;
      this.attackQueued = false;
      break;
    }
    if (this.attackQueued && canAct && this.dodgeTimer <= 0) {
      const chaining = this.move && this.move.chainAt !== undefined;
      this.comboStep = chaining ? (this.comboStep + 1) % COMBO.length : 0;
      this.startMove(COMBO[this.comboStep], enemies, wish, wishLen);
      this.attackQueued = false;
    }

    if (this.dodgeTimer > 0) {
      this.dodgeTimer -= dt;
      const k = Math.max(0, this.dodgeTimer / DODGE_TIME);
      this.velocity.copy(this.dodgeDir).multiplyScalar(DODGE_SPEED * (0.35 + 0.65 * k));
      if (this.dodgeTimer <= 0) this.dodgeCooldown = DODGE_COOLDOWN;
    } else if (this.staggerTimer > 0) {
      this.staggerTimer -= dt;
      this.velocity.multiplyScalar(Math.exp(-10 * dt));
    } else if (this.move) {
      this.updateMove(dt, enemies, events, vfx);
    } else {
      let speed = input.sprint ? SPRINT_SPEED : wishLen > 0.6 ? RUN_SPEED : WALK_SPEED;
      if (wishLen <= 0.05) speed = 0;
      const target = wish.clone().normalize().multiplyScalar(speed);
      this.velocity.lerp(target, 1 - Math.exp(-ACCEL * dt));
      if (wishLen > 0.05) this.facing = dampAngle(this.facing, Math.atan2(wish.x, wish.z), TURN_SPEED, dt);
      this.updateLocomotion();
    }
    if (this.attackQueued && !this.move && this.dodgeTimer <= 0 && this.staggerTimer <= 0) this.attackQueued = false;

    this.position.x += (this.velocity.x + this.knock.x) * dt;
    this.position.z += (this.velocity.z + this.knock.z) * dt;
    this.knock.multiplyScalar(Math.exp(-9 * dt));
    colliders.resolve(this.position, this.radius);
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = this.position.x - e.position.x;
      const dz = this.position.z - e.position.z;
      const d = Math.hypot(dx, dz);
      const min = this.radius + e.radius;
      if (d < min && d > 1e-4) {
        this.position.x = e.position.x + (dx / d) * min;
        this.position.z = e.position.z + (dz / d) * min;
      }
    }
    this.position.x = THREE.MathUtils.clamp(this.position.x, -PLAY_HALF, PLAY_HALF);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -PLAY_HALF, PLAY_HALF);
    this.position.y = heightAt(this.position.x, this.position.z);
    this.root.rotation.y = this.facing;

    this.animator.update(dt);
  }

  private cancelMove(): void {
    this.move = null;
    this.model.rotation.y = 0;
  }

  private startMove(move: Move, enemies: Enemy[], wish: THREE.Vector3, wishLen: number): void {
    this.move = move;
    this.moveTime = 0;
    this.hitsDone = 0;
    // Aim: locked target, else a nearby enemy roughly ahead, else stick direction.
    const soft = this.lockTarget ?? inArc(this.position, this.facing, 4.5, 200, enemies).sort(
      (a, b) => a.position.distanceToSquared(this.position) - b.position.distanceToSquared(this.position),
    )[0];
    if (soft) this.facing = Math.atan2(soft.position.x - this.position.x, soft.position.z - this.position.z);
    else if (wishLen > 0.2) this.facing = Math.atan2(wish.x, wish.z);
    this.animator.play(move.clip, { fade: 0.06, duration: move.duration + 0.15 });
  }

  private updateMove(dt: number, enemies: Enemy[], events: CombatEvents, vfx: Vfx): void {
    const move = this.move!;
    this.moveTime += dt;
    const forward = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    const lunge = this.moveTime < move.lungeTime ? move.lunge : 0;
    this.velocity.copy(forward).multiplyScalar(lunge);
    if (move.spin) this.model.rotation.y = (this.moveTime / move.duration) * Math.PI * 2;

    while (this.hitsDone < move.hits.length && this.moveTime >= move.hits[this.hitsDone]) {
      this.hitsDone++;
      this.applyHits(move, enemies, events, vfx, forward);
    }
    if (this.moveTime >= move.duration) {
      this.model.rotation.y = 0;
      this.move = null;
    }
  }

  private applyHits(move: Move, enemies: Enemy[], events: CombatEvents, vfx: Vfx, forward: THREE.Vector3): void {
    const center = this.position.clone();
    if (move.vfx === 'whirl') vfx.ring(center, move.range, 0xffc070);
    if (move.vfx === 'thrust') vfx.ring(center, move.range, 0x9fd8ff, 0.3);
    if (move.vfx === 'ult') {
      vfx.burst(center.clone().setY(center.y + 1), move.range, 0xff7a2a, 0.8);
      events.shake(0.9);
    }
    const targets = move.arc >= 360 ? inRadius(center, move.range, enemies) : inArc(center, this.facing, move.range, move.arc, enemies);
    let landed = false;
    for (const e of targets) {
      const { amount, crit } = rollDamage(this.stats, e.stats, move.mult);
      const dealt = e.receiveHit({ amount, crit, from: this.position, knockback: move.knockback, heavy: move.heavy });
      if (dealt <= 0) continue;
      landed = true;
      events.damage(e, dealt, crit, true);
      vfx.spark(e.chest(new THREE.Vector3()).addScaledVector(forward, -0.3), crit ? 0xfff2b0 : 0xffb050, crit ? 10 : 6);
      if (move !== SKILLS.ultimate) this.ultCharge = Math.min(ULT_COST, this.ultCharge + 6);
      if (!e.alive) this.onKill?.(e);
    }
    if (landed) {
      events.hitStop(move.heavy ? 0.09 : 0.05);
      if (move.heavy) events.shake(0.35);
    }
  }

  private updateLocomotion(): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const state = speed < 0.4 ? 'idle' : speed < (WALK_SPEED + RUN_SPEED) / 2 ? 'walk' : speed < (RUN_SPEED + SPRINT_SPEED) / 2 ? 'run' : 'sprint';
    this.animator.play(state);
    // Match cadence to ground speed to reduce foot sliding.
    const cadence: Record<string, number> = { walk: WALK_SPEED, run: RUN_SPEED, sprint: SPRINT_SPEED };
    if (cadence[state]) this.animator.setSpeed(THREE.MathUtils.clamp(speed / cadence[state], 0.6, 1.4));
  }
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return current + diff * (1 - Math.exp(-lambda * dt));
}
