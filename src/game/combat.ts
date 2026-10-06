import * as THREE from 'three/webgpu';

export interface Stats {
  maxHp: number;
  atk: number;
  def: number;
  critChance: number;
}

/** Anything that can be hit: the player and every enemy. */
export interface Combatant {
  readonly position: THREE.Vector3;
  readonly radius: number;
  hp: number;
  stats: Stats;
  get alive(): boolean;
  /** Returns the damage actually dealt (0 if ignored, e.g. i-frames). */
  receiveHit(hit: HitInfo): number;
}

export interface HitInfo {
  amount: number;
  crit: boolean;
  from: THREE.Vector3;
  /** Knockback strength in m/s. */
  knockback: number;
  heavy: boolean;
}

export function rollDamage(attacker: Stats, defender: Stats, multiplier: number): { amount: number; crit: boolean } {
  const crit = Math.random() < attacker.critChance;
  const raw = attacker.atk * multiplier * (0.9 + Math.random() * 0.2) * (crit ? 1.6 : 1);
  return { amount: Math.max(1, Math.round(raw - defender.def * 0.5)), crit };
}

/** Targets within `range` of `origin` and inside the frontal arc around `facing`. */
export function inArc<T extends Combatant>(origin: THREE.Vector3, facing: number, range: number, arcDegrees: number, targets: Iterable<T>): T[] {
  const out: T[] = [];
  const fx = Math.sin(facing);
  const fz = Math.cos(facing);
  const cosHalf = Math.cos(THREE.MathUtils.degToRad(arcDegrees / 2));
  for (const t of targets) {
    if (!t.alive) continue;
    const dx = t.position.x - origin.x;
    const dz = t.position.z - origin.z;
    const d = Math.hypot(dx, dz);
    if (d - t.radius > range) continue;
    if (d < 0.6 || (dx * fx + dz * fz) / d >= cosHalf) out.push(t);
  }
  return out;
}

export function inRadius<T extends Combatant>(origin: THREE.Vector3, range: number, targets: Iterable<T>): T[] {
  const out: T[] = [];
  for (const t of targets) {
    if (t.alive && Math.hypot(t.position.x - origin.x, t.position.z - origin.z) - t.radius <= range) out.push(t);
  }
  return out;
}

export interface CombatEvents {
  damage(target: Combatant, amount: number, crit: boolean, byPlayer: boolean): void;
  hitStop(seconds: number): void;
  shake(strength: number): void;
}
