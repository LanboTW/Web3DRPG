import * as THREE from 'three/webgpu';
import type { Input } from '../input/input';
import { Animator } from './animator';
import type { ColliderWorld } from './colliders';
import { createShield, createSword, placeShield, placeSword, type CharacterModel } from './character';
import { inArc, inRadius, rollDamage, type CombatEvents, type Combatant, type HitInfo, type Stats } from './combat';
import type { Enemy } from './enemy';
import { heightAt, PLAY_HALF } from './terrain';
import type { Vfx } from './vfx';
import type { ItemDef } from '../rpg/items';

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

const STAMINA_MAX = 100;
const STAMINA_REGEN = 34;
/** Regen while the shield is up. */
const STAMINA_REGEN_BLOCKING = 10;
const STAMINA_DELAY = 0.6;
const DODGE_STAMINA = 22;
const SPRINT_STAMINA = 14;
/** Stamina needed before sprinting/dodging works again after running dry. */
const EXHAUST_RECOVER = 30;
const BLOCK_SPEED = 1.7;
/** Seconds after raising the shield in which a block becomes a perfect parry. */
const PARRY_WINDOW = 0.2;
/** Hits within this angle of the facing direction can be blocked. */
const BLOCK_ARC_COS = Math.cos(THREE.MathUtils.degToRad(70));
const BLOCK_STUN = 0.3;
const GUARD_BREAK_STUN = 0.9;

export type GuardResult = 'parry' | 'block' | 'break';

interface Move {
  clip: string;
  /** Portion of the clip played, as fractions of its length (default whole clip). */
  clipFrom?: number;
  clipTo?: number;
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

// Hit times line up with the sword hand's peak speed in each Mixamo clip.
const COMBO: Move[] = [
  { clip: 'attack', clipFrom: 0.15, clipTo: 0.75, duration: 0.6, hits: [0.25], range: 2.3, arc: 120, mult: 1, knockback: 3, heavy: false, lunge: 2.5, lungeTime: 0.2, chainAt: 0.32 },
  { clip: 'attack2', clipFrom: 0.1, clipTo: 0.75, duration: 0.55, hits: [0.28], range: 2.3, arc: 100, mult: 1.15, knockback: 3, heavy: false, lunge: 3, lungeTime: 0.18, chainAt: 0.34 },
  { clip: 'attack3', clipFrom: 0.15, clipTo: 0.95, duration: 0.9, hits: [0.43], range: 2.8, arc: 160, mult: 2, knockback: 9, heavy: true, lunge: 4.5, lungeTime: 0.35 },
];

export const SKILLS: Record<'skill1' | 'skill2' | 'ultimate', Move> = {
  skill1: { clip: 'whirl', clipFrom: 0.1, clipTo: 0.55, duration: 0.95, hits: [0.21, 0.53], range: 3.2, arc: 360, mult: 1.4, knockback: 6, heavy: false, lunge: 0, lungeTime: 0, vfx: 'whirl', cooldown: 6 },
  skill2: { clip: 'thrust', clipFrom: 0.1, clipTo: 0.8, duration: 0.75, hits: [0.33, 0.44], range: 1.9, arc: 360, mult: 2.2, knockback: 8, heavy: true, lunge: 10, lungeTime: 0.42, iframes: true, vfx: 'thrust', cooldown: 8 },
  ultimate: { clip: 'slam', clipFrom: 0.05, clipTo: 0.9, duration: 1.6, hits: [1.07], range: 6.5, arc: 360, mult: 5, knockback: 13, heavy: true, lunge: 2.5, lungeTime: 0.9, iframes: true, vfx: 'ult' },
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
  readonly maxStamina = STAMINA_MAX;
  stamina = STAMINA_MAX;
  /** Ran out of stamina: no sprint or dodge until it recovers a little. */
  exhausted = false;
  /** Called with the enemy whenever one is killed by the player. */
  onKill: ((enemy: Enemy) => void) | null = null;
  /** Called when the shield stops a hit (for effects and sounds). */
  onGuard: ((result: GuardResult, at: THREE.Vector3) => void) | null = null;

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
  private blocking = false;
  private blockTime = 0;
  private staminaDelay = 0;
  private guard = 0.6;
  private guardCost = 1.6;

  constructor(model: CharacterModel) {
    this.model = model.root;
    this.root.add(model.root);
    this.animator = new Animator(model.root, model.clips);
    this.animator.play('idle', { fade: 0 });

    this.bones = model.bones;
    model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (/bodice/i.test(`${mesh.name} ${m.name}`)) this.torsoMaterial = m;
    });
  }

  private bones: Map<string, THREE.Bone>;
  private sword: THREE.Object3D | null = null;
  private shield: THREE.Object3D | null = null;
  private torsoMaterial: THREE.MeshStandardMaterial | null = null;
  private pauldrons: THREE.Object3D[] = [];

  /** Applies combat stats from the RPG state, keeping the current HP ratio. */
  setStats(stats: Stats): void {
    const ratio = this.hp / this.stats.maxHp;
    this.stats = stats;
    this.hp = Math.max(1, Math.round(stats.maxHp * ratio));
  }

  heal(amount: number): void {
    this.hp = Math.min(this.stats.maxHp, this.hp + amount);
  }

  /** Swaps the sword mesh and restyles the armor so gear is visible. */
  setLook(weapon: ItemDef, armor: ItemDef, shield: ItemDef): void {
    const hand = this.bones.get('hand_r');
    if (this.sword) this.sword.removeFromParent();
    if (hand) {
      this.sword = createSword(1, weapon.sword);
      placeSword(this.sword);
      hand.add(this.sword);
    }
    this.guard = shield.guard ?? 0.5;
    this.guardCost = shield.staminaCost ?? 1.5;
    const forearm = this.bones.get('lowerarm_l');
    if (this.shield) this.shield.removeFromParent();
    if (forearm && shield.shield) {
      this.shield = createShield(shield.shield);
      placeShield(this.shield);
      forearm.add(this.shield);
    }
    const look = armor.armor!;
    if (this.torsoMaterial) {
      this.torsoMaterial.color.set(look.torso);
      this.torsoMaterial.metalness = look.metalness;
      this.torsoMaterial.roughness = look.roughness;
      this.torsoMaterial.emissive = new THREE.Color(look.trim ?? 0);
      this.torsoMaterial.emissiveIntensity = look.trim ? 0.15 : 0;
    }
    this.pauldrons.forEach((p) => p.removeFromParent());
    this.pauldrons = [];
    if (look.pauldron !== undefined) {
      const mat = new THREE.MeshStandardMaterial({
        color: look.pauldron, metalness: look.pauldronMetal ? 0.9 : 0, roughness: look.pauldronMetal ? 0.35 : 0.75,
        emissive: new THREE.Color(look.trim ?? 0), emissiveIntensity: look.trim ? 0.4 : 0,
      });
      const geo = new THREE.SphereGeometry(0.105, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
      for (const side of ['l', 'r']) {
        const bone = this.bones.get(`upperarm_${side}`);
        if (!bone) continue;
        const p = new THREE.Mesh(geo, mat);
        // Upper-arm bone Y runs down the arm; cap the shoulder end.
        p.rotation.z = side === 'l' ? Math.PI / 2 : -Math.PI / 2;
        p.position.set(0, 0.03, 0);
        p.scale.set(1, 1.15, 1.25);
        p.castShadow = true;
        bone.add(p);
        this.pauldrons.push(p);
      }
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
    this.stamina = STAMINA_MAX;
    this.exhausted = false;
    this.blocking = false;
    this.cancelMove();
    this.staggerTimer = 0;
    this.dodgeTimer = 0;
    this.lockTarget = null;
    this.spawn(x, z);
    this.animator.play('idle', { fade: 0.3 });
  }

  receiveHit(hit: HitInfo): number {
    if (!this.alive || this.invulnerable) return 0;
    if (this.blocking && this.facingHit(hit.from)) return this.guardHit(hit);
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

  private facingHit(from: THREE.Vector3): boolean {
    const dx = from.x - this.position.x;
    const dz = from.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return true;
    return (dx * Math.sin(this.facing) + dz * Math.cos(this.facing)) / d >= BLOCK_ARC_COS;
  }

  /** A hit that lands on the raised shield: parry, block or guard break. */
  private guardHit(hit: HitInfo): number {
    const at = this.position.clone().setY(this.position.y + 1.2);
    at.x += Math.sin(this.facing) * 0.5;
    at.z += Math.cos(this.facing) * 0.5;
    if (this.blockTime < PARRY_WINDOW) {
      hit.attacker?.parried();
      this.ultCharge = Math.min(ULT_COST, this.ultCharge + 15);
      this.animator.play('blockHit', { fade: 0.04, duration: 0.45 });
      this.onGuard?.('parry', at);
      return 0;
    }
    this.useStamina(hit.amount * this.guardCost * (hit.heavy ? 1.5 : 1));
    const dealt = Math.round(hit.amount * (1 - this.guard));
    this.hp = Math.max(0, this.hp - dealt);
    this.knock.set(this.position.x - hit.from.x, 0, this.position.z - hit.from.z).normalize().multiplyScalar(hit.knockback * 0.5);
    if (this.hp <= 0) {
      this.blocking = false;
      this.animator.play('death', { fade: 0.1 });
      return dealt;
    }
    if (this.stamina <= 0) {
      // Guard broken: the shield arm is knocked aside.
      this.blocking = false;
      this.staggerTimer = GUARD_BREAK_STUN;
      this.animator.play('hit', { fade: 0.05, duration: GUARD_BREAK_STUN + 0.1 });
      this.onGuard?.('break', at);
    } else {
      this.staggerTimer = BLOCK_STUN;
      this.animator.play('blockHit', { fade: 0.04, duration: 0.5 });
      this.onGuard?.('block', at);
    }
    return dealt;
  }

  private useStamina(amount: number): void {
    this.stamina = Math.max(0, this.stamina - amount);
    this.staminaDelay = STAMINA_DELAY;
    if (this.stamina <= 0) this.exhausted = true;
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
    this.staminaDelay = Math.max(0, this.staminaDelay - dt);
    if (this.staminaDelay <= 0) {
      this.stamina = Math.min(STAMINA_MAX, this.stamina + (this.blocking ? STAMINA_REGEN_BLOCKING : STAMINA_REGEN) * dt);
    }
    if (this.exhausted && this.stamina >= EXHAUST_RECOVER) this.exhausted = false;
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

    // Shield: hold to block. Raising it cancels a combo swing once it may chain.
    const wantBlock = input.block && !busy && (!this.move || canAct);
    if (wantBlock && !this.blocking) {
      this.cancelMove();
      this.attackQueued = false;
      this.blocking = true;
      this.blockTime = 0;
      this.animator.play('block', { fade: 0.08, duration: 0.3 });
    } else if (!wantBlock && this.blocking && this.staggerTimer <= 0) {
      this.blocking = false;
    }
    if (this.blocking) this.blockTime += dt;

    if (input.wasPressed('dodge') && !this.exhausted && this.staggerTimer <= 0 && this.dodgeTimer <= 0 && this.dodgeCooldown <= 0 && !this.move?.iframes) {
      this.cancelMove();
      this.blocking = false;
      this.useStamina(DODGE_STAMINA);
      this.dodgeTimer = DODGE_TIME;
      if (wishLen > 0.1) this.dodgeDir.copy(wish).normalize();
      else this.dodgeDir.set(Math.sin(this.facing), 0, Math.cos(this.facing));
      this.facing = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
      this.animator.play('roll', { fade: 0.06, duration: DODGE_TIME + 0.1 });
    }

    if (input.wasPressed('attack') && !this.blocking) this.attackQueued = true;
    for (const skill of ['skill1', 'skill2', 'ultimate'] as SkillName[]) {
      if (!input.wasPressed(skill) || !canAct || this.blocking || this.cooldowns[skill] > 0) continue;
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
    } else if (this.blocking) {
      // Shield up: slow step, keep facing the target (or the current direction).
      const target = wishLen > 0.05 ? wish.clone().normalize().multiplyScalar(BLOCK_SPEED * wishLen) : new THREE.Vector3();
      this.velocity.lerp(target, 1 - Math.exp(-ACCEL * dt));
      if (this.lockTarget) {
        const want = Math.atan2(this.lockTarget.position.x - this.position.x, this.lockTarget.position.z - this.position.z);
        this.facing = dampAngle(this.facing, want, TURN_SPEED, dt);
      }
      if (this.blockTime > 0.25) this.animator.play('blockIdle', { fade: 0.15 });
    } else {
      const sprinting = input.sprint && !this.exhausted && wishLen > 0.05;
      if (sprinting) this.useStamina(SPRINT_STAMINA * dt);
      let speed = sprinting ? SPRINT_SPEED : wishLen > 0.6 ? RUN_SPEED : WALK_SPEED;
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
    const from = move.clipFrom ?? 0;
    const span = (move.clipTo ?? 1) - from;
    this.animator.play(move.clip, { fade: 0.06, duration: move.duration / span, from });
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
      // Counter-attacks on a parried enemy hit harder.
      const { amount, crit } = rollDamage(this.stats, e.stats, move.mult * (e.staggered ? 1.5 : 1));
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
