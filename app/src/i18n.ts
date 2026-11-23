// Interface language. Chinese or English, picked in the toolbar and remembered by the browser; the first visit follows
// the browser's language. Texts are written in place as tr('中文', 'English') rather than looked up by key.
import type { PartDef } from './types.ts';

export type Lang = 'zh' | 'en';
const KEY = 'totk-blueprint:lang';

function initial(): Lang {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (v === 'zh' || v === 'en') return v;
  } catch { /* storage unavailable */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return /^zh\b/i.test(nav) ? 'zh' : 'en';
}

export const lang: Lang = initial();

/** The text for the current language. */
export const tr = (zh: string, en: string): string => (lang === 'en' ? en : zh);

/** Switch the language. The page reloads; the blueprint is autosaved, the undo history starts over. */
export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* storage unavailable */ }
  location.reload();
}

/** A part's display name: the game's text in the current language, else the actor name. */
export function partName(d: PartDef): string {
  return lang === 'en' ? d.nameEn || d.actor : d.name;
}

/** A part's caption (the game's description), when it has one. */
export function partCaption(d: PartDef): string | null {
  return lang === 'en' ? d.captionEn ?? null : d.caption;
}

/** Whether the name is only the actor name (sorted after the named ones). */
export function unnamed(d: PartDef): boolean {
  return partName(d) === d.actor;
}

/** Where the current language's name came from. */
export function nameSource(d: PartDef): PartDef['nameSource'] {
  return lang === 'en' ? d.nameSourceEn : d.nameSource;
}
