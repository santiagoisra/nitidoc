import type { ReactNode } from 'react';
import { useTranslation } from '@/shared/i18n';
import type { Locale } from '@/shared/i18n';

const LOCALES: readonly Locale[] = ['es', 'en'];
const LOCALE_LABEL: Record<Locale, string> = { es: 'ES', en: 'EN' };

/**
 * Compact ES/EN toggle (i18n pass: "Spanish by default, with a toggle to
 * English"). Mounted in the app header (`App.tsx`). Flips `locale` via
 * `setLocale`, which persists the choice to `localStorage`
 * (`LocaleProvider`). Deliberately tiny and unobtrusive — two letter-code
 * buttons, no dropdown/menu — per the design's "keep it unobtrusive" note.
 */
export function LanguageToggle(): ReactNode {
  const { locale, setLocale, t } = useTranslation();

  return (
    <div
      role="group"
      aria-label={t('lang.toggle')}
      className="flex items-center gap-1 rounded-full bg-surface/60 p-1 text-xs font-medium"
      data-testid="language-toggle"
    >
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLocale(code)}
          aria-pressed={locale === code}
          data-testid={`language-toggle-${code}`}
          className={`min-h-[32px] min-w-[32px] rounded-full px-2 transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light
            ${locale === code ? 'bg-primary text-bg' : 'text-text-muted hover:text-text'}`}
        >
          {LOCALE_LABEL[code]}
        </button>
      ))}
    </div>
  );
}
