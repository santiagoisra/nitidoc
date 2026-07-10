/**
 * Shared i18n primitive types (Spanish-default / English-toggle pass).
 * Deliberately dependency-free (no React import) so `en.ts`/`es.ts` can be
 * imported from anywhere (including the worker bundle, if ever needed)
 * without pulling in React.
 */

export type Locale = 'es' | 'en';

/** Values passed to `t(key, params)` for `{token}` interpolation. */
export type TranslationParams = Record<string, string | number>;

/**
 * A count-driven pair of forms selected by `params.n` — `one` when
 * `Math.abs(n) === 1`, `other` otherwise. English and Spanish both only need
 * this two-way split for the "{n} page(s)" strings in this app; no third
 * CLDR "few"/"many" category applies to either language here.
 */
export interface PluralForms {
  readonly one: string;
  readonly other: string;
}

export type TranslationValue = string | PluralForms;
