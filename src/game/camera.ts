import * as THREE from 'three/webgpu';
import type { Input } from '../input/input';
import { heightAt } from './terrain';

const MIN_DIST = 2.2;
const MAX_DIST = 10;
const MIN_PITCH = -0.35;
const MAX_PITCH = 1.15;
const COLLISION_MARGIN = 0.35;

/**
 * Third-person orbit camera. `yaw` is the orbit angle around the target
 * (camera sits at target + (sin yaw, ·, cos yaw) * distance). The boom is
 * shortened when scenery gets between the camera and the player.
 */
export class ThirdPersonCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0.32;
  distance = 5.5;
  /** Extra distance applied while locked on (Phase 3). */
  lockOnPullback = 0;

  private currentDist = 5.5;
  private readonly focus = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  private readonly tmp = new THREE.Vector3();

  constructor(aspect: number, far: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, far);
    this.setAspect(aspect);
  }

  /** Portrait phones get a wider vertical FOV so the player isn't cramped. */
  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.fov = aspect < 1 ? 75 : 55;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, input: Input, target: THREE.Vector3, eyeHeight: number, blockers: THREE.Object3D[]): void {
    this.yaw -= input.look.x;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.look.y, MIN_PITCH, MAX_PITCH);
    if (input.zoom) this.distance = THREE.MathUtils.clamp(this.distance + input.zoom * 0.6, MIN_DIST, MAX_DIST);

    // Smooth focus so the camera doesn't jitter with footsteps.
    const goal = this.tmp.set(target.x, target.y + eyeHeight, target.z);
    this.focus.lerp(goal, 1 - Math.exp(-14 * dt));
    if (this.focus.distanceToSquared(goal) > 25) this.focus.copy(goal);

    const want = this.distance + this.lockOnPullback;
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );

    // Wall avoidance: snap in immediately, ease back out.
    let allowed = want;
    this.ray.set(this.focus, dir);
    this.ray.far = want + COLLISION_MARGIN;
    const hit = this.ray.intersectObjects(blockers, true)[0];
    if (hit) allowed = Math.max(0.6, hit.distance - COLLISION_MARGIN);
    this.currentDist = allowed < this.currentDist
      ? allowed
      : THREE.MathUtils.lerp(this.currentDist, allowed, 1 - Math.exp(-4 * dt));

    const cam = this.camera.position.copy(this.focus).addScaledVector(dir, this.currentDist);
    // Never dip below the terrain.
    const ground = heightAt(cam.x, cam.z) + 0.4;
    if (cam.y < ground) cam.y = ground;
    this.camera.lookAt(this.focus);
  }

  snapTo(target: THREE.Vector3, eyeHeight: number): void {
    this.focus.set(target.x, target.y + eyeHeight, target.z);
  }
}
