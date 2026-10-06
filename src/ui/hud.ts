import { t } from '../i18n';
import { saveChoice, type QualityChoice, type QualitySettings } from '../engine/quality';
import type { Input } from '../input/input';

export class Hud {
  private stats = document.getElementById('stats')!;
  private hint = document.getElementById('hint')!;
  private panel = document.getElementById('settings')!;
  private frames = 0;
  private elapsed = 0;

  constructor(
    private input: Input,
    private quality: QualitySettings,
    private choice: QualityChoice,
    private backend: string,
  ) {
    document.getElementById('hud')!.hidden = false;
    if (input.touch) document.getElementById('touch')!.hidden = false;
    document.getElementById('btn-settings')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.panel.hidden = !this.panel.hidden;
      if (!this.panel.hidden) {
        document.exitPointerLock?.();
        this.renderPanel();
      }
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
    this.hint.textContent = !this.input.touch && !this.input.pointerLocked && this.panel.hidden ? t('hint.clickToPlay') : '';
  }

  private renderPanel(): void {
    const options: QualityChoice[] = ['auto', 'low', 'medium', 'high'];
    const label = (c: QualityChoice) => (c === 'auto' ? t('settings.auto') : t(`quality.${c}`));
    this.panel.innerHTML = `
      <h3>${t('settings.title')}</h3>
      <div>${t('settings.quality')}</div>
      <div class="row">${options
        .map((c) => `<button data-q="${c}" class="${c === this.choice ? 'active' : ''}">${label(c)}</button>`)
        .join('')}</div>
      <h3>${t('settings.controls')}</h3>
      <div class="help">${t(this.input.touch ? 'help.touch' : 'help.pc')}</div>
      <div class="help">${t('help.gamepad')}</div>`;
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
