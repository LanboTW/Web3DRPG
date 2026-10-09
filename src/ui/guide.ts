import { t } from '../i18n';
import type { Input } from '../input/input';
import type { Player } from '../game/player';
import { audio } from '../game/audio';

/**
 * Full-screen "click to start / continue" gate for mouse players. The click
 * captures the pointer; the game stays paused while it shows.
 */
export class PointerGate {
  private el = document.createElement('div');
  private started = false;

  constructor(input: Input) {
    this.el.id = 'gate';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="gate-title">${t('game.title')}</div><div class="gate-go"></div><div class="gate-help">${t('help.pc')}</div>`;
    document.body.append(this.el);
    this.el.addEventListener('click', () => input.requestLock());
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  set(show: boolean): void {
    if (show === this.visible) return;
    this.el.hidden = !show;
    if (show) this.el.querySelector('.gate-go')!.textContent = t(this.started ? 'hint.clickToResume' : 'hint.clickToPlay');
    else this.started = true;
  }
}

type Device = 'pc' | 'touch' | 'pad';
interface Step {
  label: Record<Device, string>;
  done: (input: Input, player: Player) => boolean;
}

const STEPS: Step[] = [
  { label: { pc: 'V 或滑鼠中鍵：鎖定敵人', touch: '點「鎖定」鎖定敵人', pad: 'R3：鎖定敵人' }, done: (_, p) => !!p.lockTarget },
  { label: { pc: '左鍵：攻擊', touch: '點「攻擊」', pad: 'X：攻擊' }, done: (i) => i.wasPressed('attack') },
  { label: { pc: '按住右鍵：舉盾格擋', touch: '按住「格擋」', pad: '按住 LB：格擋' }, done: (i) => i.block },
  { label: { pc: '空白鍵：閃避', touch: '點「閃避」', pad: 'A：閃避' }, done: (i) => i.wasPressed('dodge') },
  { label: { pc: 'Q / E：施放技能', touch: '點「技1」或「技2」', pad: 'RB / RT：施放技能' }, done: (i) => i.wasPressed('skill1') || i.wasPressed('skill2') },
];

/** Non-pausing first-combat checklist; each step ticks off as the player does it. */
export class CombatTutorial {
  private el = document.createElement('div');
  private ticked = STEPS.map(() => false);
  private device: Device | null = null;
  private active = false;
  private finishing = 0;
  /** Called once when the checklist is completed or skipped. */
  onFinish: (() => void) | null = null;

  constructor(private input: Input) {
    this.el.id = 'tutorial';
    this.el.hidden = true;
    document.getElementById('hud')!.append(this.el);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.el.hidden = false;
    this.render();
  }

  /** Call each frame after input.update() and before input is suppressed or consumed. */
  update(dt: number, player: Player): void {
    if (!this.active) return;
    if (this.finishing > 0) {
      this.finishing -= dt;
      if (this.finishing <= 0) this.stop();
      return;
    }
    if (this.input.wasPressed('skip')) {
      this.finish();
      return;
    }
    const device: Device = this.input.touch ? 'touch' : this.input.hasPad ? 'pad' : 'pc';
    let changed = device !== this.device;
    STEPS.forEach((s, i) => {
      if (!this.ticked[i] && s.done(this.input, player)) {
        this.ticked[i] = true;
        changed = true;
        audio.play('click', { bus: 'ui', volume: 0.6 });
      }
    });
    if (changed) this.render();
    if (this.ticked.every(Boolean)) {
      this.el.classList.add('complete');
      this.el.querySelector('.tut-title')!.textContent = '教學完成！';
      audio.play('confirm', { bus: 'ui' });
      this.finish(2);
    }
  }

  private finish(linger = 0): void {
    this.onFinish?.();
    this.finishing = linger;
    if (!linger) this.stop();
  }

  private stop(): void {
    this.active = false;
    this.el.hidden = true;
  }

  private render(): void {
    const device: Device = this.input.touch ? 'touch' : this.input.hasPad ? 'pad' : 'pc';
    this.device = device;
    const skip = device === 'touch' ? '<button class="tut-skip">略過</button>' : '<span class="tut-skip-key">X 略過</span>';
    this.el.innerHTML = `<div class="tut-title">戰鬥教學 ${skip}</div>${STEPS.map((s, i) => `<div class="tut-step${this.ticked[i] ? ' done' : ''}"><i>${this.ticked[i] ? '✔' : '○'}</i>${s.label[device]}</div>`).join('')}`;
    this.el.querySelector('.tut-skip')?.addEventListener('click', () => this.finish());
  }
}
