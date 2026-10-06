import { zhTW, type I18nKey } from './zh-TW';

export type { I18nKey };

const dictionaries: Record<string, Record<I18nKey, string>> = { 'zh-TW': zhTW };
let current: Record<I18nKey, string> = zhTW;

export function setLocale(locale: string): void {
  current = dictionaries[locale] ?? zhTW;
}

export function t(key: I18nKey): string {
  return current[key] ?? key;
}

/** Fill every element marked with data-i18n. */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as I18nKey);
  });
}
