import * as THREE from 'three/webgpu';
import { Animator } from './animator';
import type { CharacterModel } from './character';
import type { ColliderWorld } from './colliders';
import { groundAt } from './terrain';
import type { NpcId } from '../rpg/quests';

export const INTERACT_RANGE = 3;

/** A friendly villager that idles, turns to face the player and talks. */
export class Npc {
  readonly root = new THREE.Group();
  readonly position = this.root.position;
  private animator: Animator;
  private facing: number;
  private baseFacing: number;
  talking = false;

  constructor(readonly id: NpcId, model: CharacterModel, x: number, z: number, facing: number, colliders: ColliderWorld) {
    this.position.set(x, groundAt(x, z), z);
    this.facing = this.baseFacing = facing;
    this.root.rotation.y = facing;
    this.root.add(model.root);
    this.animator = new Animator(model.root, model.clips);
    this.animator.play('idle', { fade: 0 });
    this.animator.mixer.setTime(Math.random() * 3);
    colliders.add({ kind: 'circle', x, z, r: 0.45 });
  }

  /** World position of the head, for name tags and prompts. */
  head(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + 2.05);
  }

  update(dt: number, player: THREE.Vector3): void {
    const d = this.position.distanceTo(player);
    const want = d < 6 ? Math.atan2(player.x - this.position.x, player.z - this.position.z) : this.baseFacing;
    let diff = want - this.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.facing += diff * (1 - Math.exp(-4 * dt));
    this.root.rotation.y = this.facing;
    this.animator.play(this.talking ? 'talk' : 'idle', { fade: 0.4 });
    if (d < 80) this.animator.update(dt);
  }
}
