/**
 * Shared thumbnail tile (Fase 2.3, capture-ux-redesign.md, Unit 5). Used by
 * `PageGrid` and `ScannerScreen`'s `done` strip.
 *
 * ACCURACY (thumbnail-fidelity fix): this used to draw the cached UNFILTERED
 * thumbnail with `buildThumbnailCssFilter` on top, and for the three adaptive
 * presets (`bw`, `bw-high-contrast`, `eco`) that string is only an
 * APPROXIMATION — `grayscale(1) contrast(1.8)` standing in for an OpenCV
 * `adaptiveThreshold`. It was signed off as "acceptable for a small preview",
 * and on a real device it is not: a user who sets a page to `bw` in the adjust
 * screen, then reviews the document in the grid, sees a washed-out grey tile
 * and reasonably concludes their edit was lost.
 *
 * So the adaptive presets now render through the SAME worker call the editor
 * and the export use. The cost is trivial because the input is the ~150px
 * cached thumbnail, not full-res — this is the same round-trip `FilterPanel`
 * already makes for its preset tiles.
 *
 * The CSS approximation is still drawn FIRST, synchronously. It is a decent
 * stand-in for the few milliseconds the worker takes, and it means a tile is
 * never blank or unfiltered while the accurate render is in flight.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { buildThumbnailCssFilter, needsWorker } from '@/features/scanner/lib/filterPipeline';
import { getSharedWorkerClient } from '@/features/scanner/lib/workerClient';
import type { FilterVariant, ImageDataLike } from '@/features/scanner/worker/messages';
import type { FilterParams } from '@/shared/types/scanner';

export interface PageThumbnailProps {
  /** An already-cached `~150px` thumbnail `ImageBitmap` (D6) — drawn as-is, never decoded/resized here. */
  readonly bitmap: ImageBitmap;
  /** The page's current filter. Adaptive presets are baked by the worker; the rest render as a `ctx.filter` string. */
  readonly filter: FilterParams;
  readonly testId?: string;
  /**
   * Size/shape classes for the canvas. Defaults to a small fixed 3:4 tile
   * (the `done` fan strip). The grid passes `aspect-[3/4] w-full` so each
   * page fills its cell exactly like the "Capturar más" tile beside it.
   */
  readonly sizeClassName?: string;
}

function extractImageData(bitmap: ImageBitmap): ImageDataLike {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('PageThumbnail: failed to acquire 2d context to extract thumbnail ImageData.');
  }
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  // Release the scratch canvas's backing store immediately (the hygiene
  // pattern `pageResources.ts`/`mainThreadImageData.ts` already follow).
  canvas.width = 0;
  canvas.height = 0;
  return { width: imageData.width, height: imageData.height, data: imageData.data };
}

export function PageThumbnail({
  bitmap,
  filter,
  testId,
  sizeClassName = 'aspect-[3/4] h-20 shrink-0',
}: PageThumbnailProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Worker-baked render for the current (bitmap, filter) pair, or null while unavailable. */
  const [baked, setBaked] = useState<ImageBitmap | ImageData | null>(null);

  // Request sequence: a fast pass through several presets can leave older
  // responses arriving after newer ones. Anything not matching the latest
  // request is discarded — and its bitmap closed, or it leaks.
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const seq = (seqRef.current += 1);
    setBaked(null);

    if (!needsWorker(filter)) {
      // `enhanced`/`grayscale`/`original` are exactly representable as a CSS
      // filter string — no round-trip needed, and the synchronous draw below
      // is already pixel-correct for them.
      return;
    }

    // No worker, no accurate render. `getSharedWorkerClient()` CONSTRUCTS one
    // eagerly and throws where the global is absent, which would take the
    // whole tile down with it — so this is checked before asking, the same
    // way `encodeClient.workerPathAvailable` does. The CSS approximation
    // below remains, which is exactly the old behavior.
    if (typeof Worker === 'undefined') {
      return;
    }

    const variants: FilterVariant[] = [
      {
        preset: filter.preset,
        brightness: filter.brightness,
        contrast: filter.contrast,
        sharpness: filter.sharpness,
      },
    ];
    const outputBitmap = typeof OffscreenCanvas !== 'undefined';

    // `extractImageData` and the worker-client construction are synchronous and
    // can both throw (no 2d context, worker bundle unavailable). An async IIFE
    // funnels those into the same `catch` as the RPC rejection, so no failure
    // mode of a mere preview can escape the effect and unmount the tree.
    void (async () => {
      try {
        const response = await getSharedWorkerClient().applyFilter(
          extractImageData(bitmap),
          variants,
          outputBitmap,
        );
        const result = response.results[0];
        if (!result) return;
        if (!mountedRef.current || seq !== seqRef.current) {
          // Superseded or unmounted: never let a stale result leak its bitmap.
          if (result.kind === 'bitmap') result.bitmap.close();
          return;
        }
        setBaked(
          result.kind === 'bitmap'
            ? result.bitmap
            : new ImageData(new Uint8ClampedArray(result.image.data), result.image.width, result.image.height),
        );
      } catch {
        // Degraded mode (OpenCV unavailable) is a supported state. The CSS
        // approximation stays on screen — a rough preview beats an empty tile,
        // and the export path bakes the real filter regardless.
      }
    })();
  }, [bitmap, filter]);

  // Close the previous baked bitmap whenever it is replaced or the component
  // unmounts. Without this, every filter change would strand one.
  useEffect(() => {
    return () => {
      if (baked && 'close' in baked) {
        baked.close();
      }
    };
  }, [baked]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (baked && baked instanceof ImageData) {
      canvas.width = baked.width;
      canvas.height = baked.height;
      ctx.putImageData(baked, 0, 0);
      return;
    }

    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (baked) {
      // Worker-baked bitmap: the filter is already in the pixels, so drawing
      // a CSS filter over it would apply the adjustment twice.
      ctx.filter = 'none';
      ctx.drawImage(baked, 0, 0);
      return;
    }
    ctx.filter = buildThumbnailCssFilter(filter);
    ctx.drawImage(bitmap, 0, 0);
    ctx.filter = 'none';
  }, [baked, bitmap, filter]);

  return (
    <canvas
      ref={canvasRef}
      className={`rounded bg-surface object-cover ${sizeClassName}`}
      data-testid={testId}
      aria-hidden="true"
    />
  );
}
