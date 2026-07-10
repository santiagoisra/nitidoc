/**
 * Shared thumbnail tile (Fase 2.3, capture-ux-redesign.md, Unit 5). Extracted
 * out of `CaptureTray.tsx` into its own module so `PageGrid` and
 * `ScannerScreen`'s `done` strip can keep depending on it after `CaptureTray`
 * itself is deleted (Unit 6, once the dead live-detection path goes with it).
 *
 * Draws a cached thumbnail `ImageBitmap` onto a small `<canvas>`, applying
 * the page's current filter as a `ctx.filter` CSS string before drawing
 * (Fase 2.1 item 3). Shared by `CaptureTray`, `PageGrid`, and the `done`
 * summary strip (design section 5.2/5.3) — mirrors the same `useEffect` +
 * canvas-2d draw pattern already used by `FilterPanel`'s `PresetTile`. Never
 * touches full-res: the bitmap it receives IS the cached thumbnail, not a
 * decode source. For the 3 adaptive presets (`bw`/`bw-high-contrast`/`eco`),
 * `buildThumbnailCssFilter` returns a CSS APPROXIMATION rather than the
 * pixel-accurate worker render — acceptable for this small preview (see that
 * helper's doc comment); the accurate render stays in `FilterPanel`'s
 * edit-step preview.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { buildThumbnailCssFilter } from '@/features/scanner/lib/filterPipeline';
import type { FilterParams } from '@/shared/types/scanner';

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
