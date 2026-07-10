import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { en } from '@/shared/i18n/en';
import { DICTIONARIES, translate, type TranslationKey } from '@/shared/i18n/translate';
import type { Locale, TranslationParams } from '@/shared/i18n/types';

/** `localStorage` key `setLocale` persists to and `LocaleProvider` reads from on mount. */
const STORAGE_KEY = 'nitidoc.locale';

export interface LocaleContextValue {
  readonly t: (key: TranslationKey, params?: TranslationParams) => string;
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
}

function isLocale(value: string | null): value is Locale {
  return value === 'es' || value === 'en';
}

/**
 * Resolves the locale for a fresh `<LocaleProvider>` mount (the REAL app —
 * see `App.tsx`): `localStorage` first (persisted from a prior `setLocale`
 * call), then `navigator.language` (only honored when it starts with
 * 'es'/'en'), then 'es' — the app's default per the i18n design ("Spanish by
 * default, with a toggle to English").
 */
function resolveInitialLocale(): Locale {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isLocale(stored)) {
        return stored;
      }
    } catch {
      // localStorage unavailable (privacy mode, disabled storage, etc.) —
      // fall through to the navigator/default heuristic below.
    }
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : '';
  if (nav.startsWith('en')) {
    return 'en';
  }
  if (nav.startsWith('es')) {
    return 'es';
  }
  return 'es';
}

/**
 * Default context value used when `useTranslation()` is called WITHOUT a
 * `<LocaleProvider>` ancestor — deliberately English (NOT the app's real
 * 'es' default). This lets bare `render(<Component />)` unit tests keep
 * matching their existing English text assertions/aria-label selectors
 * without every test needing to wrap in a provider. `setLocale` is a no-op
 * here — there is no provider state to flip.
 */
const defaultContextValue: LocaleContextValue = {
  t: (key, params) => translate(en, key, params),
  locale: 'en',
  setLocale: () => {
    // No-op outside a real <LocaleProvider> — nothing to persist or re-render.
  },
};

const LocaleContext = createContext<LocaleContextValue>(defaultContextValue);

export interface LocaleProviderProps {
  readonly children: ReactNode;
}

/**
 * Mounted once at the app root (`App.tsx`), around the whole tree — makes
 * `useTranslation()` available anywhere, defaulting to Spanish and persisting
 * an explicit `setLocale` choice to `localStorage` so it survives a reload.
 */
export function LocaleProvider({ children }: LocaleProviderProps): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort only — the in-memory locale still flips.
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => translate(DICTIONARIES[locale], key, params),
    [locale],
  );

  const value = useMemo<LocaleContextValue>(() => ({ t, locale, setLocale }), [t, locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * `{ t, locale, setLocale }` — reads from the nearest `<LocaleProvider>`, or
 * falls back to the English default context value when none is mounted (see
 * `defaultContextValue` above).
 */
export function useTranslation(): LocaleContextValue {
  return useContext(LocaleContext);
}
