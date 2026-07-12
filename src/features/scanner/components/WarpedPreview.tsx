/**
 * Warped-page preview canvas (extracted from `CornerEditor` so both the
 * corner editor's 'adjust' step AND the per-page `AdjustScreen` render the
 * exact same filter/rotation preview — DRY over the two-stage filter pipeline
 * rather than re-deriving it in a second place).
 *
 * Renders an UNFILTERED warp-base `ImageBitmap` and applies the page's
 * `recipe.filter` LIVE plus `rotation`/`flipH`/`flipV` via a CSS `transform`
 * (ADR-005 — never re-invokes the warp worker for orientation):
 *  - CSS-routable presets (`needsWorker(filter) === false`) draw instantly via
 *    `ctx.filter = buildCssFilter(filter)` directly on `bitmap`.
 *  - Adaptive presets (`bw`/`bw-high-contrast`/`eco`, or any preset with
 *    `sharpness > 0`) render through a DEBOUNCED (`FILTER.SLIDER_DEBOUNCE_MS`),
 *    latest-wins `workerClient.applyFilter` call on a downscaled
 *    (`FILTER.WARPED_PREVIEW_MAX_EDGE`) preview-sized copy of `bitmap` — with a
 *    monotonic-sequence guard so a stale render never overwrites a newer one
 *    and never leaks the `ImageBitmap` it carries (design section 4.5).
 *
 * Fix H3 (unchanged from the original CornerEditor implementation): a 90/270°
 * CSS rotation swaps the image's visible bounding box, so the wrapper reserves
 * the ROTATION-AWARE box (`layoutSizeForRotation`) as an `aspect-ratio` and the
 * canvas is sized so its rotated footprint stays inside that box.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { buildCssFilter, needsWorker } from '@/features/scanner/lib/filterPipeline';
import { makeThumbnail } from '@/features/scanner/lib/pageResources';
import { getSharedWorkerClient } from '@/features/scanner/lib/workerClient';
import { layoutSizeForRotation } from '@/features/scanner/lib/geometry';
import type { FilteredResult, FilterVariant } from '@/features/scanner/worker/messages';
import type { FilterParams } from '@/shared/types/scanner';

/** Non-closing full-res `ImageData` extraction (the shared warp base must stay drawable across debounced re-renders). */
function extractImageData(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('WarpedPreview: failed to acquire 2d context to extract ImageData.');
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

export interface WarpedPreviewProps {
  readonly bitmap: ImageBitmap;
  /** Current recipe filter — the preview must reflect this live. */
  readonly filter: FilterParams;
  /** CSS `transform` string from `recipeToCssTransform` (rotation/flip). */
  readonly transform: string;
  readonly outSize: { readonly outW: number; readonly outH: number };
  readonly rotation: 0 | 90 | 180 | 270;
  /** Optional test id override so callers can key their preview independently. */
  readonly testId?: string;
}

export function WarpedPreview({ bitmap, filter, transform, outSize, rotation, testId }: WarpedPreviewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Close-before-overwrite hygiene for the derived downscaled preview base
  // (design section 1.5/7). Only populated lazily, the first time an adaptive
  // preset is selected — a CSS-only session never allocates one.
  const previewBaseRef = useRef<ImageBitmap | null>(null);
  const previewBaseSourceRef = useRef<ImageBitmap | null>(null);
  const [previewBaseVersion, setPreviewBaseVersion] = useState(0);
  const applyPreviewBase = useCallback((next: ImageBitmap | null) => {
    const prev = previewBaseRef.current;
    if (prev && prev !== next) {
      prev.close();
    }
    previewBaseRef.current = next;
    setPreviewBaseVersion((v) => v + 1);
  }, []);

  const adaptiveResultRef = useRef<FilteredResult | null>(null);
  const [adaptiveVersion, setAdaptiveVersion] = useState(0);
  const applyAdaptiveResult = useCallback((next: FilteredResult | null) => {
    const prev = adaptiveResultRef.current;
    if (prev?.kind === 'bitmap' && !(next?.kind === 'bitmap' && next.bitmap === prev.bitmap)) {
      prev.bitmap.close();
    }
    adaptiveResultRef.current = next;
    setAdaptiveVersion((v) => v + 1);
  }, []);

  const mountedRef = useRef(true);
  const baseSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Release whatever preview-base/adaptive bitmaps are alive on unmount.
  useEffect(
    () => () => {
      previewBaseRef.current?.close();
      previewBaseRef.current = null;
      const result = adaptiveResultRef.current;
      if (result?.kind === 'bitmap') {
        result.bitmap.close();
      }
      adaptiveResultRef.current = null;
    },
    [],
  );

  // Lazily (re)generate the downscaled preview base whenever the warp base
  // bitmap changes AND the current filter actually needs the worker.
  useEffect(() => {
    if (!needsWorker(filter)) return;
    if (previewBaseSourceRef.current === bitmap && previewBaseRef.current) return;
    const seq = (baseSeqRef.current += 1);
    void makeThumbnail(bitmap, FILTER.WARPED_PREVIEW_MAX_EDGE)
      .then((thumb) => {
        if (!mountedRef.current || seq !== baseSeqRef.current) {
          thumb.close();
          return;
        }
        previewBaseSourceRef.current = bitmap;
        applyPreviewBase(thumb);
      })
      .catch(() => {
        // Non-fatal: `draw` below falls back to the unfiltered bitmap.
      });
  }, [bitmap, filter, applyPreviewBase]);

  // Debounced, latest-wins adaptive-preset render.
  useEffect(() => {
    if (!needsWorker(filter)) return;
    const base = previewBaseRef.current;
    if (!base) return;

    const timer = setTimeout(() => {
      const seq = (previewSeqRef.current += 1);
      const image = extractImageData(base);
      const variant: FilterVariant = {
        preset: filter.preset,
        brightness: filter.brightness,
        contrast: filter.contrast,
        sharpness: filter.sharpness,
      };
      const outputBitmap = typeof OffscreenCanvas !== 'undefined';

      void getSharedWorkerClient()
        .applyFilter(image, [variant], outputBitmap)
        .then((response) => {
          if (!mountedRef.current || seq !== previewSeqRef.current) {
            for (const result of response.results) {
              if (result.kind === 'bitmap') {
                result.bitmap.close();
              }
            }
            return;
          }
          applyAdaptiveResult(response.results[0] ?? null);
        })
        .catch(() => {
          // Preview failure leaves the last rendered frame in place — non-fatal.
        });
    }, FILTER.SLIDER_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `previewBaseVersion` re-arms this effect once a fresh base lands;
    // `adaptiveVersion` is intentionally NOT a dependency (it is this
    // effect's own output).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewBaseVersion, filter.preset, filter.brightness, filter.contrast, filter.sharpness, applyAdaptiveResult]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!needsWorker(filter)) {
      ctx.filter = buildCssFilter(filter);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none';
      return;
    }

    const result = adaptiveResultRef.current;
    if (!result) {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return;
    }
    if (result.kind === 'bitmap') {
      ctx.drawImage(result.bitmap, 0, 0, canvas.width, canvas.height);
      return;
    }
    const scratch = document.createElement('canvas');
    scratch.width = result.image.width;
    scratch.height = result.image.height;
    const scratchCtx = scratch.getContext('2d');
    if (scratchCtx) {
      const pixelData = new Uint8ClampedArray(result.image.data);
      scratchCtx.putImageData(new ImageData(pixelData, result.image.width, result.image.height), 0, 0);
      ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    }
    scratch.width = 0;
    scratch.height = 0;
  }, [bitmap, filter, adaptiveVersion]);

  const layout = layoutSizeForRotation(outSize.outW, outSize.outH, rotation);
  const rotated = rotation === 90 || rotation === 270;

  const canvasStyle = rotated
    ? { width: `${(layout.outH / layout.outW) * 100}%`, height: 'auto', transform }
    : { width: '100%', height: 'auto', transform };

  return (
    <div
      className="relative mx-auto flex items-center justify-center overflow-hidden"
      style={{ width: '100%', aspectRatio: `${layout.outW} / ${layout.outH}` }}
      data-testid={testId ?? 'warped-preview-box'}
    >
      <canvas
        ref={canvasRef}
        width={outSize.outW}
        height={outSize.outH}
        data-testid="warped-preview-canvas"
        className="motion-safe:transition-transform motion-safe:duration-200"
        style={canvasStyle}
      />
    </div>
  );
}
