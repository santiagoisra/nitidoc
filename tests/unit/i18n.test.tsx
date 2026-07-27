import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocaleProvider, useTranslation } from '@/shared/i18n';
import type { TranslationKey } from '@/shared/i18n';

/**
 * Fase 2.1 punch-list item 5 (i18n) unit tests: `useTranslation()`'s
 * no-provider English fallback (keeps existing bare-render test assertions
 * green — see `LocaleProvider.tsx`'s `defaultContextValue` doc comment),
 * `<LocaleProvider>`'s real Spanish-default/localStorage-persisted locale,
 * pluralization in both locales, and the documented missing-key fallback
 * (returns the raw key string).
 */

const STORAGE_KEY = 'nitidoc.locale';

function Harness(): ReactNode {
  const { t, locale, setLocale } = useTranslation();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="scan-complete-plural">{t('scanner.scanComplete', { n: 2 })}</span>
      <span data-testid="scan-complete-singular">{t('scanner.scanComplete', { n: 1 })}</span>
      <button type="button" onClick={() => setLocale('en')} data-testid="set-en">
        en
      </button>
      <button type="button" onClick={() => setLocale('es')} data-testid="set-es">
        es
      </button>
    </div>
  );
}

function MissingKeyHarness(): ReactNode {
  const { t } = useTranslation();
  // Deliberately cast an unknown string to `TranslationKey` — `TranslationKey`
  // itself makes this a compile error at normal call sites; this simulates a
  // key resolved dynamically (e.g. from an external source) that doesn't
  // exist in either dictionary.
  return <span data-testid="missing-key">{t('does.not.exist' as TranslationKey)}</span>;
}

/** Stubs `navigator.language` to a locale neither dictionary recognizes, so `resolveInitialLocale`'s "default to 'es'" branch is exercised deterministically regardless of the test runner's own locale. */
function stubNavigatorLanguage(value: string): void {
  Object.defineProperty(window.navigator, 'language', { value, configurable: true });
}

describe('i18n (Fase 2.1 punch-list item 5, Spanish-default with English toggle)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubNavigatorLanguage('fr-FR');
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('useTranslation() WITHOUT a <LocaleProvider> falls back to English', () => {
    render(<Harness />);
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('scan-complete-plural').textContent).toBe('Scan complete — 2 pages.');
  });

  it('<LocaleProvider> defaults to Spanish when there is no stored preference', () => {
    render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('es');
    expect(screen.getByTestId('scan-complete-plural').textContent).toBe('Escaneo completo — 2 páginas.');
  });

  it('setLocale flips the active locale and persists the choice to localStorage', () => {
    render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByTestId('set-en'));
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('scan-complete-plural').textContent).toBe('Scan complete — 2 pages.');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('en');

    fireEvent.click(screen.getByTestId('set-es'));
    expect(screen.getByTestId('locale').textContent).toBe('es');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('es');
  });

  it('a fresh <LocaleProvider> mount honors a previously persisted locale', () => {
    window.localStorage.setItem(STORAGE_KEY, 'en');
    render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
  });

  it('pluralizes the singular ("one") form correctly in both locales', () => {
    render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('scan-complete-singular').textContent).toBe('Escaneo completo — 1 página.');

    fireEvent.click(screen.getByTestId('set-en'));
    expect(screen.getByTestId('scan-complete-singular').textContent).toBe('Scan complete — 1 page.');
  });

  it('keeps <html lang> in sync with the active locale', () => {
    render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    );
    expect(document.documentElement.lang).toBe('es');

    fireEvent.click(screen.getByTestId('set-en'));
    expect(document.documentElement.lang).toBe('en');

    fireEvent.click(screen.getByTestId('set-es'));
    expect(document.documentElement.lang).toBe('es');
  });

  it('falls back to the raw key string for a missing/unknown key (documented behavior)', () => {
    render(
      <LocaleProvider>
        <MissingKeyHarness />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('missing-key').textContent).toBe('does.not.exist');
  });
});
