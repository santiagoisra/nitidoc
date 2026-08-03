import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { BrandGlyph, LanguageToggle, ToastHost } from '@/shared/ui';
import { LocaleProvider } from '@/shared/i18n';
import { HistoryScreen } from '@/features/history/components/HistoryScreen';
import { ScannerScreen } from '@/features/scanner/components/ScannerScreen';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

/**
 * App shell — Fase 1 has a single screen (the scanner), no router.
 * Live detection overlay, auto-capture, and the corner editor are wired in
 * Groups 4-5; this slice wires the camera viewfinder itself (Group 3).
 *
 * Group 6/PR9 (design section 5.5): `ToastHost` is mounted once here, at the
 * app root, so `useToast()` (used by `usePageDeletion`'s 5s undo toast) is
 * available anywhere in the tree without disrupting the existing layout —
 * it renders `children` untouched plus its own fixed toast queue overlay.
 *
 * Fase 2.1 punch-list item 5 (i18n): `LocaleProvider` wraps the whole tree
 * (outermost, alongside `ToastHost`) so `useTranslation()` resolves to the
 * real Spanish-default/English-toggle locale everywhere, including inside
 * `usePageDeletion`/`useExportPdf`'s toast messages. `LanguageToggle` is
 * mounted in the header, next to the brand mark — "Nitidoc" itself is a
 * proper noun/brand and stays untranslated.
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 5, D-3 "No-scroll scope"): the root
 * subscribes to `DocumentSlice.phase` directly (the SAME `useScannerStore`
 * instance `ScannerScreen` reads) so the shell can decide, one level above
 * `ScannerScreen`, whether the current phase wants a truly full-bleed
 * no-scroll layout (`capturing`/`processing` — a persistent camera or a
 * determinate progress screen, neither of which has anything worth
 * scrolling to) or the normal centered/scrollable layout every other phase
 * needs (`grid` alone can hold up to `FILTER.PAGE_CAP` = 30 thumbnails,
 * which cannot all fit on one screen without scrolling). "No-scroll" here
 * means the PAGE itself (`<html>`/`<body>`/this root `div`) never scrolls —
 * `<main>` scrolls internally instead, so a header, if any, always stays
 * pinned above the content instead of scrolling out of view.
 *
 * Review fix (grid-clip regression): the non-immersive `<main>` used plain
 * `justify-center` on the scroll axis. When content is SHORTER than the
 * viewport that centers it as intended, but once a phase's content (e.g. a
 * tall `PageGrid`) grows TALLER than the viewport, `justify-center` centers
 * the flex item first and only THEN lets it overflow EQUALLY on both sides —
 * the overflow above the top is never reachable via `overflow-y-auto` (there
 * is nothing to scroll UP to; the natural top edge sits above the scroll
 * container's origin). `justify-[safe_center]` (`justify-content: safe
 * center`) keeps the short-content centering behavior but falls back to
 * start-alignment once the content overflows, so a 30-page grid's first row
 * is always reachable by scrolling from the top. (Project pins Tailwind
 * v3.4.17 — the `justify-center-safe` utility only exists in v4 — so this
 * uses the arbitrary-value form, supported by v3's JIT engine.)
 */
export function App(): ReactNode {
  const phase = useScannerStore((state) => state.phase);

  /**
   * Scan history (history design section 6). The app still has no router — one
   * boolean is the whole navigation model, which is the right size for two
   * top-level screens. The history is never immersive, so it always renders
   * inside the normal scrollable shell with the header above it.
   */
  const [showHistory, setShowHistory] = useState(false);
  const openHistory = useCallback(() => setShowHistory(true), []);
  const closeHistory = useCallback(() => setShowHistory(false), []);

  // `adjust` joins `capturing`/`processing` as a full-bleed no-scroll screen:
  // it is a CamScanner-style page-preview + fixed filter strip + toolbar that
  // manages its own internal layout (the page itself must not scroll).
  const immersive =
    !showHistory && (phase === 'capturing' || phase === 'processing' || phase === 'adjust');

  return (
    <LocaleProvider>
      <ToastHost>
        <div
          className="viewport-shell flex flex-col overflow-hidden overscroll-none bg-bg text-text"
          data-testid="app-shell"
        >
          {!immersive && (
            <header
              className="flex items-center justify-between gap-3 border-b border-text-muted/10 px-4 pb-4"
              // PWA safe area (iOS standalone): with `viewport-fit=cover` the
              // content starts under the status bar / notch, so the header must
              // clear `env(safe-area-inset-top)` — otherwise the wordmark sits
              // on top of the clock/battery (reported on installed iPhone PWA).
              style={{ paddingTop: 'calc(env(safe-area-inset-top) + 1rem)' }}
              data-testid="app-header"
            >
              <div className="flex items-center gap-2.5">
                <BrandGlyph size={28} />
                <span className="text-lg font-extrabold lowercase tracking-tight">nitidoc</span>
              </div>
              <LanguageToggle />
            </header>
          )}

          <main
            className={
              immersive
                ? 'flex flex-1 flex-col overflow-hidden'
                : 'flex flex-1 flex-col items-center justify-[safe_center] gap-6 overflow-y-auto px-4 py-8'
            }
            data-testid="app-main"
          >
            {showHistory ? (
              <HistoryScreen onBack={closeHistory} onOpened={closeHistory} />
            ) : (
              <ScannerScreen onOpenHistory={openHistory} />
            )}
          </main>
        </div>
      </ToastHost>
    </LocaleProvider>
  );
}
