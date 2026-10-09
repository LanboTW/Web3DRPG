import { t } from '../i18n';
import { saveChoice, type QualityChoice, type QualitySettings } from '../engine/quality';
import type { Input } from '../input/input';
import type { GameState } from '../rpg/state';
import { audio, type AudioSettings } from '../game/audio';

export class Hud {
  private stats = document.getElementById('stats')!;
  private panel = document.getElementById('settings')!;
  private frames = 0;
  private elapsed = 0;

  constructor(
    private input: Input,
    private quality: QualitySettings,
    private choice: QualityChoice,
    private backend: string,
    private state: GameState,
  ) {
    document.getElementById('hud')!.hidden = false;
    if (input.touch) document.getElementById('touch')!.hidden = false;
    document.getElementById('btn-settings')!.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.panel.hidden) this.openPanel();
      else this.closePanel();
    });
  }

  update(dt: number, resolutionScale: number): void {
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed >= 0.5) {
      const fps = Math.round(this.frames / this.elapsed);
      this.stats.textContent = `${fps} FPS · ${this.backend} · ${t(`quality.${this.quality.tier}`)} · ${Math.round(resolutionScale * 100)}%`;
      this.frames = 0;
      this.elapsed = 0;
    }
  }

  get panelOpen(): boolean {
    return !this.panel.hidden;
  }

  openPanel(): void {
    this.panel.hidden = false;
    document.exitPointerLock?.();
    this.renderPanel();
  }

  closePanel(): void {
    this.panel.hidden = true;
  }

  private renderPanel(): void {
    const options: QualityChoice[] = ['auto', 'low', 'medium', 'high'];
    const label = (c: QualityChoice) => (c === 'auto' ? t('settings.auto') : t(`quality.${c}`));
    this.panel.innerHTML = `
      <button class="resume-btn">${t('settings.resume')}</button>
      <h3>${t('settings.title')}</h3>
      <div>${t('settings.quality')}</div>
      <div class="row">${options
        .map((c) => `<button data-q="${c}" class="${c === this.choice ? 'active' : ''}">${label(c)}</button>`)
        .join('')}</div>
      <h3>${t('settings.audio')}</h3>
      ${(['master', 'music', 'sfx'] as const)
        .map((k) => `<label class="slider">${t(`audio.${k}`)}<input type="range" min="0" max="1" step="0.05" data-vol="${k}" value="${audio.settings[k]}"></label>`)
        .join('')}
      <h3>${t('settings.controls')}</h3>
      <div class="help">${t(this.input.touch ? 'help.touch' : 'help.pc')}</div>
      <div class="help">${t('help.gamepad')}</div>
      <h3>${t('settings.save')}</h3>
      <div class="row">
        <button data-save="export">${t('settings.export')}</button>
        <button data-save="import">${t('settings.import')}</button>
        <button data-save="reset">${t('settings.reset')}</button>
      </div>`;
    // A click is a user gesture, so the pointer can be captured again right away.
    this.panel.querySelector('.resume-btn')!.addEventListener('click', () => {
      this.closePanel();
      this.input.requestLock();
    });
    this.panel.querySelector('[data-save="export"]')!.addEventListener('click', () => {
      const blob = new Blob([this.state.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `web3drpg-save-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    this.panel.querySelector('[data-save="import"]')!.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (this.state.importJson(await file.text())) location.reload();
        else alert(t('settings.importFail'));
      };
      input.click();
    });
    this.panel.querySelector('[data-save="reset"]')!.addEventListener('click', () => {
      if (!confirm(t('settings.resetConfirm'))) return;
      this.state.reset();
      location.reload();
    });
    this.panel.querySelectorAll<HTMLInputElement>('[data-vol]').forEach((input) =>
      input.addEventListener('input', () => {
        audio.settings[input.dataset.vol as keyof AudioSettings] = Number(input.value);
        audio.applySettings(true);
      }),
    );
    this.panel.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const choice = btn.dataset.q as QualityChoice;
        if (choice === this.choice) return;
        saveChoice(choice);
        // Shadow maps, terrain resolution and vegetation are baked at startup.
        location.reload();
      }),
    );
  }
}
