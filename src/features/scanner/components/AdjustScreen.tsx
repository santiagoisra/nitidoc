/**
 * Per-page review + adjust screen (CamScanner-style), rendered for
 * `phase === 'adjust'` — the step BETWEEN deferred `processing` and the
 * overview `grid`. Requested by the user (a UXer): after "Siguiente" from the
 * capture screen, land on a full-bleed page-by-page review with the filters
 * visible and a working crop tool, exactly like CamScanner's adjust page.
 *
 * Layout (top → bottom, full-height immersive shell):
 *  - **Preview strip** (`flex-1`, horizontal scroll-snap): a REAL N-page
 *    carousel — one slide per page (index `0..pages.length-1`) plus the
 *    "Agregar más" panel as the final slide (bug 6 fix: this used to be a
 *    fixed 2-slide strip — current page / add-more — even though the page
 *    counter already read `n / N`; swiping never actually paged through the
 *    document). Slides are `w-[85%]` (not `w-full`) with matching scroller
 *    padding so neighbors PEEK at both edges, and a right-edge dashed-line +
 *    chevron hint shows whenever the user isn't already on the last slide
 *    (bug 3 fix: the "swipe left for more" affordance was undiscoverable).
 *    Only the ACTIVE (centered) slide renders the full-res, live-filtered
 *    `WarpedPreview` over the single decoded `baseRef` bitmap; every other
 *    page slide renders that page's already-resident `thumbnail` bitmap
 *    (D-MEM — never decodes another blob) via `PageSlideThumbnail`, visually
 *    attenuated (opacity/scale) to read as "not active". An
 *    `IntersectionObserver` on the scroller keeps the active index in sync
 *    with whatever slide the user actually scrolled to (highest intersection
 *    ratio wins, clamped so the "Agregar más" slide never becomes a page
 *    index), guarded by a `programmaticScrollRef` flag so a chevron/mount-
 *    triggered smooth scroll doesn't fight its own resulting intersection
 *    events mid-animation.
 *  - **Page nav** (`‹ n / N ›`): steps between pages; each step
 *    programmatically scrolls the strip to the target slide (`scrollIntoView`,
 *    via `scrollToIndex`) AND re-decodes the new page's warp base (memory
 *    stays bounded to ONE live decoded base — close-before-overwrite, mirrors
 *    the layered-memory discipline). The strip also scrolls to
 *    `initialPageId`'s slide on mount — which doubles as the crop round-trip
 *    re-center, since a confirm/cancel remounts this screen with a fresh
 *    `initialPageId` (`onPageChange`/`initialPageId` wiring, owned by the
 *    caller).
 *  - **Filter strip**: `FilterPanel orientation="row"` — the same preset
 *    preview pipeline as the editor, laid out as a thin horizontal scroll bar.
 *    A tap writes the preset into the page recipe (`updateRecipe`, never a
 *    re-warp — D4); the grid/export pick it up straight from the recipe.
 *  - **Toolbar**: Volver a tomar (delete this page + back to camera, with the
 *    standard undo toast), Rotar izquierda (`rotateLeftRecipe`), Recortar
 *    (opens the existing `CornerEditor` for this page via `onCrop`), and the
 *    primary "Siguiente" → the overview grid.
 *
 * Memory: only the CURRENTLY shown page's `warpedBlob` is decoded (one live
 * `ImageBitmap`), closed before overwrite on page change and on unmount. Every
 * other page stays as its cached blob/thumbnail — peak live bitmap ≈ 1,
 * independent of document length (D-MEM), same invariant the rest of the
 * scanner holds.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Crop, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { FilterPanel } from '@/features/scanner/components/FilterPanel';
import { WarpedPreview } from '@/features/scanner/components/WarpedPreview';
import { usePageDeletion } from '@/features/scanner/hooks/usePageDeletion';
import { decodeBlobToBitmap } from '@/features/scanner/lib/pageResources';
import { recipeToCssTransform, rotateLeftRecipe, withFilter } from '@/features/scanner/lib/editRecipe';
import { buildThumbnailCssFilter } from '@/features/scanner/lib/filterPipeline';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { FilterParams } from '@/shared/types/scanner';

/**
 * How long a programmatic (`scrollIntoView`) scroll is assumed to still be
 * animating — the `IntersectionObserver` sync ignores intersection updates
 * while `programmaticScrollRef` is set, clearing it this long after the most
 * recent `scrollToIndex` call (comfortably covers a `behavior: 'smooth'`
 * single-slide scroll; an `'auto'` jump settles far sooner). Guards against
 * the feedback loop where a chevron tap's own resulting scroll would
 * otherwise immediately re-fire `setCurrentIndex` via the observer mid-
 * animation.
 */
const PROGRAMMATIC_SCROLL_SETTLE_MS = 450;

export interface AdjustScreenProps {
  /** Page to show first — the just-cropped page when returning from the corner editor, else the first page. */
  readonly initialPageId: string | null;
  /** Reports the currently shown page id up so the caller can re-enter the same page after a crop round-trip. */
  readonly onPageChange: (pageId: string) => void;
  /** Opens the corner editor (crop/warp) for a page. Caller wires activatePage → 'editing-corners' with return-to-adjust. */
  readonly onCrop: (pageId: string) => void;
  /** Advances to the overview grid. */
  readonly onNext: () => void;
  /** "Agregar más" → re-arm the camera to capture more pages (same as the grid's "Capturar más"). */
  readonly onAddMore: () => void;
}

export function AdjustScreen({ initialPageId, onPageChange, onCrop, onNext, onAddMore }: AdjustScreenProps): ReactNode {
  const { t } = useTranslation();
  const pages = useScannerStore((s) => s.pages);
  const updateRecipe = useScannerStore((s) => s.updateRecipe);
  const { deletePage } = usePageDeletion();

  const initialIndex = useMemo(() => {
    const found = pages.findIndex((p) => p.id === initialPageId);
    return found >= 0 ? found : 0;
  }, [pages, initialPageId]);

  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  // Clamp defensively — `pages` can only shrink via a "Volver a tomar" that
  // immediately navigates away, but guard so an out-of-range index never
  // indexes `undefined` on the render that precedes the unmount.
  const safeIndex = Math.min(currentIndex, Math.max(0, pages.length - 1));
  const currentPage = pages[safeIndex];

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Per-slide DOM refs, indexed 0..pages.length-1 for page slides and
  // `pages.length` for the trailing "Agregar más" slide — populated by each
  // slide's own callback ref below. Used both to scroll a target slide into
  // view (`scrollToIndex`) and as the `IntersectionObserver`'s observed set.
  const slideRefs = useRef<Array<HTMLElement | null>>([]);

  // ── One live decoded warp base for the current page (close-before-overwrite) ──
  // Tagged with the page id its bitmap belongs to: on a page switch the active
  // index updates synchronously while the new page's decode is still async, so
  // an untagged base would let the PREVIOUS page's pixels render into the new
  // page's box (wrong content, stretched to the new dimensions). Tagging lets
  // the render fall back to the page's thumbnail until the right base lands.
  const baseRef = useRef<{ pageId: string; bitmap: ImageBitmap } | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const decodeSeqRef = useRef(0);
  const currentWarpedBlob = currentPage?.warpedBlob ?? null;
  const currentPageId = currentPage?.id ?? null;

  useEffect(() => {
    if (!currentWarpedBlob || !currentPageId) return;
    const pageId = currentPageId;
    const seq = (decodeSeqRef.current += 1);
    let cancelled = false;
    void decodeBlobToBitmap(currentWarpedBlob)
      .then((bitmap) => {
        if (cancelled || seq !== decodeSeqRef.current) {
          bitmap.close();
          return;
        }
        baseRef.current?.bitmap.close();
        baseRef.current = { pageId, bitmap };
        setBaseVersion((v) => v + 1);
      })
      .catch(() => {
        // Decode failure leaves the last base in place — non-fatal; the strip
        // still lets the user pick a filter (written straight into the recipe).
      });
    return () => {
      cancelled = true;
    };
  }, [currentWarpedBlob, currentPageId]);

  // Release the live base on unmount (F1 hygiene: never leak a decoded bitmap).
  useEffect(
    () => () => {
      baseRef.current?.bitmap.close();
      baseRef.current = null;
    },
    [],
  );

  // Keep the caller's "return to this page after a crop" target in sync.
  useEffect(() => {
    if (currentPageId) onPageChange(currentPageId);
  }, [currentPageId, onPageChange]);

  // Guards the IntersectionObserver sync below from fighting a
  // chevron/mount/crop-return-triggered programmatic scroll while its
  // (possibly smooth) animation is still in flight — see the module doc
  // comment's "Guard against feedback loops" note and
  // `PROGRAMMATIC_SCROLL_SETTLE_MS`.
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef<number | null>(null);

  const scrollToIndex = useCallback((index: number, behavior: ScrollBehavior) => {
    const target = slideRefs.current[index];
    if (!target) return;
    programmaticScrollRef.current = true;
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
    }
    programmaticScrollTimeoutRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, PROGRAMMATIC_SCROLL_SETTLE_MS);
    target.scrollIntoView({ behavior, inline: 'center', block: 'nearest' });
  }, []);

  // Clear any pending settle-timeout on unmount (hygiene; the ref flag itself
  // needs no cleanup since the component is gone).
  useEffect(
    () => () => {
      if (programmaticScrollTimeoutRef.current !== null) {
        window.clearTimeout(programmaticScrollTimeoutRef.current);
      }
    },
    [],
  );

  // On mount, land on `initialPageId`'s slide instantly (no animation) —
  // `useLayoutEffect` so this resolves before the browser paints, avoiding a
  // scrollLeft-0-then-jump flash. Mount-only by design: a crop round-trip
  // remounts this whole screen with a fresh `initialPageId` (the caller swaps
  // to `CornerEditor` and back), so "on mount" already covers "after crop".
  useLayoutEffect(() => {
    scrollToIndex(initialIndex, 'auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whether the user has swiped past the last PAGE onto the trailing "Agregar
  // más" slide — tracked separately from `currentIndex` (which only ever
  // holds a valid PAGE index, see the observer callback below) so the bug 3
  // "swipe for more" hint can hide once there is nothing further to reveal.
  const [onLastSlide, setOnLastSlide] = useState(false);
  const intersectionRatiosRef = useRef<Map<number, number>>(new Map());

  // Sync scroll -> active index (bug 6): whichever slide has the highest
  // intersection ratio against the scroller becomes the active page index.
  // Re-observes whenever the slide count changes (page added/removed).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof IntersectionObserver === 'undefined') {
      // Feature-detect: IntersectionObserver is either absent, or (as in
      // this project's happy-dom unit-test environment) present but its
      // `observe()` never actually invokes the callback. Either way, chevron
      // and mount navigation still work via `scrollToIndex` + direct
      // `setCurrentIndex`; this only skips the SWIPE -> active-index sync,
      // which real-browser/manual testing has to cover instead (see this
      // component's test suite for the documented limitation).
      return;
    }

    intersectionRatiosRef.current = new Map();
    const totalSlides = pages.length + 1; // + the trailing "Agregar más" slide.

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const raw = (entry.target as HTMLElement).dataset.slideIndex;
          if (raw === undefined) continue;
          intersectionRatiosRef.current.set(Number(raw), entry.intersectionRatio);
        }

        // Ignore while a chevron/mount-triggered scroll is still animating —
        // its OWN call site already set `currentIndex` optimistically.
        if (programmaticScrollRef.current) return;

        let bestIndex = -1;
        let bestRatio = 0;
        intersectionRatiosRef.current.forEach((ratio, index) => {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIndex = index;
          }
        });
        if (bestIndex < 0) return;

        setOnLastSlide(bestIndex >= pages.length);
        // Clamp: the "Agregar más" slide (index === pages.length) must never
        // become a page index.
        if (bestIndex < pages.length) {
          setCurrentIndex(bestIndex);
        }
      },
      { root: scroller, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    slideRefs.current.slice(0, totalSlides).forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [pages.length]);

  const goPrev = useCallback(() => {
    const target = Math.max(0, safeIndex - 1);
    setCurrentIndex(target);
    scrollToIndex(target, 'smooth');
  }, [safeIndex, scrollToIndex]);

  const goNext = useCallback(() => {
    const target = Math.min(pages.length - 1, safeIndex + 1);
    setCurrentIndex(target);
    scrollToIndex(target, 'smooth');
  }, [pages.length, safeIndex, scrollToIndex]);

  const handleFilterChange = useCallback(
    (filter: FilterParams) => {
      if (!currentPage) return;
      updateRecipe(currentPage.id, withFilter(currentPage.recipe, filter));
    },
    [currentPage, updateRecipe],
  );

  const handleRotateLeft = useCallback(() => {
    if (!currentPage) return;
    updateRecipe(currentPage.id, rotateLeftRecipe(currentPage.recipe));
  }, [currentPage, updateRecipe]);

  const handleCrop = useCallback(() => {
    if (currentPage) onCrop(currentPage.id);
  }, [currentPage, onCrop]);

  const handleRetake = useCallback(() => {
    if (!currentPage) return;
    // Delete this page (with the standard 5s undo toast) then re-open the
    // camera so the user can re-shoot — CamScanner's "Volver a tomar".
    deletePage(currentPage.id);
    onAddMore();
  }, [currentPage, deletePage, onAddMore]);

  // Only surface the live base when it actually belongs to the ACTIVE page.
  // During the decode gap right after a page switch, `baseRef` still holds the
  // previous page's bitmap — drawing it here would stretch the wrong page's
  // pixels into the new page's box (HIGH-severity review finding), so fall back
  // to null (→ the page's thumbnail) until the matching decode resolves.
  const base = baseRef.current?.pageId === currentPageId ? baseRef.current.bitmap : null;
  void baseVersion; // re-render trigger off the ref mutation

  if (!currentPage) {
    // Defensive: adjust is only entered with ≥1 page; render nothing rather
    // than crash on the transient frame before a "Volver a tomar" unmounts us.
    return null;
  }

  const { recipe, warpedWidth, warpedHeight } = currentPage;

  return (
    <div className="flex h-full w-full flex-col bg-black text-white" data-testid="adjust-screen">
      {/* Preview strip: a REAL slide per page + the "add more" panel (bug 6) —
          slides are narrower than the strip (w-[85%]) with matching scroller
          padding so neighbors peek at both edges (bug 3 discoverability). */}
      <div className="relative flex-1">
        <div
          ref={scrollerRef}
          className="flex h-full snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden px-[7.5%]"
          data-testid="adjust-preview-strip"
        >
          {pages.map((page, index) => {
            const isActive = index === safeIndex;
            return (
              <section
                key={page.id}
                ref={(el) => {
                  slideRefs.current[index] = el;
                }}
                data-slide-index={index}
                data-testid={`adjust-page-slide-${page.id}`}
                className="flex h-full w-[85%] shrink-0 snap-center items-center justify-center p-4"
              >
                <div
                  className={`w-full max-w-xs overflow-hidden rounded-xl bg-neutral-900 transition-[opacity,transform] duration-200 ${
                    isActive ? 'scale-100 opacity-100' : 'scale-[0.92] opacity-55'
                  }`}
                >
                  {isActive && base ? (
                    <WarpedPreview
                      bitmap={base}
                      filter={recipe.filter}
                      transform={recipeToCssTransform(recipe)}
                      outSize={{ outW: warpedWidth, outH: warpedHeight }}
                      rotation={recipe.rotation}
                      testId="adjust-warped-preview"
                    />
                  ) : (
                    // Non-active slides — and the active slide during its decode
                    // gap — both show the page's resident thumbnail. The active
                    // one is un-attenuated (see the wrapper), so a page switch
                    // reads as a progressive low-res → full-res load rather than
                    // a "processing" flash or (worse) the wrong page's pixels.
                    <PageSlideThumbnail page={page} testId={`adjust-page-slide-thumb-${page.id}`} />
                  )}
                </div>
              </section>
            );
          })}

          <button
            type="button"
            ref={(el) => {
              slideRefs.current[pages.length] = el;
            }}
            data-slide-index={pages.length}
            onClick={onAddMore}
            className="flex h-full w-[85%] shrink-0 snap-center flex-col items-center justify-center gap-3 p-4 text-white/80"
            data-testid="adjust-add-more"
          >
            <span className="flex h-24 w-20 items-center justify-center rounded-xl border-2 border-dashed border-white/40">
              <Plus size={32} strokeWidth={1.5} aria-hidden="true" />
            </span>
            <span className="text-sm font-medium">{t('adjust.addMore')}</span>
          </button>
        </div>

        {/* Bug 3 affordance: hints "swipe for more" (another page, or at
            least the "Agregar más" panel) whenever the user isn't already on
            the last slide. Purely visual — never blocks the scroll strip's
            own pointer events. */}
        {!onLastSlide && (
          <div
            className="pointer-events-none absolute inset-y-0 right-0 flex w-14 items-center justify-end bg-gradient-to-l from-black/40 to-transparent pr-2"
            data-testid="adjust-more-hint"
            aria-hidden="true"
          >
            <div className="mr-2 h-3/5 border-r-2 border-dashed border-white/50" />
            <ChevronRight size={18} strokeWidth={1.5} className="animate-pulse text-white/70" />
          </div>
        )}
      </div>

      {/* Page navigation ‹ n / N › */}
      <div className="flex items-center justify-center gap-6 py-2" data-testid="adjust-page-nav">
        <button
          type="button"
          onClick={goPrev}
          disabled={safeIndex === 0}
          aria-label={t('adjust.prevPage')}
          className="rounded-full p-2 text-white disabled:opacity-30"
          data-testid="adjust-prev-page"
        >
          <ChevronLeft size={22} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <span className="min-w-[3rem] text-center text-sm tabular-nums text-white/90" data-testid="adjust-page-counter">
          {safeIndex + 1} / {pages.length}
        </span>
        <button
          type="button"
          onClick={goNext}
          disabled={safeIndex >= pages.length - 1}
          aria-label={t('adjust.nextPage')}
          className="rounded-full p-2 text-white disabled:opacity-30"
          data-testid="adjust-next-page"
        >
          <ChevronRight size={22} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      {/* Filter strip (horizontal). Only renders once the base is decoded. */}
      <div className="px-3" data-testid="adjust-filter-strip">
        {base ? (
          <FilterPanel baseBitmap={base} filter={recipe.filter} onChange={handleFilterChange} orientation="row" />
        ) : (
          <div className="h-[4.5rem]" aria-hidden="true" />
        )}
      </div>

      {/* Bottom toolbar: retake · rotate-left · crop · next */}
      <div
        className="grid grid-cols-4 items-center gap-2 border-t border-white/10 bg-black/60 px-3 py-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        data-testid="adjust-toolbar"
      >
        <ToolbarButton icon={<Camera size={20} strokeWidth={1.5} />} label={t('adjust.retake')} onClick={handleRetake} testId="adjust-retake" />
        <ToolbarButton
          icon={<RotateCcw size={20} strokeWidth={1.5} />}
          label={t('adjust.rotateLeft')}
          onClick={handleRotateLeft}
          testId="adjust-rotate-left"
        />
        <ToolbarButton icon={<Crop size={20} strokeWidth={1.5} />} label={t('adjust.crop')} onClick={handleCrop} testId="adjust-crop" />
        <div className="flex justify-end">
          <Button type="button" variant="primary" onClick={onNext} data-testid="adjust-next">
            {t('adjust.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ToolbarButtonProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly testId: string;
}

/** One icon-over-label toolbar action (retake/rotate/crop), matching the CamScanner adjust toolbar layout. */
function ToolbarButton({ icon, label, onClick, testId }: ToolbarButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex flex-col items-center gap-1 rounded-lg py-1 text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
    >
      <span aria-hidden="true">{icon}</span>
      <span className="text-[11px] leading-tight">{label}</span>
    </button>
  );
}

interface PageSlideThumbnailProps {
  readonly page: DocumentPage;
  readonly testId?: string;
}

/**
 * Non-active carousel slide preview (bug 6, N-page carousel). Draws the
 * page's already-resident ~150px `thumbnail` `ImageBitmap` — NEVER decodes a
 * blob, mirrors `PageThumbnail`'s own draw contract (D-MEM: inactive pages
 * only ever carry a cached thumbnail, never a live full-res bitmap) —
 * applying the same `buildThumbnailCssFilter` CSS approximation so a page's
 * filter stays visually consistent with the active slide's accurate
 * `WarpedPreview` render. Sized to roughly fill the slide's own box
 * (`max-w-xs`, set by the caller) rather than `PageThumbnail`'s small
 * fixed-height tray-tile size — the caller also applies the "not active"
 * opacity/scale attenuation on the wrapping box, so this component only
 * ever draws a plain, undimmed thumbnail.
 */
function PageSlideThumbnail({ page, testId }: PageSlideThumbnailProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = page.thumbnail.width;
    canvas.height = page.thumbnail.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.filter = buildThumbnailCssFilter(page.recipe.filter);
    ctx.drawImage(page.thumbnail, 0, 0);
    ctx.filter = 'none';
  }, [page.thumbnail, page.recipe.filter]);

  return (
    <canvas
      ref={canvasRef}
      className="aspect-[3/4] w-full rounded-xl bg-neutral-900 object-contain"
      data-testid={testId}
      aria-hidden="true"
    />
  );
}

// React.lazy requires a default export (ScannerScreen lazy-loads this screen).
export default AdjustScreen;
