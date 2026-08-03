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
 *    `initialPageId`'s slide on mount. (Inline crop — Work Unit 2 — does NOT
 *    remount this screen: a crop session is a local `mode` flip, reset by the
 *    `currentPageId` safety-net effect, not a phase change. The mount scroll
 *    still matters for the standalone grid → `CornerEditor` re-entry, which
 *    does remount with a fresh `initialPageId`.)
 *  - **Filter strip**: `FilterPanel orientation="row"` — the same preset
 *    preview pipeline as the editor, laid out as a thin horizontal scroll bar.
 *    A tap writes the preset into the page recipe (`updateRecipe`, never a
 *    re-warp — D4); the grid/export pick it up straight from the recipe.
 *  - **Toolbar**: Volver a tomar (delete this page + back to camera, with the
 *    standard undo toast), Rotar izquierda (`rotateLeftRecipe`), Recortar
 *    (Work Unit 2: enters the INLINE crop sub-mode below — no longer
 *    navigates to the standalone `CornerEditor`), and the primary
 *    "Siguiente" → the overview grid.
 *
 * Memory: only the CURRENTLY shown page's `warpedBlob` is decoded (one live
 * `ImageBitmap`), closed before overwrite on page change and on unmount. Every
 * other page stays as its cached blob/thumbnail — peak live bitmap ≈ 1,
 * independent of document length (D-MEM), same invariant the rest of the
 * scanner holds.
 *
 * Inline auto-crop Work Unit 2 ("crop on tap" — the mode chosen over routing
 * to a separate screen): a local `mode: 'filter' | 'crop'` — always reset to
 * `'filter'` on any active-page change, so a crop session never persists
 * across a page switch — swaps the ACTIVE slide's `WarpedPreview`, the filter
 * strip, and the normal toolbar for `CropOverlay` (Work Unit 1's extracted,
 * bitmap-agnostic overlay) drawn over the page's PRE-WARP `originalBitmap`,
 * seeded from `recipe.corners` (the already-auto-detected quad — a manual
 * re-detect action is explicitly OUT OF SCOPE here), plus a Cancelar/Listo
 * toolbar. Reuses the exact `useActivePage` activate → rewarp → deactivate
 * lifecycle `ScannerScreen`'s grid re-entry drives for the standalone
 * `CornerEditor` (design section 2.2): "Listo" mirrors
 * `CornerEditor.runWarp`'s worker call and its `WARP_RESULT`/
 * `WARP_RESULT_IMAGEDATA` branches, then commits via `rewarpActivePage` +
 * `deactivateActivePage` — the same sequence
 * `ScannerScreen.handleActivePageConfirm` runs. D-MEM: while cropping, this
 * screen's OWN decoded filter-view base (`baseRef`) is released — crop shows
 * the ORIGINAL, not a filtered warp — so peak live full-res bitmaps stay at
 * `activeWorking`'s pair (2: `originalBitmap` + `warpedBase`), not 3.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Crop, Plus, RotateCcw } from 'lucide-react';
import { BackButton, Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { CropOverlay } from '@/features/scanner/components/CropOverlay';
import { FilterPanel } from '@/features/scanner/components/FilterPanel';
import { WarpedPreview } from '@/features/scanner/components/WarpedPreview';
import { useActivePage } from '@/features/scanner/hooks/useActivePage';
import { usePageDeletion } from '@/features/scanner/hooks/usePageDeletion';
import { isConvex } from '@/features/scanner/lib/geometry';
import { decodeBlobToBitmap } from '@/features/scanner/lib/pageResources';
import { recipeToCssTransform, rotateLeftRecipe, withFilter } from '@/features/scanner/lib/editRecipe';
import { buildThumbnailCssFilter } from '@/features/scanner/lib/filterPipeline';
import { getSharedWorkerClient } from '@/features/scanner/lib/workerClient';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { Quad } from '@/shared/types/geometry';
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

/**
 * Non-closing full-res `ImageData` extraction for the inline crop mode's
 * "Listo" re-warp — a deliberate small per-module duplicate of
 * `CornerEditor`'s own `extractImageData` (that file's module doc comment
 * explains why `CropOverlay` and its siblings stay free of cross-module
 * coupling here; `WarpedPreview.tsx` already carries the exact same copy for
 * the same reason). Does NOT close `bitmap` — unlike
 * `mainThreadImageData.ts`'s `bitmapToImageData`, which is unsuitable here
 * since `bitmap` is `activeWorking.originalBitmap`, OWNED by the store
 * (`useActivePage`/`deactivateActivePage` closes it), not by this call.
 */
function extractImageData(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('AdjustScreen: failed to acquire 2d context to extract full-res ImageData.');
  }
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  // Release the full-res (~48MB @12MP) backing store immediately — this helper
  // runs fresh on every "Listo" tap (unlike CornerEditor's once-per-session
  // memoized copy), so leaving it for GC risks iOS canvas-cap pressure (the
  // same reason the WARP_RESULT_IMAGEDATA branch below zeroes its canvas).
  canvas.width = 0;
  canvas.height = 0;
  return imageData;
}

export interface AdjustScreenProps {
  /** Page to show first — the just-cropped page when returning from the corner editor, else the first page. */
  readonly initialPageId: string | null;
  /** Reports the currently shown page id up so the caller can re-enter the same page after a crop round-trip. */
  readonly onPageChange: (pageId: string) => void;
  /**
   * Opens the standalone corner editor (crop/warp) for a page. Caller wires
   * `activatePage` → `'editing-corners'` with return-to-adjust. UNUSED by
   * this component as of Work Unit 2 (inline auto-crop) — "Recortar"/the
   * crop chip now enter an INLINE crop sub-mode instead (see the module doc
   * comment). Kept in the prop contract so `ScannerScreen`'s existing
   * grid → `CornerEditor` wiring (a separate call site, untouched by this
   * work unit) keeps compiling unchanged.
   */
  readonly onCrop: (pageId: string) => void;
  /** Advances to the overview grid. */
  readonly onNext: () => void;
  /** "Agregar más" → re-arm the camera to capture more pages (same as the grid's "Capturar más"). */
  readonly onAddMore: () => void;
  /** Back to the camera (navigation-ux, bug 3). */
  readonly onBack: () => void;
}

export function AdjustScreen({
  initialPageId,
  onPageChange,
  onCrop,
  onNext,
  onAddMore,
  onBack,
}: AdjustScreenProps): ReactNode {
  const { t } = useTranslation();
  const pages = useScannerStore((s) => s.pages);
  const updateRecipe = useScannerStore((s) => s.updateRecipe);
  const { deletePage } = usePageDeletion();
  // Inline crop mode (Work Unit 2): activates the page's pre-warp
  // `originalBitmap` for `CropOverlay` and persists a re-warp on "Listo" —
  // the exact same activate/rewarp/deactivate lifecycle `ScannerScreen`'s
  // grid re-entry uses for the standalone `CornerEditor` (design section
  // 2.2), just driven from this screen's own local `mode` instead of a
  // store-level phase change.
  const { activeWorking, activatePage, deactivateActivePage, rewarpActivePage } = useActivePage();

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

  // ── Inline crop sub-mode (Work Unit 2) ─────────────────────────────────
  // 'filter' is the default (filters carousel); "Recortar"/the crop chip
  // switch the ACTIVE slide into 'crop', rendering `CropOverlay` over the
  // page's pre-warp `originalBitmap` instead of the WarpedPreview + filter
  // strip. Never persists across a page switch (see the currentPageId-keyed
  // safety-net effect below) — the drag/warp/persist cycle is scoped to
  // whichever single page was active when crop was entered.
  const [mode, setMode] = useState<'filter' | 'crop'>('filter');
  const [draftCorners, setDraftCorners] = useState<Quad | null>(null);
  const [isWarping, setIsWarping] = useState(false);
  const [warpError, setWarpError] = useState(false);
  /**
   * The in-flight/completed `activatePage()` call a crop session started,
   * kept so Cancel/unmount/the page-change safety net can always pair it
   * with a matching `deactivateActivePage()` — even if the user backs out
   * WHILE `activatePage`'s decode is still resolving (the async gap between
   * `setMode('crop')` and `activeWorking` actually landing). Without this,
   * deactivating immediately would no-op (`activePageId` is still null at
   * that point) and the LATER-resolving activate would populate
   * `activeWorking` with nobody left to release it — a leaked full-res
   * bitmap pair.
   */
  const pendingActivationRef = useRef<Promise<void> | null>(null);
  /** Synchronous re-entrancy guard for "Listo" — `isWarping` state alone is not enough, since a double-tap can fire before React re-renders with the disabled button. */
  const warpInFlightRef = useRef(false);
  /**
   * Monotonic crop-session token (mirrors `CornerEditor`'s `warpSeqRef`, which
   * `AdjustScreen` can't get "for free" because — unlike CornerEditor — it is
   * NOT remounted per crop session). Bumped on every crop entry/cancel/page
   * change, so a warp still in flight from a PREVIOUS session (e.g.
   * Cancel-then-Recortar on the SAME page, where the `activeWorking.pageId`
   * guard alone can't tell the two activations apart) is discarded on resolve
   * instead of persisting a cancelled crop over a freshly re-entered one
   * (review finding H1).
   */
  const cropSessionRef = useRef(0);

  const cleanupCropActivation = useCallback((): void => {
    const pending = pendingActivationRef.current;
    if (!pending) return;
    pendingActivationRef.current = null;
    void pending
      .catch(() => {
        // activatePage rejecting here is defensive-only (the page is
        // guaranteed to exist when handleEnterCrop calls it) — nothing
        // meaningful to recover; just avoid an unhandled rejection while
        // still deactivating below.
      })
      .finally(() => {
        void deactivateActivePage();
      });
  }, [deactivateActivePage]);

  // Safety net (explicitly required behavior — never stay in crop mode
  // across a page switch): chevron/toolbar navigation is disabled while
  // cropping (see the toolbar/nav JSX below), but the horizontal preview
  // strip itself is still a native scroller — a stray swipe over the
  // CropOverlay canvas can still bring another slide into view and flip
  // `currentPageId` via the IntersectionObserver sync. Also runs (harmlessly)
  // on mount and on every ordinary page change — `setMode`/
  // `cleanupCropActivation` are no-ops when there was nothing to clean up.
  useEffect(() => {
    setMode('filter');
    // A page change ends any crop session (finding H1): invalidate an in-flight
    // warp and clear its UI flags so a stale resolve can't touch the new page.
    cropSessionRef.current += 1;
    warpInFlightRef.current = false;
    setIsWarping(false);
    cleanupCropActivation();
  }, [currentPageId, cleanupCropActivation]);

  useEffect(() => {
    // Inline crop mode (Work Unit 2) shows the pre-warp `originalBitmap`, not
    // this filtered warp base — skip decoding it while cropping (D-MEM: keeps
    // peak live bitmaps at `activeWorking`'s pair, not +1 for this too).
    // `mode` in the dependency array is what makes RETURNING to 'filter'
    // reliably restore this base even when nothing warp-related changed
    // (Cancelar) — `currentWarpedBlob` alone would not change in that case,
    // so without this dependency the effect would never re-fire and
    // `releaseFilterBase` below would leave the filter view permanently blank
    // after a Cancel.
    if (mode !== 'filter') return;
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
  }, [currentWarpedBlob, currentPageId, mode]);

  /**
   * Closes and releases the currently-decoded filter-view base bitmap.
   * Called on crop entry (D-MEM: crop shows the ORIGINAL, not this filtered
   * warp, so holding both simultaneously would push peak live bitmaps to 3
   * full-res images instead of 2). Returning to 'filter' mode needs no
   * mirror of this — the decode effect above re-populates `baseRef` on its
   * own once `mode` flips back (see that effect's `mode` dependency).
   */
  const releaseFilterBase = useCallback((): void => {
    if (!baseRef.current) return;
    baseRef.current.bitmap.close();
    baseRef.current = null;
    setBaseVersion((v) => v + 1);
  }, []);

  // Release the live base on unmount (F1 hygiene: never leak a decoded
  // bitmap). Also abandons any outstanding/active crop-mode `activatePage()`
  // (Work Unit 2) — AdjustScreen can unmount mid-crop (e.g. the trailing
  // "Agregar más" slide navigates away to 'capturing' while cropping), and
  // unlike an ordinary mode change nothing else would ever pair that
  // activation with a matching deactivate.
  useEffect(
    () => () => {
      baseRef.current?.bitmap.close();
      baseRef.current = null;
      cleanupCropActivation();
    },
    [cleanupCropActivation],
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
  // scrollLeft-0-then-jump flash. Mount-only by design. Inline crop (Work Unit
  // 2) never remounts this screen (it's a local `mode` flip), so it needs no
  // re-center here; the standalone grid → `CornerEditor` path DOES remount with
  // a fresh `initialPageId`, which this covers.
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

  // `onCrop` is kept in `AdjustScreenProps` (ScannerScreen still passes
  // `onCrop={handleAdjustCrop}` unchanged, per the grid<->CornerEditor path
  // this work unit deliberately leaves alone) but is no longer CALLED from
  // here — see the prop's own doc comment.
  void onCrop;

  const handleEnterCrop = useCallback(() => {
    if (!currentPage) return;
    // New crop session (finding H1): invalidate any warp still in flight from a
    // previous session on this same page and clear its lingering UI flags, so
    // this session starts clean and that stale warp is discarded on resolve.
    cropSessionRef.current += 1;
    warpInFlightRef.current = false;
    setIsWarping(false);
    releaseFilterBase();
    setDraftCorners(currentPage.recipe.corners);
    setWarpError(false);
    setMode('crop');
    pendingActivationRef.current = activatePage(currentPage.id);
  }, [currentPage, activatePage, releaseFilterBase]);

  const handleCropCancel = useCallback(() => {
    // Invalidate this session's in-flight warp so an explicitly-discarded crop
    // can never persist, and clear the warp UI flags (finding H1).
    cropSessionRef.current += 1;
    warpInFlightRef.current = false;
    setIsWarping(false);
    setMode('filter');
    cleanupCropActivation();
  }, [cleanupCropActivation]);

  /**
   * "Listo" — mirrors `CornerEditor.runWarp` (see that file's ~lines
   * 302-406): extract the full-res `ImageData` once, call the shared worker
   * client's `warp`, handle both `WARP_RESULT`/`WARP_RESULT_IMAGEDATA`
   * shapes, then persist via the SAME `rewarpActivePage` +
   * `deactivateActivePage` sequence `ScannerScreen.handleActivePageConfirm`
   * runs for the standalone editor's re-entry flow.
   */
  const handleCropDone = useCallback(() => {
    if (warpInFlightRef.current) return;
    // Narrows `activeWorking` (from `useActivePage()`, near the top of this
    // component) to the page currently being cropped — the same "belongs to
    // the right page" guard `cropActiveWorking` applies for the JSX below,
    // inlined here so this callback does not depend on a `const` declared
    // later in the render.
    if (!currentPage || !activeWorking || activeWorking.pageId !== currentPage.id) return;
    if (!draftCorners || !isConvex(draftCorners)) return;

    const pageId = currentPage.id;
    // Capture the session that started this warp, so a Cancel/re-enter/page
    // change that bumps `cropSessionRef` while the worker is busy makes this
    // warp discard itself on resolve (finding H1).
    const session = cropSessionRef.current;
    const aspectRatio = currentPage.recipe.aspectRatio;
    const corners = draftCorners;
    const baseRecipe = currentPage.recipe;
    const originalBitmap = activeWorking.originalBitmap;

    warpInFlightRef.current = true;
    setIsWarping(true);
    setWarpError(false);

    const performWarp = async (): Promise<void> => {
      try {
        const imageData = extractImageData(originalBitmap);
        const transferData = new Uint8ClampedArray(imageData.data);
        const response = await getSharedWorkerClient().warp(
          { width: imageData.width, height: imageData.height, data: transferData },
          corners,
          aspectRatio,
        );

        let freshWarpedBase: ImageBitmap;
        if (response.type === 'WARP_RESULT') {
          freshWarpedBase = response.bitmap;
        } else {
          // WARP_RESULT_IMAGEDATA fallback (no OffscreenCanvas) — mirrors
          // CornerEditor.runWarp verbatim: paint the plain pixel data into a
          // bitmap so the rest of this flow can treat both response shapes
          // identically.
          const canvas = document.createElement('canvas');
          canvas.width = response.image.width;
          canvas.height = response.image.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            throw new Error('AdjustScreen: failed to acquire 2d context for WARP_RESULT_IMAGEDATA.');
          }
          const pixelData = new Uint8ClampedArray(response.image.data);
          const painted = new ImageData(pixelData, response.image.width, response.image.height);
          ctx.putImageData(painted, 0, 0);
          freshWarpedBase = await createImageBitmap(canvas);
          // Release the temporary main-thread canvas backing store as soon as
          // the bitmap is created (mirrors CornerEditor's own fix M4).
          canvas.width = 0;
          canvas.height = 0;
        }

        // Guard the async gap: if this page is no longer the active one by
        // the time the warp resolves (the page-change safety net already
        // deactivated it — e.g. a stray swipe bounced the user out of crop,
        // or Cancelar landed while this warp was in flight), nobody owns
        // this fresh bitmap anymore. Close it rather than leak it or
        // resurrect a stale `activeWorking` (mirrors CornerEditor.runWarp's
        // own "close a superseded result" discipline).
        // Discard if superseded: the crop session changed (Cancel, or
        // Cancel-then-Recortar on the SAME page — finding H1), or the active
        // page is no longer the one we cropped.
        if (cropSessionRef.current !== session || useScannerStore.getState().activeWorking?.pageId !== pageId) {
          freshWarpedBase.close();
          return;
        }

        // This activation is about to be retired by the explicit deactivate
        // below — nothing left for the safety net/unmount cleanup to do.
        pendingActivationRef.current = null;
        rewarpActivePage({ pageId, freshWarpedBase, recipe: { ...baseRecipe, corners } });
        await deactivateActivePage();
        setMode('filter');
      } catch {
        // Surface the error only if this warp's session is still current — a
        // superseded session (Cancel/re-enter) must not paint its error onto
        // the session that replaced it (finding H1).
        if (cropSessionRef.current === session) {
          setWarpError(true);
        }
      } finally {
        // Clear the in-flight/warping flags only for the current session — a
        // stale warp resolving must not reset flags a newer session now owns.
        // (Cancel/enter/page-change already cleared them for their own session.)
        if (cropSessionRef.current === session) {
          warpInFlightRef.current = false;
          setIsWarping(false);
        }
      }
    };

    void performWarp();
  }, [currentPage, activeWorking, draftCorners, rewarpActivePage, deactivateActivePage]);

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

  // `activeWorking` only once it actually belongs to the page being cropped
  // — mirrors `base`'s own page-id-tagged guard above (same async-gap
  // reasoning: `activatePage`'s decode is in flight for a beat after
  // `handleEnterCrop` sets `mode`, during which `activeWorking` can still be
  // null or, briefly mid page-switch, belong to a DIFFERENT page).
  const cropActiveWorking = activeWorking && activeWorking.pageId === currentPageId ? activeWorking : null;
  const cropReady = cropActiveWorking !== null && draftCorners !== null;

  if (!currentPage) {
    // Defensive: adjust is only entered with ≥1 page; render nothing rather
    // than crash on the transient frame before a "Volver a tomar" unmounts us.
    return null;
  }

  const { recipe, warpedWidth, warpedHeight } = currentPage;

  return (
    <div
      className="relative flex h-full w-full flex-col bg-black text-white"
      // PWA safe area (iOS standalone): the preview strip sits at the very top,
      // so clear the notch inset (the bottom toolbar already insets itself).
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
      data-testid="adjust-screen"
    >
      {/* Back to the camera (navigation-ux, bug 3). Absolutely positioned over
          the preview strip rather than given its own row: this screen is
          height-constrained by design (the strip, page-nav, filter strip and
          toolbar all have to fit without the page scrolling), so a new row
          would push the toolbar off the bottom on short phones. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 p-2" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}>
        <div className="pointer-events-auto inline-flex">
          <BackButton onClick={onBack} tone="overlay" testId="adjust-back" />
        </div>
      </div>

      {/* Preview strip: a REAL slide per page + the "add more" panel (bug 6) —
          slides are narrower than the strip (w-[85%]) with matching scroller
          padding so neighbors peek at both edges (bug 3 discoverability).
          `min-h-0` lets this flex child SHRINK below its content's intrinsic
          height — without it a very tall page preview would grow this strip and
          push the page-nav / filter / toolbar off the bottom of the screen. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollerRef}
          className="flex h-full snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden px-[7.5%]"
          data-testid="adjust-preview-strip"
        >
          {pages.map((page, index) => {
            const isActive = index === safeIndex;
            // Fit the preview by HEIGHT (user request): cap the card width to
            // `availableHeight * aspect` via container-query height units
            // (`100cqh` of the size-contained slide). A very tall page then
            // shrinks to fit the strip's height instead of overflowing and
            // pushing the page-nav / filter / toolbar off screen. `min(20rem, …)`
            // keeps the original cap for short pages; if `cqh` is unsupported the
            // whole `min()` is dropped and `max-w-xs` + `max-h-full` +
            // `overflow-hidden` still keep the toolbar on screen (graceful
            // degrade to clip-instead-of-scale). Rotation-aware.
            const rotated = page.recipe.rotation === 90 || page.recipe.rotation === 270;
            const dispW = rotated ? page.warpedHeight : page.warpedWidth;
            const dispH = rotated ? page.warpedWidth : page.warpedHeight;
            return (
              <section
                key={page.id}
                ref={(el) => {
                  slideRefs.current[index] = el;
                }}
                data-slide-index={index}
                data-testid={`adjust-page-slide-${page.id}`}
                className="flex h-full w-[85%] shrink-0 snap-center items-center justify-center p-4"
                style={{ containerType: 'size' }}
              >
                <div
                  className={`relative max-h-full w-full max-w-xs overflow-hidden rounded-lg bg-neutral-900 transition-[opacity,transform] duration-200 ${
                    isActive
                      ? 'scale-100 opacity-100 shadow-[0_20px_50px_rgba(0,0,0,0.55)]'
                      : 'scale-[0.92] opacity-55'
                  }`}
                  style={{ maxWidth: `min(20rem, calc(100cqh * ${dispW} / ${dispH}))` }}
                >
                  {isActive && mode === 'crop' ? (
                    cropActiveWorking && draftCorners ? (
                      // Inline crop mode (Work Unit 2): the pre-warp original,
                      // not the filtered warp — CropOverlay is bitmap-agnostic
                      // (Work Unit 1) and owns none of the warp/persist logic.
                      <CropOverlay
                        bitmap={cropActiveWorking.originalBitmap}
                        width={cropActiveWorking.originalBitmap.width}
                        height={cropActiveWorking.originalBitmap.height}
                        corners={draftCorners}
                        onCornersChange={setDraftCorners}
                        valid={isConvex(draftCorners)}
                      />
                    ) : (
                      // `activatePage`'s decode is still in flight (the async
                      // gap between tapping "Recortar"/the chip and
                      // `activeWorking` actually landing).
                      <p
                        className="flex aspect-[3/4] w-full items-center justify-center text-sm text-white/70"
                        data-testid="adjust-crop-loading"
                        role="status"
                        aria-live="polite"
                      >
                        {t('common.processing')}
                      </p>
                    )
                  ) : isActive && base ? (
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

                  {isActive && mode === 'filter' && (
                    // Small tappable chip — a second entry point into the SAME
                    // inline crop mode as the toolbar's "Recortar" (Work Unit 2).
                    <button
                      type="button"
                      onClick={handleEnterCrop}
                      data-testid="adjust-crop-chip"
                      className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
                    >
                      <Crop size={14} strokeWidth={1.5} aria-hidden="true" />
                      {t('adjust.cropChip')}
                    </button>
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

      {/* Page navigation ‹ n / N › — disabled while cropping (Work Unit 2):
          navigating away mid-crop is caught by the currentPageId safety net
          regardless, but disabling here keeps it from being reachable via
          the ordinary tap path in the first place. */}
      <div className="flex items-center justify-center gap-6 py-2" data-testid="adjust-page-nav">
        <button
          type="button"
          onClick={goPrev}
          disabled={safeIndex === 0 || mode === 'crop'}
          aria-label={t('adjust.prevPage')}
          className="flex h-[38px] w-[38px] items-center justify-center rounded-full border border-white/10 bg-surface/90 text-white disabled:opacity-30"
          data-testid="adjust-prev-page"
        >
          <ChevronLeft size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <span
          className="min-w-[3rem] text-center text-sm font-semibold tabular-nums text-white/90"
          data-testid="adjust-page-counter"
        >
          {safeIndex + 1} / {pages.length}
        </span>
        <button
          type="button"
          onClick={goNext}
          disabled={safeIndex >= pages.length - 1 || mode === 'crop'}
          aria-label={t('adjust.nextPage')}
          className="flex h-[38px] w-[38px] items-center justify-center rounded-full border border-white/10 bg-surface/90 text-white disabled:opacity-30"
          data-testid="adjust-next-page"
        >
          <ChevronRight size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      {/* Filter strip (horizontal) in 'filter' mode; a warp status line in
          'crop' mode (Work Unit 2) — same fixed-height slot either way so
          switching modes never jumps the layout. */}
      <div className="px-3" data-testid="adjust-filter-strip">
        {mode === 'crop' ? (
          <div className="flex h-[4.5rem] items-center justify-center" data-testid="adjust-crop-status">
            {isWarping && (
              <p
                className="text-sm text-white/70"
                data-testid="adjust-crop-warp-loading"
                role="status"
                aria-live="polite"
              >
                {t('common.processing')}
              </p>
            )}
            {warpError && (
              <p className="text-sm text-danger" data-testid="adjust-crop-warp-error" role="alert">
                {t('editor.processError')}
              </p>
            )}
          </div>
        ) : base ? (
          <FilterPanel baseBitmap={base} filter={recipe.filter} onChange={handleFilterChange} orientation="row" />
        ) : (
          <div className="h-[4.5rem]" aria-hidden="true" />
        )}
      </div>

      {mode === 'crop' ? (
        /* Crop toolbar: Cancelar · Listo (Work Unit 2) — replaces the normal
           toolbar entirely while cropping so there is no ambiguity between
           "confirm the crop" and the filter-mode retake/rotate/next actions. */
        <div
          className="grid grid-cols-2 items-center gap-2 border-t border-white/10 bg-black/60 px-3 py-3"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
          data-testid="adjust-crop-toolbar"
        >
          <Button type="button" variant="ghost" onClick={handleCropCancel} data-testid="adjust-crop-cancel">
            {t('adjust.cropCancel')}
          </Button>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="primary"
              onClick={handleCropDone}
              disabled={!cropReady || !draftCorners || !isConvex(draftCorners) || isWarping}
              data-testid="adjust-crop-done"
            >
              {t('adjust.cropDone')}
            </Button>
          </div>
        </div>
      ) : (
        /* Bottom toolbar: retake · rotate-left · crop · next */
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
          <ToolbarButton icon={<Crop size={20} strokeWidth={1.5} />} label={t('adjust.crop')} onClick={handleEnterCrop} testId="adjust-crop" />
          <div className="flex justify-end">
            <Button type="button" variant="primary" onClick={onNext} data-testid="adjust-next">
              {t('adjust.next')}
            </Button>
          </div>
        </div>
      )}
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
