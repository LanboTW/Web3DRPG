import * as THREE from 'three/webgpu';

interface Effect {
  obj: THREE.Mesh;
  age: number;
  life: number;
  update(t: number): void;
}

/** Short-lived additive flashes: hit sparks, skill rings, explosions. */
export class Vfx {
  private effects: Effect[] = [];
  private sparkGeo = new THREE.IcosahedronGeometry(0.12, 0);
  private ringGeo = new THREE.RingGeometry(0.85, 1, 48);
  private sphereGeo = new THREE.SphereGeometry(1, 24, 16);

  constructor(private scene: THREE.Scene) {
    this.ringGeo.rotateX(-Math.PI / 2);
  }

  private material(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
  }

  private add(obj: THREE.Mesh, life: number, update: (t: number) => void): void {
    this.scene.add(obj);
    this.effects.push({ obj, age: 0, life, update });
  }

  spark(pos: THREE.Vector3, color = 0xffd27a, count = 6): void {
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.sparkGeo, this.material(color));
      m.position.copy(pos);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(3 + Math.random() * 3);
      this.add(m, 0.3, (t) => {
        m.position.addScaledVector(v, 1 / 60);
        m.scale.setScalar(1 - t);
        (m.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      });
    }
  }

  ring(pos: THREE.Vector3, radius: number, color: number, life = 0.45): void {
    const m = new THREE.Mesh(this.ringGeo, this.material(color));
    m.position.copy(pos).setY(pos.y + 0.15);
    this.add(m, life, (t) => {
      m.scale.setScalar(radius * (0.3 + 0.7 * Math.sqrt(t)));
      (m.material as THREE.MeshBasicMaterial).opacity = 1 - t;
    });
  }

  burst(pos: THREE.Vector3, radius: number, color: number, life = 0.6): void {
    const m = new THREE.Mesh(this.sphereGeo, this.material(color));
    m.position.copy(pos);
    this.add(m, life, (t) => {
      m.scale.setScalar(radius * (0.2 + 0.8 * Math.sqrt(t)));
      (m.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t);
    });
    this.ring(pos, radius * 1.1, color, life);
  }

  update(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.age += dt;
      const t = Math.min(1, e.age / e.life);
      e.update(t);
      if (t >= 1) {
        this.scene.remove(e.obj);
        (e.obj.material as THREE.Material).dispose();
        this.effects.splice(i, 1);
      }
    }
  }
}
