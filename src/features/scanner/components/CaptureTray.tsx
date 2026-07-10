/**
 * Continuous-capture tray (design section 5.2, spec `document` Req "Bandeja
 * de captura continua"; Group 5 / PR8). Horizontal strip of the document's
 * already-cached ~150px thumbnails + a page counter + a "Done" button
 * (-> `ScannerScreen` flips `phase` to `'grid'`). NEVER renders full-res
 * (D6): every tile draws a page's cached `thumbnail` `ImageBitmap`, with the
 * page's `recipe.filter` applied as a `ctx.filter` CSS string (Fase 2.1
 * punch-list item 3 — an applied filter must be VISIBLE here, not just in
 * the editor) — this component never decodes a `Blob` or touches
 * `activeWorking`. Blocks new capture at the 30-page hard cap with an inline
 * hint (spec scenario "Cap duro de 30 paginas alcanzado").
 *
 * Replaces the inline `capture-tray-placeholder` `ScannerScreen` rendered
 * before this PR.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Button } from '@/shared/ui';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { buildThumbnailCssFilter } from '@/features/scanner/lib/filterPipeline';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { FilterParams } from '@/shared/types/scanner';

export interface CaptureTrayProps {
  readonly pages: readonly DocumentPage[];
  /** True once `pages.length >= FILTER.PAGE_CAP` (design section 2.3 / D-MEM). */
  readonly isAtCap: boolean;
  readonly onDone: () => void;
}

export function CaptureTray({ pages, isAtCap, onDone }: CaptureTrayProps): ReactNode {
  if (pages.length === 0) {
    // Nothing captured yet this session — the tray only makes sense once at
    // least one page exists (design section 5.1).
    return null;
  }

  return (
    <div className="flex w-full flex-col gap-2" data-testid="capture-tray">
      <div className="flex w-full items-center gap-2 overflow-x-auto" data-testid="capture-tray-strip">
        {pages.map((page) => (
          <PageThumbnail
            key={page.id}
            bitmap={page.thumbnail}
            filter={page.recipe.filter}
            testId={`capture-tray-thumb-${page.id}`}
          />
        ))}
      </div>

      {isAtCap && (
        <p className="text-sm text-text-muted" data-testid="capture-tray-cap-hint">
          Document limit reached ({FILTER.PAGE_CAP} pages).
        </p>
      )}

      <div className="flex w-full items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {pages.length} page{pages.length === 1 ? '' : 's'} captured
        </p>
        <Button type="button" variant="secondary" onClick={onDone} data-testid="tray-done">
          Done
        </Button>
      </div>
    </div>
  );
}

export interface PageThumbnailProps {
  /** An already-cached `~150px` thumbnail `ImageBitmap` (D6) — drawn as-is, never decoded/resized here. */
  readonly bitmap: ImageBitmap;
  /**
   * The page's current filter (Fase 2.1 punch-list item 3, "CRITICAL
   * visibility fix"). Rendered as a `ctx.filter` CSS string via
   * `buildThumbnailCssFilter` so an applied filter is actually VISIBLE in
   * the tray/grid instead of always drawing the unfiltered cached bitmap.
   */
  readonly filter: FilterParams;
  readonly testId?: string;
}

/**
 * Draws a cached thumbnail `ImageBitmap` onto a small `<canvas>`, applying
 * the page's current filter as a `ctx.filter` CSS string before drawing
 * (Fase 2.1 item 3). Shared by `CaptureTray` and `PageGrid` (design section
 * 5.2/5.3) — mirrors the same `useEffect` + canvas-2d draw pattern already
 * used by `FilterPanel`'s `PresetTile`. Never touches full-res: the bitmap
 * it receives IS the cached thumbnail, not a decode source. For the 3
 * adaptive presets (`bw`/`bw-high-contrast`/`eco`), `buildThumbnailCssFilter`
 * returns a CSS APPROXIMATION rather than the pixel-accurate worker render —
 * acceptable for this small preview (see that helper's doc comment); the
 * accurate render stays in `FilterPanel`'s edit-step preview.
 */
export function PageThumbnail({ bitmap, filter, testId }: PageThumbnailProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.filter = buildThumbnailCssFilter(filter);
    ctx.drawImage(bitmap, 0, 0);
    ctx.filter = 'none';
  }, [bitmap, filter]);

  return (
    <canvas
      ref={canvasRef}
      className="aspect-[3/4] h-20 shrink-0 rounded bg-surface object-cover"
      data-testid={testId}
      aria-hidden="true"
    />
  );
}
