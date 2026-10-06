import * as THREE from 'three/webgpu';
import type { CharacterModel } from './character';
import type { ColliderWorld } from './colliders';
import type { CombatEvents } from './combat';
import { Enemy, ENEMY_DEFS, type EnemyKind } from './enemy';
import type { Player } from './player';
import { BANDIT_CAMP, RUINS_CENTER } from './terrain';

const RESPAWN_SECONDS = 60;
const CORPSE_SECONDS = 4;
/** Enemies farther than this from the player skip AI and animation. */
const SIMULATION_RANGE = 70;

/** Spawn table: [kind, x, z]. */
function spawnTable(): [EnemyKind, number, number][] {
  const cx = BANDIT_CAMP.x;
  const cz = BANDIT_CAMP.y;
  const rx = RUINS_CENTER.x;
  const rz = RUINS_CENTER.y;
  return [
    // Bandits on the road and in their forest camp.
    ['bandit', -6, -18], ['bandit', -2, -22],
    ['bandit', cx - 4, cz + 3], ['bandit', cx + 4, cz - 2], ['bandit', cx + 1, cz + 6], ['bandit', cx - 6, cz - 5],
    // Skeletons haunting the approach to the ruins.
    ['skeleton', rx - 10, rz + 34], ['skeleton', rx + 8, rz + 30], ['skeleton', rx - 16, rz + 12],
    ['skeleton', rx + 17, rz + 10], ['skeleton', rx - 4, rz + 16],
    // The undead knight guards the altar.
    ['knight', rx, rz - 2],
  ];
}

export class EnemyManager {
  readonly list: Enemy[] = [];
  readonly group = new THREE.Group();

  constructor(models: Record<EnemyKind, CharacterModel>) {
    for (const [kind, x, z] of spawnTable()) {
      const e = new Enemy(ENEMY_DEFS[kind], models[kind], x, z);
      this.list.push(e);
      this.group.add(e.root);
    }
  }

  get boss(): Enemy | undefined {
    return this.list.find((e) => e.def.boss);
  }

  update(dt: number, player: Player, colliders: ColliderWorld, events: CombatEvents): void {
    for (const e of this.list) {
      const far = e.position.distanceTo(player.position) > SIMULATION_RANGE;
      if (!e.alive) {
        e.deadTime += far ? dt : 0;
        if (!far) e.update(dt, player, colliders, events);
        if (e.deadTime > CORPSE_SECONDS) e.root.visible = false;
        // Bosses stay dead; regular enemies return once the player has left.
        if (!e.def.boss && e.deadTime > RESPAWN_SECONDS && e.position.distanceTo(player.position) > 35) e.respawn();
        continue;
      }
      e.root.visible = !far;
      if (far) continue;
      e.update(dt, player, colliders, events);
    }
    // Keep enemies from stacking on top of each other.
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this.list.length; j++) {
        const b = this.list[j];
        if (!b.alive) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const d = Math.hypot(dx, dz);
        const min = a.radius + b.radius;
        if (d < min && d > 1e-4) {
          const push = (min - d) / 2;
          a.position.x -= (dx / d) * push;
          a.position.z -= (dz / d) * push;
          b.position.x += (dx / d) * push;
          b.position.z += (dz / d) * push;
        }
      }
    }
  }
}
