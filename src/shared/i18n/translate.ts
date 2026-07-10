import { en } from '@/shared/i18n/en';
import { es } from '@/shared/i18n/es';
import type { Locale, TranslationParams, TranslationValue } from '@/shared/i18n/types';

/** Every valid translation key — derived from `en.ts`, the canonical dictionary. */
export type TranslationKey = keyof typeof en;

export type Dictionary = Record<TranslationKey, TranslationValue>;

export const DICTIONARIES: Record<Locale, Dictionary> = { en, es };

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = params[token];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolves `key` against `dictionary`: selects the plural form via
 * `params.n` (`one` when `Math.abs(n) === 1`, `other` otherwise) when the
 * entry is a `PluralForms` pair, then interpolates any `{token}`
 * placeholders from `params`.
 *
 * Missing-key fallback (documented behavior, see `i18n.test.tsx`): returns
 * the raw key string itself instead of throwing. `TranslationKey` already
 * makes an unknown key a compile error at normal call sites — this runtime
 * guard only matters for a key resolved dynamically (e.g. cast from an
 * external source), where surfacing the key string is more debuggable than
 * a hard crash or a blank label.
 */
export function translate(dictionary: Dictionary, key: TranslationKey, params?: TranslationParams): string {
  const entry: TranslationValue | undefined = dictionary[key];
  if (entry === undefined) {
    return key;
  }
  if (typeof entry === 'string') {
    return interpolate(entry, params);
  }
  const n = params?.n;
  const form = typeof n === 'number' && Math.abs(n) === 1 ? entry.one : entry.other;
  return interpolate(form, params);
}
