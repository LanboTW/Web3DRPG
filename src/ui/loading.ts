import { t, type I18nKey } from '../i18n';

const root = () => document.getElementById('loading')!;

export function setProgress(fraction: number, key: I18nKey): void {
  root().querySelector<HTMLElement>('.loading-fill')!.style.width = `${Math.round(fraction * 100)}%`;
  root().querySelector<HTMLElement>('.loading-text')!.textContent = t(key);
}

export function showError(message: string): void {
  root().querySelector<HTMLElement>('.loading-text')!.textContent = message;
}

export function hideLoading(): void {
  const el = root();
  el.classList.add('done');
  setTimeout(() => el.remove(), 700);
}

/** Lets the browser paint the loading screen between heavy synchronous steps. */
export function nextFrame(): Promise<void> {
  // rAF never fires in a hidden tab, so a timeout guarantees progress.
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 50);
    requestAnimationFrame(() => setTimeout(done, 0));
  });
}
