import * as THREE from 'three/webgpu';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Animator } from './animator';
import { createShield, createSword, placeShield, placeSword, type CharacterModel } from './character';
import type { ColliderWorld } from './colliders';
import { rollDamage, type CombatEvents, type Combatant, type HitInfo, type Stats } from './combat';
import { groundAt } from './terrain';
import { ITEMS } from '../rpg/items';

export type EnemyKind = 'bandit' | 'skeleton' | 'knight';

export interface EnemyDef {
  kind: EnemyKind;
  nameKey: 'enemy.bandit' | 'enemy.skeleton' | 'enemy.knight';
  stats: Stats;
  scale: number;
  walkSpeed: number;
  runSpeed: number;
  aggroRange: number;
  leashRange: number;
  attackRange: number;
  attackCooldown: number;
  /** Seconds of wind-up before the blow lands (the telegraph). */
  attackWindup: number;
  attackDuration: number;
  xp: number;
  gold: [number, number];
  boss?: boolean;
}

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = {
  bandit: {
    kind: 'bandit', nameKey: 'enemy.bandit', scale: 1,
    stats: { maxHp: 70, atk: 9, def: 3, critChance: 0.05 },
    walkSpeed: 1.6, runSpeed: 4.2, aggroRange: 12, leashRange: 30, attackRange: 1.9,
    attackCooldown: 2.1, attackWindup: 0.5, attackDuration: 1.1, xp: 20, gold: [4, 12],
  },
  skeleton: {
    kind: 'skeleton', nameKey: 'enemy.skeleton', scale: 1,
    stats: { maxHp: 55, atk: 11, def: 2, critChance: 0.05 },
    walkSpeed: 1.3, runSpeed: 3.6, aggroRange: 15, leashRange: 28, attackRange: 1.9,
    attackCooldown: 1.9, attackWindup: 0.6, attackDuration: 1.2, xp: 25, gold: [2, 8],
  },
  knight: {
    kind: 'knight', nameKey: 'enemy.knight', scale: 1.3, boss: true,
    stats: { maxHp: 900, atk: 24, def: 8, critChance: 0.1 },
    walkSpeed: 1.6, runSpeed: 4.0, aggroRange: 16, leashRange: 40, attackRange: 2.8,
    attackCooldown: 1.4, attackWindup: 0.7, attackDuration: 1.4, xp: 400, gold: [150, 200],
  },
};

type State = 'idle' | 'chase' | 'attack' | 'hit' | 'return' | 'dead';

export class Enemy implements Combatant {
  readonly root = new THREE.Group();
  readonly position = this.root.position;
  readonly radius: number;
  readonly def: EnemyDef;
  readonly home: THREE.Vector3;
  stats: Stats;
  hp: number;
  /** Seconds since death; used for fade-out and respawn. */
  deadTime = 0;
  /** Set when hurt or aggroed so the HUD shows the health bar. */
  engaged = false;
  /** Boss phase 2 below half health. */
  enraged = false;

  private animator: Animator;
  private state: State = 'idle';
  private stateTime = 0;
  private cooldown = 0;
  private struck = false;
  private heavyAttack = false;
  private facing = Math.random() * Math.PI * 2;
  private knock = new THREE.Vector3();
  private materials: THREE.MeshStandardMaterial[] = [];
  private flash = 0;
  /** How long the current 'hit' state lasts (longer after being parried). */
  private stun = 0.45;

  constructor(def: EnemyDef, model: CharacterModel, x: number, z: number) {
    this.def = def;
    this.stats = { ...def.stats };
    this.hp = def.stats.maxHp;
    this.radius = 0.45 * def.scale;
    this.home = new THREE.Vector3(x, groundAt(x, z), z);
    this.position.copy(this.home);

    const body = SkeletonUtils.clone(model.root);
    body.scale.setScalar(def.scale);
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
        const c = (m as THREE.MeshStandardMaterial).clone();
        styleMaterial(def.kind, `${mesh.name} ${c.name}`, c);
        // Glowing eyes keep their own emissive; everything else flashes on hit.
        if (c.emissiveIntensity === 0) this.materials.push(c);
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
    });
    this.root.add(body);
    this.animator = new Animator(body, model.clips);
    this.animator.play('idle', { fade: 0 });
    this.animator.mixer.setTime(Math.random() * 2);

    let hand: THREE.Object3D | undefined;
    let forearm: THREE.Object3D | undefined;
    body.traverse((o) => {
      if (o.name === 'hand_r') hand = o;
      if (o.name === 'lowerarm_l') forearm = o;
    });
    // The knight carries the shield it drops when defeated.
    const shieldLook = def.kind === 'knight' ? ITEMS.knight_shield.shield : undefined;
    if (forearm && shieldLook) {
      const shield = createShield(shieldLook);
      placeShield(shield);
      forearm.add(shield);
    }
    if (hand) {
      const weapon = createSword(def.kind === 'knight' ? 1.5 : def.kind === 'skeleton' ? 0.9 : 1);
      placeSword(weapon);
      hand.add(weapon);
    }
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  /** World position of the chest, for health bars and lock-on. */
  chest(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + 1.3 * this.def.scale);
  }

  receiveHit(hit: HitInfo): number {
    if (!this.alive) return 0;
    this.hp = Math.max(0, this.hp - hit.amount);
    this.engaged = true;
    this.flash = 0.15;
    const away = new THREE.Vector3(this.position.x - hit.from.x, 0, this.position.z - hit.from.z).normalize();
    // Bosses shrug off knockback and only flinch from heavy blows.
    const poise = this.def.boss ? 0.15 : 1;
    this.knock.copy(away).multiplyScalar(hit.knockback * poise);
    if (this.hp <= 0) {
      this.setState('dead');
      this.animator.play('death', { fade: 0.1 });
    } else if (!this.def.boss || hit.heavy) {
      if (this.state !== 'attack' || !this.def.boss) {
        this.setState('hit');
        this.stun = 0.45;
        this.animator.play('hit', { fade: 0.05, duration: 0.45 });
      }
    }
    if (this.def.boss && !this.enraged && this.hp < this.stats.maxHp / 2) {
      this.enraged = true;
      this.stats.atk *= 1.25;
    }
    return hit.amount;
  }

  /** The player's perfect parry: the attack is knocked away, leaving an opening. */
  parried(): void {
    if (!this.alive) return;
    this.engaged = true;
    this.flash = 0.25;
    this.setState('hit');
    this.stun = this.def.boss ? 1.0 : 1.4;
    this.cooldown = Math.max(this.cooldown, this.stun + 0.5);
    this.animator.play('hit', { fade: 0.04, duration: 0.7 });
  }

  /** True while staggered by a parry: the window for a counter-attack. */
  get staggered(): boolean {
    return this.state === 'hit' && this.stun > 0.5;
  }

  private setState(s: State): void {
    this.state = s;
    this.stateTime = 0;
  }

  update(dt: number, target: Combatant & { invulnerable: boolean }, colliders: ColliderWorld, events: CombatEvents): void {
    this.stateTime += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.flash = Math.max(0, this.flash - dt);
    for (const m of this.materials) m.emissiveIntensity = this.flash > 0 ? 1 : 0;

    if (this.state === 'dead') {
      this.deadTime += dt;
      this.animator.update(dt);
      return;
    }

    const toTarget = new THREE.Vector3(target.position.x - this.position.x, 0, target.position.z - this.position.z);
    const dist = toTarget.length();
    const fromHome = Math.hypot(this.position.x - this.home.x, this.position.z - this.home.z);
    const def = this.def;
    let moveSpeed = 0;
    let moveDir: THREE.Vector3 | null = null;

    switch (this.state) {
      case 'idle':
        this.animator.play('idle');
        if (target.alive && dist < def.aggroRange) {
          this.engaged = true;
          this.setState('chase');
        }
        break;
      case 'chase':
        if (!target.alive || fromHome > def.leashRange) {
          this.setState('return');
          break;
        }
        if (dist <= def.attackRange && this.cooldown <= 0) {
          this.startAttack();
          break;
        }
        moveDir = toTarget.normalize();
        moveSpeed = dist > def.attackRange * 0.9 ? def.runSpeed * (this.enraged ? 1.2 : 1) : 0;
        this.animator.play(moveSpeed > 0 ? 'run' : 'idle');
        break;
      case 'attack': {
        // Track the target during wind-up only, so the blow can be dodged.
        if (this.stateTime < def.attackWindup * 0.7) this.faceTowards(toTarget, dt, 6);
        const windup = this.enraged ? def.attackWindup * 0.75 : def.attackWindup;
        if (!this.struck && this.stateTime >= windup) {
          this.struck = true;
          this.strike(target, events);
        }
        if (this.stateTime >= (this.enraged ? def.attackDuration * 0.8 : def.attackDuration)) {
          this.cooldown = def.attackCooldown * (this.enraged ? 0.7 : 1) * (0.8 + Math.random() * 0.4);
          this.setState('chase');
        }
        break;
      }
      case 'hit':
        if (this.stateTime > this.stun) this.setState('chase');
        break;
      case 'return':
        if (fromHome < 1) {
          this.hp = this.stats.maxHp;
          this.engaged = false;
          this.setState('idle');
          break;
        }
        moveDir = new THREE.Vector3(this.home.x - this.position.x, 0, this.home.z - this.position.z).normalize();
        moveSpeed = def.walkSpeed * 1.5;
        this.animator.play('walk');
        if (target.alive && dist < def.aggroRange * 0.6) this.setState('chase');
        break;
    }

    if (moveDir) {
      this.faceTowards(moveDir, dt, 8);
      this.position.addScaledVector(moveDir, moveSpeed * dt);
    }
    this.position.addScaledVector(this.knock, dt);
    this.knock.multiplyScalar(Math.exp(-8 * dt));
    colliders.resolve(this.position, this.radius);
    this.position.y = groundAt(this.position.x, this.position.z);
    this.root.rotation.y = this.facing;
    this.animator.update(dt);
  }

  private startAttack(): void {
    this.setState('attack');
    this.struck = false;
    // Bosses mix in a heavy overhead slam when enraged.
    this.heavyAttack = this.def.boss === true && this.enraged && Math.random() < 0.4;
    const clip = this.heavyAttack || Math.random() < 0.7 ? 'attack' : 'attack2';
    this.animator.play(clip, { fade: 0.1, duration: this.enraged ? this.def.attackDuration * 0.8 : this.def.attackDuration });
  }

  private strike(target: Combatant & { invulnerable: boolean }, events: CombatEvents): void {
    const def = this.def;
    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const d = Math.hypot(dx, dz);
    const facingDot = (dx * Math.sin(this.facing) + dz * Math.cos(this.facing)) / Math.max(d, 0.001);
    const reach = def.attackRange + 0.4 + (this.heavyAttack ? 1.5 : 0);
    const inArc = this.heavyAttack ? d < reach : d < reach && facingDot > 0.35;
    if (this.heavyAttack) events.shake(0.5);
    if (!inArc || !target.alive || target.invulnerable) return;
    const { amount, crit } = rollDamage(this.stats, target.stats, this.heavyAttack ? 1.8 : 1);
    const dealt = target.receiveHit({ amount, crit, from: this.position, knockback: this.heavyAttack ? 9 : 4, heavy: this.heavyAttack, attacker: this });
    if (dealt > 0) {
      events.damage(target, dealt, crit, false);
      events.shake(this.heavyAttack ? 0.6 : 0.25);
    }
  }

  private faceTowards(dir: THREE.Vector3, dt: number, rate: number): void {
    const want = Math.atan2(dir.x, dir.z);
    let diff = want - this.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.facing += diff * (1 - Math.exp(-rate * dt));
  }

  /** Brings a dead enemy back at its home position. */
  respawn(): void {
    this.hp = this.stats.maxHp;
    this.deadTime = 0;
    this.engaged = false;
    this.enraged = false;
    this.stats = { ...this.def.stats };
    this.position.copy(this.home);
    this.root.visible = true;
    this.setState('idle');
    this.animator.play('idle', { fade: 0 });
  }

  /** Whether this enemy is winding up an attack (for the HUD telegraph). */
  get telegraphing(): boolean {
    return this.state === 'attack' && !this.struck;
  }
}

/** Gives each enemy type its look by restyling the shared MPFB materials. */
function styleMaterial(kind: EnemyKind, meshName: string, m: THREE.MeshStandardMaterial): void {
  m.emissive = new THREE.Color(0xff3020);
  m.emissiveIntensity = 0;
  if (kind === 'skeleton') {
    if (/body/i.test(meshName)) {
      // Desiccated, grey-green undead flesh over the base skin texture.
      m.color.set(0x7d8a78);
      m.roughness = 0.8;
    } else if (/low-poly|eye/i.test(meshName)) {
      m.map = null;
      m.color.set(0x000000);
      m.emissive.set(0xff4a1a);
      m.emissiveIntensity = 2;
    } else {
      m.color.multiplyScalar(0.45);
    }
  } else if (kind === 'knight') {
    if (/worksuit|boots/i.test(meshName)) {
      m.color.set(0x34363c);
      m.metalness = 0.9;
      m.roughness = 0.38;
    } else if (/body/i.test(meshName)) {
      m.color.set(0x8d97a6);
    } else if (/low-poly|eye/i.test(meshName)) {
      m.map = null;
      m.color.set(0x000000);
      m.emissive.set(0x5ad1ff);
      m.emissiveIntensity = 2;
    }
  }
  m.needsUpdate = true;
}
