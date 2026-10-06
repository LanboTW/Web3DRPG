import * as THREE from 'three/webgpu';
import type { Input } from '../input/input';
import type { ColliderWorld } from './colliders';
import { heightAt, PLAY_HALF } from './terrain';

const WALK_SPEED = 3.2;
const RUN_SPEED = 6.8;
const ACCEL = 14;
const TURN_SPEED = 12;
const RADIUS = 0.4;
const DODGE_TIME = 0.42;
const DODGE_SPEED = 9;
const DODGE_COOLDOWN = 0.25;
const ATTACK_TIME = 0.35;

/**
 * Phase 1 stand-in for the swordswoman: a simple jointed figure so movement,
 * camera and controls can be tested before the Blender pipeline exists.
 */
export class Player {
  readonly root = new THREE.Group();
  readonly position = this.root.position;
  readonly velocity = new THREE.Vector3();
  /** Facing angle around Y; 0 looks down +Z. */
  facing = Math.PI;
  /** Height of the camera look-at point above the feet. */
  readonly eyeHeight = 1.5;

  private dodgeTimer = 0;
  private dodgeCooldown = 0;
  private dodgeDir = new THREE.Vector3();
  private attackTimer = 0;
  private walkPhase = 0;
  private parts: Record<'body' | 'legL' | 'legR' | 'armL' | 'armR', THREE.Object3D>;

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a988, roughness: 0.6 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x5a2e2a, roughness: 0.8 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x3b2a1d, roughness: 0.7 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.25, metalness: 0.9 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x2b1a12, roughness: 0.7 });

    const body = new THREE.Group();
    body.position.y = 0.95;
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 6, 12), cloth);
    torso.position.y = 0.3;
    torso.scale.set(1, 1, 0.75);
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.21, 0.08, 12), leather);
    belt.position.y = 0.06;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 16), skin);
    head.position.y = 0.78;
    head.scale.set(0.9, 1.05, 0.95);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.6), hair);
    hairCap.position.set(0, 0.8, -0.01);
    const ponytail = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.25, 4, 8), hair);
    ponytail.position.set(0, 0.68, -0.15);
    ponytail.rotation.x = 0.4;
    body.add(torso, belt, head, hairCap, ponytail);

    const limb = (len: number, r: number, mat: THREE.Material) => {
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat);
      mesh.position.y = -len / 2 - r;
      pivot.add(mesh);
      return pivot;
    };
    const legL = limb(0.7, 0.075, leather);
    const legR = limb(0.7, 0.075, leather);
    legL.position.set(-0.1, 0.95, 0);
    legR.position.set(0.1, 0.95, 0);
    const armL = limb(0.5, 0.055, cloth);
    const armR = limb(0.5, 0.055, cloth);
    armL.position.set(-0.27, 1.5, 0);
    armR.position.set(0.27, 1.5, 0);

    // One-handed sword held in the right hand.
    const sword = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.85, 0.012), steel);
    blade.position.y = 0.5;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.04), leather);
    guard.position.y = 0.06;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8), leather);
    sword.add(blade, guard, grip);
    sword.position.y = -0.62;
    sword.rotation.x = Math.PI / 2;
    armR.add(sword);

    this.root.add(body, legL, legR, armL, armR);
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.parts = { body, legL, legR, armL, armR };
  }

  spawn(x: number, z: number): void {
    this.position.set(x, heightAt(x, z), z);
  }

  /** `cameraYaw` is the camera's orbit angle; input is relative to it. */
  update(dt: number, input: Input, cameraYaw: number, colliders: ColliderWorld): void {
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.attackTimer = Math.max(0, this.attackTimer - dt);

    // Camera-relative move direction. Camera sits at yaw, looking toward -yaw.
    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    const wish = new THREE.Vector3(fx * input.move.y - fz * input.move.x, 0, fz * input.move.y + fx * input.move.x);
    const wishLen = Math.min(1, wish.length());

    if (input.wasPressed('dodge') && this.dodgeTimer <= 0 && this.dodgeCooldown <= 0) {
      this.dodgeTimer = DODGE_TIME;
      if (wishLen > 0.1) this.dodgeDir.copy(wish).normalize();
      else this.dodgeDir.set(-Math.sin(this.facing), 0, -Math.cos(this.facing)); // backstep
      this.facing = wishLen > 0.1 ? Math.atan2(this.dodgeDir.x, this.dodgeDir.z) : this.facing;
    }
    if (input.wasPressed('attack') && this.dodgeTimer <= 0 && this.attackTimer <= 0) {
      this.attackTimer = ATTACK_TIME;
    }

    if (this.dodgeTimer > 0) {
      this.dodgeTimer -= dt;
      const k = Math.max(0, this.dodgeTimer / DODGE_TIME);
      this.velocity.copy(this.dodgeDir).multiplyScalar(DODGE_SPEED * (0.4 + 0.6 * k));
      if (this.dodgeTimer <= 0) this.dodgeCooldown = DODGE_COOLDOWN;
    } else {
      const speed = (input.sprint ? RUN_SPEED : WALK_SPEED) * (this.attackTimer > 0 ? 0.3 : 1);
      const target = wish.clone().normalize().multiplyScalar(wishLen * speed);
      this.velocity.lerp(target, 1 - Math.exp(-ACCEL * dt));
      if (wishLen > 0.05) {
        const want = Math.atan2(wish.x, wish.z);
        this.facing = dampAngle(this.facing, want, TURN_SPEED, dt);
      }
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    colliders.resolve(this.position, RADIUS);
    this.position.x = THREE.MathUtils.clamp(this.position.x, -PLAY_HALF, PLAY_HALF);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -PLAY_HALF, PLAY_HALF);
    this.position.y = heightAt(this.position.x, this.position.z);
    this.root.rotation.y = this.facing;

    this.animate(dt);
  }

  private animate(dt: number): void {
    const { body, legL, legR, armL, armR } = this.parts;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += dt * (4 + speed * 1.6);
    const swing = Math.min(1, speed / RUN_SPEED) * 0.9;
    const s = Math.sin(this.walkPhase);
    legL.rotation.x = s * swing;
    legR.rotation.x = -s * swing;
    armL.rotation.x = -s * swing * 0.7;
    body.position.y = 0.95 + Math.abs(Math.cos(this.walkPhase)) * 0.04 * swing;

    if (this.dodgeTimer > 0) {
      // Roll: tuck and spin forward.
      const t = 1 - this.dodgeTimer / DODGE_TIME;
      body.rotation.x = t * Math.PI * 2;
      body.position.y = 0.6;
    } else {
      body.rotation.x = 0;
    }

    if (this.attackTimer > 0) {
      const t = 1 - this.attackTimer / ATTACK_TIME;
      armR.rotation.x = -2.6 + t * 2.0;
      armR.rotation.z = 0.4 - t * 0.6;
    } else {
      armR.rotation.x = s * swing * 0.7 - 0.25;
      armR.rotation.z = 0;
    }
  }
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return current + diff * (1 - Math.exp(-lambda * dt));
}
