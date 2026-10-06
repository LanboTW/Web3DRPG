import { isTouchDevice } from '../engine/quality';

export type Action = 'attack' | 'dodge' | 'skill1' | 'skill2' | 'ultimate' | 'lock' | 'interact';

const KEY_ACTIONS: Record<string, Action> = {
  Space: 'dodge',
  KeyQ: 'skill1',
  KeyE: 'skill2',
  KeyR: 'ultimate',
  Tab: 'lock',
  KeyF: 'interact',
};

// Standard Gamepad API mapping (Xbox layout names).
const PAD_ACTIONS: [number, Action][] = [
  [2, 'attack'], // X
  [0, 'dodge'], // A
  [4, 'skill1'], // LB
  [5, 'skill2'], // RB
  [7, 'ultimate'], // RT
  [11, 'lock'], // R3
  [1, 'interact'], // B
];
const PAD_SPRINT = 6; // LT
const STICK_DEADZONE = 0.18;
const JOY_RADIUS = 50;

/**
 * Merges keyboard/mouse, touch and gamepad into one per-frame state.
 * Call `update()` once at the start of a frame and `endFrame()` after the
 * game has read it; actions are edge-triggered for exactly one frame.
 */
export class Input {
  /** x = right, y = forward, length ≤ 1. */
  readonly move = { x: 0, y: 0 };
  /** Camera rotation request in radians for this frame. */
  readonly look = { x: 0, y: 0 };
  zoom = 0;
  sprint = false;
  pointerLocked = false;
  readonly touch = isTouchDevice();

  private keys = new Set<string>();
  private pressed = new Set<Action>();
  private padPrev: boolean[] = [];
  private mouseDX = 0;
  private mouseDY = 0;
  private touchMove = { x: 0, y: 0 };
  private joyId: number | null = null;
  private joyOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      const action = KEY_ACTIONS[e.code];
      if (action) this.pressed.add(action);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    if (this.touch) this.bindTouch();
    else this.bindMouse();
  }

  wasPressed(action: Action): boolean {
    return this.pressed.has(action);
  }

  /** Lets UI widgets (touch buttons) inject actions. */
  press(action: Action): void {
    this.pressed.add(action);
  }

  update(dt: number): void {
    let mx = 0;
    let my = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    let sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    mx += this.touchMove.x;
    my += this.touchMove.y;
    if (this.joyId !== null && Math.hypot(this.touchMove.x, this.touchMove.y) > 0.92) sprint = true;

    const MOUSE_SENS = 0.0025;
    let lx = this.mouseDX * MOUSE_SENS;
    let ly = this.mouseDY * MOUSE_SENS;
    this.mouseDX = 0;
    this.mouseDY = 0;

    const pad = this.activeGamepad();
    if (pad) {
      const [ax, ay, rx, ry] = [0, 1, 2, 3].map((i) => deadzone(pad.axes[i] ?? 0));
      mx += ax;
      my -= ay;
      const PAD_LOOK = 2.6;
      lx += rx * PAD_LOOK * dt;
      ly += ry * PAD_LOOK * dt;
      if (pad.buttons[PAD_SPRINT]?.pressed) sprint = true;
      PAD_ACTIONS.forEach(([index, action]) => {
        const down = pad.buttons[index]?.pressed ?? false;
        if (down && !this.padPrev[index]) this.pressed.add(action);
        this.padPrev[index] = down;
      });
    }

    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    this.move.x = mx;
    this.move.y = my;
    this.look.x = lx;
    this.look.y = ly;
    this.sprint = sprint;
  }

  endFrame(): void {
    this.pressed.clear();
    this.zoom = 0;
  }

  private activeGamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private bindMouse(): void {
    const canvas = this.canvas;
    canvas.addEventListener('click', () => {
      if (!this.pointerLocked) Promise.resolve(canvas.requestPointerLock?.()).catch(() => {});
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0) this.pressed.add('attack');
      if (e.button === 1) {
        e.preventDefault();
        this.pressed.add('lock');
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom += Math.sign(e.deltaY);
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private bindTouch(): void {
    const base = document.getElementById('joy-base')!;
    const knob = document.getElementById('joy-knob')!;
    const canvas = this.canvas;

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < window.innerWidth * 0.45 && this.joyId === null) {
          this.joyId = t.identifier;
          this.joyOrigin = { x: t.clientX, y: t.clientY };
          base.style.left = `${t.clientX}px`;
          base.style.top = `${t.clientY}px`;
          base.classList.add('active');
        } else if (this.lookId === null) {
          this.lookId = t.identifier;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          let dx = t.clientX - this.joyOrigin.x;
          let dy = t.clientY - this.joyOrigin.y;
          const d = Math.hypot(dx, dy);
          if (d > JOY_RADIUS) {
            dx *= JOY_RADIUS / d;
            dy *= JOY_RADIUS / d;
          }
          knob.style.transform = `translate(${dx}px, ${dy}px)`;
          this.touchMove.x = dx / JOY_RADIUS;
          this.touchMove.y = -dy / JOY_RADIUS;
        } else if (t.identifier === this.lookId) {
          const TOUCH_SENS = 2.2;
          this.mouseDX += (t.clientX - this.lookLast.x) * TOUCH_SENS;
          this.mouseDY += (t.clientY - this.lookLast.y) * TOUCH_SENS;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: false });

    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          this.joyId = null;
          this.touchMove.x = 0;
          this.touchMove.y = 0;
          knob.style.transform = '';
          base.classList.remove('active');
          base.style.left = '';
          base.style.top = '';
        } else if (t.identifier === this.lookId) {
          this.lookId = null;
        }
      }
    };
    canvas.addEventListener('touchend', end);
    canvas.addEventListener('touchcancel', end);

    document.querySelectorAll<HTMLButtonElement>('#touch-buttons .tb').forEach((btn) => {
      const action = btn.dataset.action as Action;
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        btn.classList.add('pressed');
        this.press(action);
      }, { passive: false });
      const release = () => btn.classList.remove('pressed');
      btn.addEventListener('touchend', release);
      btn.addEventListener('touchcancel', release);
    });
  }
}

function deadzone(v: number): number {
  if (Math.abs(v) < STICK_DEADZONE) return 0;
  return Math.sign(v) * (Math.abs(v) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
}
