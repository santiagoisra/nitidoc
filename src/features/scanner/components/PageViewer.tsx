/**
 * Full-screen page viewer (navigation-ux, bug 2: "en 'documento listo' no se
 * puede ver el documento que se acaba de escanear").
 *
 * WHY NOT AN EMBEDDED PDF: the obvious implementation — generate the PDF and
 * drop it in an `<iframe>` — does not work where it matters. Android's WebView
 * ships no PDF renderer, so the frame comes up blank in the packaged app while
 * looking fine on a desktop browser. That is the worst possible failure shape:
 * invisible during development, total on the target device.
 *
 * WHY IT RENDERS THROUGH `renderPage`: the viewer runs the SAME function that
 * produces the images the PDF embeds, one page at a time and on demand. The
 * cheaper route is a CSS `filter` over the cached thumbnail, but the adaptive
 * presets (`bw`, `bw-high-contrast`, `eco`, any sharpness) are baked by the
 * OpenCV worker and have no CSS equivalent — a preview built that way would
 * confidently show something the exported file does not contain. A preview you
 * cannot trust is worse than no preview, because the user stops checking.
 *
 * The cost is one render per page viewed, which is work the export would do
 * anyway. Pages are rendered lazily as you reach them and cached for the
 * lifetime of the viewer.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BackButton } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { renderPage } from '@/features/scanner/lib/exportPdf';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

export interface PageViewerProps {
  readonly pages: readonly DocumentPage[];
  /** Page index to open on. Clamped, so a stale index can never blank the viewer. */
  readonly initialIndex?: number;
  readonly onClose: () => void;
}

export function PageViewer({ pages, initialIndex = 0, onClose }: PageViewerProps): ReactNode {
  const { t } = useTranslation();
  const ordered = [...pages].sort((a, b) => a.order - b.order);
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), Math.max(ordered.length - 1, 0)));
  const [rendered, setRendered] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});

  /**
   * Renders in flight or already done, so a fast swipe back and forth across
   * the same page does not queue a second worker round-trip for it.
   */
  const claimedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const current = ordered[index];

  useEffect(() => {
    if (!current || claimedRef.current.has(current.id)) {
      return;
    }
    claimedRef.current.add(current.id);
    void (async () => {
      try {
        const result = await renderPage(current);
        if (!mountedRef.current) return;
        setRendered((prev) => ({ ...prev, [current.id]: result.dataUrl }));
      } catch {
        if (!mountedRef.current) return;
        // A page that will not render is a real possibility (the worker can be
        // in degraded mode). Say so on that page instead of showing an empty
        // black screen the user cannot interpret.
        setFailed((prev) => ({ ...prev, [current.id]: true }));
        claimedRef.current.delete(current.id);
      }
    })();
  }, [current]);

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setIndex((i) => Math.min(ordered.length - 1, i + 1)), [ordered.length]);

  // Arrow keys and Escape: this is a modal surface, and on desktop the swipe
  // affordance does not exist at all.
  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') goPrev();
      if (event.key === 'ArrowRight') goNext();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [goNext, goPrev, onClose]);

  if (!current) {
    return null;
  }

  const dataUrl = rendered[current.id];
  const hasFailed = failed[current.id] === true;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label={t('viewer.title')}
      data-testid="page-viewer"
    >
      <div
        className="flex items-center justify-between gap-2 p-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <BackButton onClick={onClose} tone="overlay" label={t('common.close')} testId="viewer-close" />
        <span className="text-sm font-medium tabular-nums" data-testid="viewer-counter">
          {t('viewer.position', { current: index + 1, total: ordered.length })}
        </span>
        {/* Balances the header so the counter stays optically centred. */}
        <span className="h-11 w-11" aria-hidden="true" />
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        {hasFailed ? (
          <p role="alert" className="text-sm text-danger" data-testid="viewer-error">
            {t('viewer.renderError')}
          </p>
        ) : dataUrl ? (
          <img
            src={dataUrl}
            alt={t('viewer.pageAlt', { n: index + 1 })}
            className="max-h-full max-w-full object-contain"
            data-testid="viewer-page"
          />
        ) : (
          <p className="text-sm text-white/70" data-testid="viewer-loading">
            {t('common.processing')}
          </p>
        )}
      </div>

      {ordered.length > 1 && (
        <div
          className="flex items-center justify-center gap-6 p-4"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
        >
          <button
            type="button"
            onClick={goPrev}
            disabled={index === 0}
            aria-label={t('viewer.previous')}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
            data-testid="viewer-prev"
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={index === ordered.length - 1}
            aria-label={t('viewer.next')}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
            data-testid="viewer-next"
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

// React.lazy requires a default export.
export default PageViewer;
