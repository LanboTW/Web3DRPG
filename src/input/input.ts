import { isTouchDevice } from '../engine/quality';

export type Action = 'attack' | 'dodge' | 'block' | 'skill1' | 'skill2' | 'ultimate' | 'lock' | 'interact' | 'potion' | 'menu' | 'map' | 'back' | 'skip';

const KEY_ACTIONS: Record<string, Action> = {
  Space: 'dodge',
  KeyQ: 'skill1',
  KeyE: 'skill2',
  KeyR: 'ultimate',
  KeyV: 'lock',
  KeyF: 'interact',
  KeyH: 'potion',
  Tab: 'menu',
  KeyI: 'menu',
  KeyM: 'map',
  Escape: 'back',
  KeyX: 'skip',
};

// Standard Gamepad API mapping (Xbox layout names).
const PAD_ACTIONS: [number, Action][] = [
  [2, 'attack'], // X
  [0, 'dodge'], // A
  [5, 'skill1'], // RB
  [7, 'skill2'], // RT
  [3, 'ultimate'], // Y
  [11, 'lock'], // R3
  [1, 'interact'], // B
  [12, 'potion'], // D-pad up
  [9, 'menu'], // Start
  [8, 'map'], // Back / View
];
/** How long browsers refuse a new pointer lock after the player released it with Esc. */
const RELOCK_COOLDOWN = 1100;
const PAD_BLOCK = 4; // LB (held)
const PAD_SPRINT_HOLD = 6; // LT (held)
const PAD_SPRINT_TOGGLE = 10; // L3: sprint until the stick is released
/** Keyboard alternative to right mouse for blocking (trackpads). */
const KEY_BLOCK = 'KeyC';
const STICK_DEADZONE = 0.18;
const JOY_RADIUS = 50;
/** Horizontal mouse travel (px, decaying over ~0.1 s) that counts as a target-switch flick. */
const FLICK_PX = 110;
const FLICK_COOLDOWN = 0.3;

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
  /** Held: raising the shield. */
  block = false;
  pointerLocked = false;
  readonly touch = isTouchDevice();
  /** A gamepad is connected; the click-to-start gate is not needed. */
  hasPad = false;
  /** -1 / +1 on the frame the player flicks the mouse (or right stick) sideways to switch lock-on target. */
  flick = 0;

  private releasedAt = -Infinity;
  private retryTimer = 0;
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
  private mouseBlock = false;
  private touchBlock = false;
  private padSprintToggle = false;
  private flickAcc = 0;
  private flickCooldown = 0;
  private padFlickArmed = true;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      // Space would otherwise "click" a focused dialog button.
      if (e.code === 'Space' && document.activeElement instanceof HTMLButtonElement) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      const action = KEY_ACTIONS[e.code];
      if (action) this.pressed.add(action);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseBlock = this.touchBlock = false;
    });

    if (this.touch) this.bindTouch();
    else this.bindMouse();
  }

  /** True for one frame after the pointer lock was released (Esc, alt-tab, or a UI opening). */
  lockLost = false;

  wasPressed(action: Action): boolean {
    return this.pressed.has(action);
  }

  /** A re-lock attempt is scheduled; the game waits for it instead of showing the click gate. */
  get lockPending(): boolean {
    return this.retryTimer !== 0;
  }

  /**
   * Captures the mouse for camera control. Must follow a user gesture to succeed.
   * After the player releases the lock with Esc, browsers refuse a new lock for
   * about a second, so the request is retried until shortly after that window
   * (still inside the ~5 s that the closing key press counts as a gesture).
   */
  requestLock(retryUntil = performance.now() + 2500): void {
    if (this.touch || this.pointerLocked) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    const retry = () => {
      if (this.pointerLocked || performance.now() > retryUntil) return;
      const wait = Math.max(250, this.releasedAt + RELOCK_COOLDOWN - performance.now());
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = 0;
        this.requestLock(retryUntil);
      }, wait);
    };
    if (performance.now() - this.releasedAt < RELOCK_COOLDOWN) return retry();
    try {
      Promise.resolve(this.canvas.requestPointerLock?.()).catch(retry);
    } catch {
      retry();
    }
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
    let block = this.keys.has(KEY_BLOCK) || this.mouseBlock || this.touchBlock;

    mx += this.touchMove.x;
    my += this.touchMove.y;
    if (this.joyId !== null && Math.hypot(this.touchMove.x, this.touchMove.y) > 0.92) sprint = true;

    const MOUSE_SENS = 0.0025;
    let lx = this.mouseDX * MOUSE_SENS;
    let ly = this.mouseDY * MOUSE_SENS;
    // A quick sideways flick (vertical motion ignored) switches the lock-on target.
    this.flick = 0;
    this.flickCooldown = Math.max(0, this.flickCooldown - dt);
    this.flickAcc = this.flickAcc * Math.exp(-dt * 10) + (this.touch ? 0 : this.mouseDX);
    if (Math.abs(this.flickAcc) > FLICK_PX && this.flickCooldown <= 0) {
      this.flick = Math.sign(this.flickAcc);
      this.flickAcc = 0;
      this.flickCooldown = FLICK_COOLDOWN;
    }
    this.mouseDX = 0;
    this.mouseDY = 0;

    const pad = this.activeGamepad();
    this.hasPad = !!pad;
    if (pad) {
      const [ax, ay, rx, ry] = [0, 1, 2, 3].map((i) => deadzone(pad.axes[i] ?? 0));
      mx += ax;
      my -= ay;
      const PAD_LOOK = 2.6;
      lx += rx * PAD_LOOK * dt;
      ly += ry * PAD_LOOK * dt;
      // Right stick slammed sideways also switches targets; re-arms near centre.
      if (Math.abs(rx) > 0.85 && this.padFlickArmed) {
        this.padFlickArmed = false;
        if (!this.flick) this.flick = Math.sign(rx);
      } else if (Math.abs(rx) < 0.4) this.padFlickArmed = true;
      if (pad.buttons[PAD_SPRINT_TOGGLE]?.pressed) this.padSprintToggle = true;
      if (Math.hypot(ax, ay) < 0.2) this.padSprintToggle = false;
      if (pad.buttons[PAD_SPRINT_HOLD]?.pressed || this.padSprintToggle) sprint = true;
      if (pad.buttons[PAD_BLOCK]?.pressed) block = true;
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
    this.block = block;
  }

  /** Swallows this frame's gameplay input (dialogs and menus have focus). */
  suppress(): void {
    this.pressed.clear();
    this.move.x = this.move.y = 0;
    this.look.x = this.look.y = 0;
    this.sprint = false;
    this.block = false;
    this.flick = 0;
  }

  endFrame(): void {
    this.pressed.clear();
    this.lockLost = false;
    this.zoom = 0;
  }

  private activeGamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private bindMouse(): void {
    const canvas = this.canvas;
    document.addEventListener('pointerlockchange', () => {
      const was = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === canvas;
      this.mouseBlock = false;
      if (this.pointerLocked) {
        clearTimeout(this.retryTimer);
        this.retryTimer = 0;
      }
      if (!was || this.pointerLocked) return;
      this.releasedAt = performance.now();
      // The browser swallows the Esc that releases pointer lock, so report the release
      // instead, unless it came from switching window or tab (the page loses focus).
      setTimeout(() => {
        if (document.hasFocus() && document.visibilityState === 'visible' && !this.pointerLocked) this.lockLost = true;
      }, 100);
    });
    // The camera only turns while the pointer is captured; there is no drag fallback.
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
      if (e.button === 2) this.mouseBlock = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.mouseBlock = false;
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
      // The block button is held rather than tapped.
      const hold = btn.dataset.hold === 'block';
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        btn.classList.add('pressed');
        if (hold) this.touchBlock = true;
        else this.press(action);
      }, { passive: false });
      const release = () => {
        btn.classList.remove('pressed');
        if (hold) this.touchBlock = false;
      };
      btn.addEventListener('touchend', release);
      btn.addEventListener('touchcancel', release);
    });
  }
}

function deadzone(v: number): number {
  if (Math.abs(v) < STICK_DEADZONE) return 0;
  return Math.sign(v) * (Math.abs(v) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
}
