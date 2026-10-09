import * as THREE from 'three/webgpu';
import type { ColliderWorld } from '../game/colliders';
import {
  BANDIT_CAMP, CAMP_RADIUS, POND_CENTER, RUINS_CENTER, RUINS_RADIUS, VILLAGE_CENTER, VILLAGE_RADIUS, WORLD_SIZE,
  heightAt, roadDistance, waterDistance,
} from '../game/terrain';

/** Pixels per metre of the pre-rendered base map. */
const BASE_SCALE = 1.5;
const HALF = WORLD_SIZE / 2;
/** World radius shown by the corner minimap. */
const MINI_RANGE = 60;
const ENEMY_RANGE = 40;

const AREAS: [string, THREE.Vector2][] = [
  ['村莊', VILLAGE_CENTER],
  ['古代廢墟', RUINS_CENTER],
  ['山賊營地', BANDIT_CAMP],
  ['池塘', POND_CENTER],
];

export interface MapMarkers {
  player: THREE.Vector3;
  /** Model facing (radians about Y, 0 = +Z). */
  facing: number;
  npcs: { position: THREE.Vector3; mark: string }[];
  enemies: { position: THREE.Vector3; boss: boolean }[];
  chests: THREE.Vector3[];
  objective: THREE.Vector2 | null;
}

/** Draws the terrain, roads, water and obstacle footprints once into a canvas. */
function renderBase(colliders: ColliderWorld): HTMLCanvasElement {
  const size = Math.round(WORLD_SIZE * BASE_SCALE);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const zone = (x: number, z: number, c: THREE.Vector2, r: number) => Math.hypot(x - c.x, z - c.y) < r;
  for (let py = 0; py < size; py++) {
    const z = py / BASE_SCALE - HALF;
    for (let px = 0; px < size; px++) {
      const x = px / BASE_SCALE - HALF;
      let r: number, g: number, b: number;
      const h = heightAt(x, z);
      const shade = Math.max(0.7, Math.min(1.25, 1 + h * 0.025));
      if (waterDistance(x, z) < 0) {
        [r, g, b] = [58, 104, 136];
      } else if (roadDistance(x, z) < 2.2) {
        [r, g, b] = [176, 150, 106];
      } else if (zone(x, z, RUINS_CENTER, RUINS_RADIUS - 6)) {
        [r, g, b] = [128, 126, 116];
      } else if (zone(x, z, BANDIT_CAMP, CAMP_RADIUS - 2)) {
        [r, g, b] = [118, 98, 70];
      } else if (zone(x, z, VILLAGE_CENTER, VILLAGE_RADIUS - 6)) {
        [r, g, b] = [116, 134, 78];
      } else {
        [r, g, b] = [82, 112, 62];
      }
      const i = (py * size + px) * 4;
      img.data[i] = r * shade;
      img.data[i + 1] = g * shade;
      img.data[i + 2] = b * shade;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Obstacle footprints: buildings and walls as outlined boxes, trees and rocks as dots.
  ctx.setTransform(BASE_SCALE, 0, 0, BASE_SCALE, HALF * BASE_SCALE, HALF * BASE_SCALE);
  for (const c of colliders.all()) {
    if (c.kind === 'box') {
      ctx.save();
      ctx.translate(c.x, c.z);
      ctx.rotate(-c.rot);
      ctx.fillStyle = c.hd < 0.3 ? 'rgba(70,52,34,0.9)' : 'rgba(92,66,44,0.95)';
      ctx.fillRect(-c.hw, -c.hd, c.hw * 2, c.hd * 2);
      if (c.hd >= 0.3) {
        ctx.strokeStyle = 'rgba(230,210,170,0.8)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(-c.hw, -c.hd, c.hw * 2, c.hd * 2);
      }
      ctx.restore();
    } else {
      ctx.beginPath();
      const tree = c.r < 0.7;
      ctx.arc(c.x, c.z, tree ? 1.3 : c.r, 0, Math.PI * 2);
      ctx.fillStyle = tree ? 'rgba(38,66,34,0.75)' : 'rgba(120,118,108,0.6)';
      ctx.fill();
    }
  }
  return canvas;
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  ctx.fillStyle = '#ffcf4a';
  ctx.fill();
  ctx.strokeStyle = '#3a2a08';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, s: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.7, s * 0.75);
  ctx.lineTo(0, s * 0.35);
  ctx.lineTo(-s * 0.7, s * 0.75);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

function chestIcon(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = '#c98a3a';
  ctx.strokeStyle = '#2a1a08';
  ctx.lineWidth = 1;
  ctx.fillRect(x - 4, y - 3, 8, 6);
  ctx.strokeRect(x - 4, y - 3, 8, 6);
}

/**
 * Corner minimap (rotates with the camera) and a full-screen map (north up)
 * opened with M or by clicking the minimap.
 */
export class Minimap {
  private base: HTMLCanvasElement;
  private mini = document.createElement('canvas');
  private miniWrap = document.createElement('div');
  private big = document.createElement('div');
  private bigCanvas = document.createElement('canvas');
  private zoom = 2.2;
  private pan = { x: 0, y: 0 };
  private tick = 0;
  /** Called when the minimap is clicked (opens the big map). */
  onOpen: (() => void) | null = null;

  constructor(colliders: ColliderWorld) {
    this.base = renderBase(colliders);
    this.miniWrap.id = 'minimap';
    this.miniWrap.append(this.mini);
    document.getElementById('hud')!.append(this.miniWrap);
    this.miniWrap.addEventListener('click', () => this.onOpen?.());

    this.big.id = 'bigmap';
    this.big.hidden = true;
    this.big.innerHTML = '<div class="bm-hint">滾輪縮放・拖曳移動・M / Tab / Esc 關閉</div><button class="close">✕</button>';
    this.big.prepend(this.bigCanvas);
    document.body.append(this.big);
    this.big.querySelector('.close')!.addEventListener('click', () => this.close());
    this.big.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = THREE.MathUtils.clamp(this.zoom * (e.deltaY > 0 ? 0.85 : 1.18), 0.8, 8);
    }, { passive: false });
    let drag: { x: number; y: number } | null = null;
    this.bigCanvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      this.bigCanvas.setPointerCapture(e.pointerId);
    });
    this.bigCanvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.pan.x -= (e.clientX - drag.x) / this.zoom;
      this.pan.y -= (e.clientY - drag.y) / this.zoom;
      drag = { x: e.clientX, y: e.clientY };
    });
    this.bigCanvas.addEventListener('pointerup', () => (drag = null));
  }

  get open(): boolean {
    return !this.big.hidden;
  }

  show(): void {
    document.exitPointerLock?.();
    this.pan = { x: 0, y: 0 };
    this.big.hidden = false;
  }

  close(): void {
    this.big.hidden = true;
  }

  update(dt: number, cameraYaw: number, m: MapMarkers): void {
    if (this.open) {
      this.drawBig(m);
      return;
    }
    // ~30 Hz is plenty for the corner map.
    this.tick -= dt;
    if (this.tick > 0) return;
    this.tick = 1 / 30;
    this.drawMini(cameraYaw, m);
  }

  private drawMini(yaw: number, m: MapMarkers): void {
    const css = this.miniWrap.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (this.mini.width !== px) this.mini.width = this.mini.height = px;
    const ctx = this.mini.getContext('2d')!;
    const R = px / 2;
    const scale = R / MINI_RANGE;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    // World offset from the player → minimap pixels; the camera's forward points up.
    const toMap = (x: number, z: number): [number, number] => {
      const dx = (x - m.player.x) * scale, dz = (z - m.player.z) * scale;
      return [R + dx * cos - dz * sin, R + dx * sin + dz * cos];
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#1b2416';
    ctx.fillRect(0, 0, px, px);
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(yaw);
    const k = scale / BASE_SCALE;
    ctx.scale(k, k);
    ctx.drawImage(this.base, -(m.player.x + HALF) * BASE_SCALE, -(m.player.z + HALF) * BASE_SCALE);
    ctx.restore();

    const s = dpr;
    for (const c of m.chests) {
      const [x, y] = toMap(c.x, c.z);
      chestIcon(ctx, x, y);
    }
    for (const e of m.enemies) {
      if (e.position.distanceTo(m.player) > ENEMY_RANGE) continue;
      const [x, y] = toMap(e.position.x, e.position.z);
      ctx.beginPath();
      ctx.arc(x, y, (e.boss ? 5.5 : 3.2) * s, 0, Math.PI * 2);
      ctx.fillStyle = '#e8402e';
      ctx.fill();
      ctx.strokeStyle = '#2a0805';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    this.drawNpcs(ctx, m, toMap, s);
    arrow(ctx, R, R, Math.PI - m.facing + yaw, 7 * s);
    ctx.restore();

    // Rim and north marker.
    ctx.beginPath();
    ctx.arc(R, R, R - 1.5 * s, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(212,168,90,0.85)';
    ctx.lineWidth = 3 * s;
    ctx.stroke();
    const nx = R + sin * (R - 10 * s), ny = R - cos * (R - 10 * s);
    ctx.font = `bold ${11 * s}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1a1408';
    ctx.beginPath();
    ctx.arc(nx, ny, 7.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff6a50';
    ctx.fillText('N', nx, ny + 0.5);
    // Drawn last so the rim and north marker never hide it.
    if (m.objective) {
      let [x, y] = toMap(m.objective.x, m.objective.y);
      // Out of range: pin to the rim in its direction.
      const d = Math.hypot(x - R, y - R);
      const rim = R - 8 * s;
      if (d > rim) {
        x = R + ((x - R) / d) * rim;
        y = R + ((y - R) / d) * rim;
      }
      diamond(ctx, x, y, 6 * s);
    }
  }

  private drawNpcs(ctx: CanvasRenderingContext2D, m: MapMarkers, toMap: (x: number, z: number) => [number, number], s: number): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of m.npcs) {
      const [x, y] = toMap(n.position.x, n.position.z);
      ctx.beginPath();
      ctx.arc(x, y, 3.4 * s, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd34d';
      ctx.fill();
      ctx.strokeStyle = '#2a2005';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (n.mark) {
        ctx.font = `bold ${13 * s}px system-ui, sans-serif`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#000';
        ctx.strokeText(n.mark, x, y - 10 * s);
        ctx.fillStyle = '#ffd34d';
        ctx.fillText(n.mark, x, y - 10 * s);
      }
    }
  }

  private drawBig(m: MapMarkers): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (this.bigCanvas.width !== w || this.bigCanvas.height !== h) {
      this.bigCanvas.width = w;
      this.bigCanvas.height = h;
    }
    const ctx = this.bigCanvas.getContext('2d')!;
    const scale = this.zoom * dpr;
    const cx = m.player.x + this.pan.x, cz = m.player.z + this.pan.y;
    const toMap = (x: number, z: number): [number, number] => [w / 2 + (x - cx) * scale, h / 2 + (z - cz) * scale];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#10140d';
    ctx.fillRect(0, 0, w, h);
    const [ox, oy] = toMap(-HALF, -HALF);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, ox, oy, WORLD_SIZE * scale, WORLD_SIZE * scale);

    const s = dpr * 1.3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${16 * dpr}px system-ui, "Microsoft JhengHei", sans-serif`;
    for (const [name, at] of AREAS) {
      const [x, y] = toMap(at.x, at.y);
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(name, x, y - 24 * dpr);
      ctx.fillStyle = '#f0dcae';
      ctx.fillText(name, x, y - 24 * dpr);
    }
    for (const c of m.chests) {
      const [x, y] = toMap(c.x, c.z);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      chestIcon(ctx, 0, 0);
      ctx.restore();
    }
    this.drawNpcs(ctx, m, toMap, s);
    if (m.objective) {
      const [x, y] = toMap(m.objective.x, m.objective.y);
      diamond(ctx, x, y, 8 * s);
    }
    const [px, py] = toMap(m.player.x, m.player.z);
    arrow(ctx, px, py, Math.PI - m.facing, 9 * s);
    // North indicator.
    ctx.font = `bold ${14 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = '#ff6a50';
    ctx.fillText('▲ N', w - 40 * dpr, 30 * dpr);
  }
}
