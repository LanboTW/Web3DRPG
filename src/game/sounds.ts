import * as THREE from 'three/webgpu';
import { audio } from './audio';
import type { EnemyKind } from './enemy';
import { bridgeDeck, RUINS_CENTER, RUINS_RADIUS } from './terrain';

/** Game-level sound cues built from the raw samples in audio.ts. */

type Surface = 'grass' | 'wood' | 'stone';

export function surfaceAt(x: number, z: number): Surface {
  if (bridgeDeck(x, z) > -Infinity) return 'wood';
  if (Math.hypot(x - RUINS_CENTER.x, z - RUINS_CENTER.y) < RUINS_RADIUS - 4) return 'stone';
  return 'grass';
}

export function footstep(at: THREE.Vector3, volume = 0.5, rate = 1): void {
  audio.play(`step_${surfaceAt(at.x, at.z)}`, { at, volume, rate, jitter: 0.1 });
}

/** The player's sword landing on an enemy. */
export function swordHit(kind: EnemyKind, at: THREE.Vector3, crit: boolean, heavy: boolean): void {
  const v = crit || heavy ? 1 : 0.8;
  if (kind === 'skeleton') {
    audio.play('bone', { at, volume: v });
    audio.play('rattle', { at, volume: 0.7 });
  } else if (kind === 'knight') {
    audio.play('plate', { at, volume: v, rate: 0.85 });
  } else {
    audio.play('flesh', { at, volume: v });
    audio.play('slice', { at, volume: 0.6 });
  }
  if (heavy) audio.play('body_hit', { at, volume: 0.6, rate: 0.8 });
}

export function enemyDeath(kind: EnemyKind, at: THREE.Vector3): void {
  const p = at.clone();
  if (kind === 'skeleton') {
    // The bones collapse in a clatter.
    for (let i = 0; i < 5; i++) audio.play('rattle', { at: p, delay: 0.25 + i * 0.07 + Math.random() * 0.05, volume: 0.9, rate: 0.9 });
    audio.play('bone', { at: p, delay: 0.55, rate: 0.8 });
  } else if (kind === 'knight') {
    audio.play('plate_heavy', { at: p, delay: 0.7, rate: 0.8 });
    audio.play('metal_heavy', { at: p, delay: 0.85, volume: 0.6, rate: 0.7 });
  } else {
    audio.play('body_fall', { at: p, delay: 0.6 });
  }
}

/** The enemy's own movement noise, one call per stride. */
export function enemyStep(kind: EnemyKind, at: THREE.Vector3): void {
  if (kind === 'skeleton') {
    audio.play('rattle', { at, volume: 0.35, rate: 1.1, jitter: 0.15 });
  } else if (kind === 'knight') {
    footstep(at, 0.7, 0.75);
    audio.play('plate', { at, volume: 0.18, rate: 1.3 });
  } else {
    footstep(at, 0.35);
  }
}

export function enemySwing(kind: EnemyKind, at: THREE.Vector3, heavy: boolean, delay: number): void {
  audio.play(heavy || kind === 'knight' ? 'swing_heavy' : 'swing', { at, delay, rate: kind === 'knight' ? 0.75 : 0.9 });
}
