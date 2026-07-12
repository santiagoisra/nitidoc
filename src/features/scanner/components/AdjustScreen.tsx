/**
 * Per-page review + adjust screen (CamScanner-style), rendered for
 * `phase === 'adjust'` — the step BETWEEN deferred `processing` and the
 * overview `grid`. Requested by the user (a UXer): after "Siguiente" from the
 * capture screen, land on a full-bleed page-by-page review with the filters
 * visible and a working crop tool, exactly like CamScanner's adjust page.
 *
 * Layout (top → bottom, full-height immersive shell):
 *  - **Preview strip** (`flex-1`, horizontal scroll-snap): slide 0 shows the
 *    CURRENT page crisply (`WarpedPreview` over its decoded, UNFILTERED warp
 *    base, reflecting the live filter + rotation/flip); slide 1 is the
 *    "Agregar más" panel — scrolling the preview LEFT reveals it (design ask),
 *    and it does exactly what the capture screen's "Capturar más" does
 *    (`onAddMore` → `capturing`).
 *  - **Page nav** (`‹ n / N ›`): steps between pages; each step re-decodes the
 *    new page's warp base (memory stays bounded to ONE live decoded base —
 *    close-before-overwrite, mirrors the layered-memory discipline).
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Crop, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { FilterPanel } from '@/features/scanner/components/FilterPanel';
import { WarpedPreview } from '@/features/scanner/components/WarpedPreview';
import { usePageDeletion } from '@/features/scanner/hooks/usePageDeletion';
import { decodeBlobToBitmap } from '@/features/scanner/lib/pageResources';
import { recipeToCssTransform, rotateLeftRecipe, withFilter } from '@/features/scanner/lib/editRecipe';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { FilterParams } from '@/shared/types/scanner';

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

  // ── One live decoded warp base for the current page (close-before-overwrite) ──
  const baseRef = useRef<ImageBitmap | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const decodeSeqRef = useRef(0);
  const currentWarpedBlob = currentPage?.warpedBlob ?? null;

  useEffect(() => {
    if (!currentWarpedBlob) return;
    const seq = (decodeSeqRef.current += 1);
    let cancelled = false;
    void decodeBlobToBitmap(currentWarpedBlob)
      .then((bitmap) => {
        if (cancelled || seq !== decodeSeqRef.current) {
          bitmap.close();
          return;
        }
        baseRef.current?.close();
        baseRef.current = bitmap;
        setBaseVersion((v) => v + 1);
      })
      .catch(() => {
        // Decode failure leaves the last base in place — non-fatal; the strip
        // still lets the user pick a filter (written straight into the recipe).
      });
    return () => {
      cancelled = true;
    };
  }, [currentWarpedBlob]);

  // Release the live base on unmount (F1 hygiene: never leak a decoded bitmap).
  useEffect(
    () => () => {
      baseRef.current?.close();
      baseRef.current = null;
    },
    [],
  );

  // Keep the caller's "return to this page after a crop" target in sync.
  const currentPageId = currentPage?.id ?? null;
  useEffect(() => {
    if (currentPageId) onPageChange(currentPageId);
  }, [currentPageId, onPageChange]);

  const scrollToPage = useCallback(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ left: 0, behavior: 'smooth' });
  }, []);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
    scrollToPage();
  }, [scrollToPage]);

  const goNext = useCallback(() => {
    setCurrentIndex((i) => Math.min(pages.length - 1, i + 1));
    scrollToPage();
  }, [pages.length, scrollToPage]);

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

  const base = baseRef.current;
  void baseVersion; // re-render trigger off the ref mutation

  if (!currentPage) {
    // Defensive: adjust is only entered with ≥1 page; render nothing rather
    // than crash on the transient frame before a "Volver a tomar" unmounts us.
    return null;
  }

  const { recipe, warpedWidth, warpedHeight } = currentPage;

  return (
    <div className="flex h-full w-full flex-col bg-black text-white" data-testid="adjust-screen">
      {/* Preview strip: page 0, then the "add more" panel (reveal on scroll left). */}
      <div
        ref={scrollerRef}
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
        data-testid="adjust-preview-strip"
      >
        <section className="flex h-full w-full shrink-0 snap-center items-center justify-center p-4">
          <div className="w-full max-w-xs overflow-hidden rounded-xl bg-neutral-900">
            {base ? (
              <WarpedPreview
                bitmap={base}
                filter={recipe.filter}
                transform={recipeToCssTransform(recipe)}
                outSize={{ outW: warpedWidth, outH: warpedHeight }}
                rotation={recipe.rotation}
                testId="adjust-warped-preview"
              />
            ) : (
              <div className="flex aspect-[3/4] w-full items-center justify-center">
                <p className="text-sm text-white/60">{t('common.processing')}</p>
              </div>
            )}
          </div>
        </section>

        <button
          type="button"
          onClick={onAddMore}
          className="flex h-full w-full shrink-0 snap-center flex-col items-center justify-center gap-3 p-4 text-white/80"
          data-testid="adjust-add-more"
        >
          <span className="flex h-24 w-20 items-center justify-center rounded-xl border-2 border-dashed border-white/40">
            <Plus size={32} strokeWidth={1.5} aria-hidden="true" />
          </span>
          <span className="text-sm font-medium">{t('adjust.addMore')}</span>
        </button>
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

// React.lazy requires a default export (ScannerScreen lazy-loads this screen).
export default AdjustScreen;
