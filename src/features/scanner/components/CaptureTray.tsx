/**
 * Continuous-capture tray (design section 5.2, spec `document` Req "Bandeja
 * de captura continua"; Group 5 / PR8). Horizontal strip of the document's
 * already-cached ~150px thumbnails + a page counter + a "Listo" button
 * (-> `ScannerScreen` flips `phase` to `'grid'`). NEVER renders full-res
 * (D6): every tile draws a page's cached `thumbnail` `ImageBitmap` as-is —
 * this component never decodes a `Blob` or touches `activeWorking`. Blocks
 * new capture at the 30-page hard cap with an inline hint (spec scenario
 * "Cap duro de 30 paginas alcanzado").
 *
 * Replaces the inline `capture-tray-placeholder` `ScannerScreen` rendered
 * before this PR.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Button } from '@/shared/ui';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

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
          <PageThumbnail key={page.id} bitmap={page.thumbnail} testId={`capture-tray-thumb-${page.id}`} />
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
          Listo
        </Button>
      </div>
    </div>
  );
}

export interface PageThumbnailProps {
  /** An already-cached `~150px` thumbnail `ImageBitmap` (D6) — drawn as-is, never decoded/resized here. */
  readonly bitmap: ImageBitmap;
  readonly testId?: string;
}

/**
 * Draws a cached thumbnail `ImageBitmap` onto a small `<canvas>`. Shared by
 * `CaptureTray` and `PageGrid` (design section 5.2/5.3) — mirrors the same
 * `useEffect` + canvas-2d draw pattern already used by `FilterPanel`'s
 * `PresetTile`. Never touches full-res: the bitmap it receives IS the cached
 * thumbnail, not a decode source.
 */
export function PageThumbnail({ bitmap, testId }: PageThumbnailProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
  }, [bitmap]);

  return (
    <canvas
      ref={canvasRef}
      className="aspect-[3/4] h-20 shrink-0 rounded bg-surface object-cover"
      data-testid={testId}
      aria-hidden="true"
    />
  );
}
