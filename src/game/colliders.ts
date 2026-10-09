/** Static 2D (XZ-plane) colliders; the world is mostly flat-ish so this is enough. */
export interface CircleCollider {
  kind: 'circle';
  x: number;
  z: number;
  r: number;
}

/** Oriented box: half-width along local X, half-depth along local Z, rotated by `rot` around Y. */
export interface BoxCollider {
  kind: 'box';
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
}

export type Collider = CircleCollider | BoxCollider;

const CELL = 16;

/** Uniform grid so each query only checks nearby colliders. */
export class ColliderWorld {
  private cells = new Map<string, Collider[]>();

  add(c: Collider): void {
    const reach = c.kind === 'circle' ? c.r : Math.hypot(c.hw, c.hd);
    for (let gx = Math.floor((c.x - reach) / CELL); gx <= Math.floor((c.x + reach) / CELL); gx++) {
      for (let gz = Math.floor((c.z - reach) / CELL); gz <= Math.floor((c.z + reach) / CELL); gz++) {
        const key = `${gx},${gz}`;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(c);
      }
    }
  }

  /** Every collider, for the debug overlay. */
  all(): Collider[] {
    const set = new Set<Collider>();
    for (const list of this.cells.values()) for (const c of list) set.add(c);
    return [...set];
  }

  /**
   * Pushes a circle of radius `r` at (pos.x, pos.z) out of all colliders. Mutates pos.
   * Checks the 3x3 neighbouring cells and iterates so that being wedged between two
   * obstacles settles instead of jittering through one of them.
   */
  resolve(pos: { x: number; z: number }, r: number): void {
    const gx = Math.floor(pos.x / CELL);
    const gz = Math.floor(pos.z / CELL);
    const near: Collider[] = [];
    for (let ix = gx - 1; ix <= gx + 1; ix++) {
      for (let iz = gz - 1; iz <= gz + 1; iz++) {
        const list = this.cells.get(`${ix},${iz}`);
        if (list) for (const c of list) if (!near.includes(c)) near.push(c);
      }
    }
    if (!near.length) return;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of near) moved = pushOut(c, pos, r) || moved;
      if (!moved) break;
    }
  }
}

function pushOut(c: Collider, pos: { x: number; z: number }, r: number): boolean {
  if (c.kind === 'circle') {
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const d = Math.hypot(dx, dz);
    const min = c.r + r;
    if (d < min && d > 1e-5) {
      pos.x = c.x + (dx / d) * min;
      pos.z = c.z + (dz / d) * min;
      return true;
    }
    return false;
  }
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  const dx = pos.x - c.x;
  const dz = pos.z - c.z;
  if (Math.abs(dx) > c.hw + c.hd + r || Math.abs(dz) > c.hw + c.hd + r) return false;
  // World → box local (inverse rotation about Y).
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const cx = Math.max(-c.hw, Math.min(c.hw, lx));
  const cz = Math.max(-c.hd, Math.min(c.hd, lz));
  const ox = lx - cx;
  const oz = lz - cz;
  const d = Math.hypot(ox, oz);
  let nx: number;
  let nz: number;
  if (d > 1e-5) {
    if (d >= r) return false;
    nx = cx + (ox / d) * r;
    nz = cz + (oz / d) * r;
  } else {
    // Centre inside the box: exit through the nearest face.
    const px = c.hw - Math.abs(lx);
    const pz = c.hd - Math.abs(lz);
    if (px < pz) {
      nx = Math.sign(lx || 1) * (c.hw + r);
      nz = lz;
    } else {
      nx = lx;
      nz = Math.sign(lz || 1) * (c.hd + r);
    }
  }
  // Local → world.
  pos.x = c.x + nx * cos + nz * sin;
  pos.z = c.z - nx * sin + nz * cos;
  return true;
}
