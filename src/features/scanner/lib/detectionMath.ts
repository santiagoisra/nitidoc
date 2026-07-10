/**
 * Pure, DOM-free math for the capture/warp pipeline: general linear
 * interpolation helpers and scaling detected corners from the downscaled
 * detection frame to full resolution.
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 6): the live-detection loop's
 * per-frame signal processing (`lerpQuad` overlay smoothing,
 * `maxCornerStdDevPx` stability buffer, `contourAreaRatio`/`isTooFar` "too
 * far" heuristic) was removed along with `useDocumentDetection.ts` and
 * `QualityHints.tsx` — capture is manual-only now, so there is no live
 * overlay to smooth, no stability window to measure, and no per-frame "too
 * far" hint to compute. `scaleCornersToFullRes` stays: the deferred batch
 * processing step (`useBatchProcess.ts`) still detects on a downscaled copy
 * of each raw capture and needs to scale the result back up to full-res
 * before warping.
 *
 * Kept separate from `geometry.ts` (which owns corner ORDERING/convexity/
 * aspect-ratio inference for the warp pipeline) since this module is
 * specifically about frame-scale conversions, not warp geometry. Both are
 * DOM-free and testable in Node.
 */

import type { Point, Quad } from '@/shared/types/geometry';

/** Linear interpolation between two numbers. */
export function lerp(prev: number, next: number, alpha: number): number {
  return prev + (next - prev) * alpha;
}

/** Linear interpolation between two points. */
export function lerpPoint(prev: Point, next: Point, alpha: number): Point {
  return {
    x: lerp(prev.x, next.x, alpha),
    y: lerp(prev.y, next.y, alpha),
  };
}

/**
 * Scales corners detected on the downscaled detection frame
 * (`DETECTION.DOWNSCALE_WIDTH` wide) up to the full-resolution capture's
 * coordinate space (design section 2.2, "escalar esquinas de 640px a
 * full-res"). Uses a single uniform scale factor derived from width, since
 * `createImageBitmap(video, { resizeWidth })` preserves aspect ratio.
 */
export function scaleCornersToFullRes(
  corners: Quad,
  detectionFrameWidth: number,
  fullResWidth: number,
): Quad {
  if (detectionFrameWidth <= 0) {
    throw new RangeError(
      `scaleCornersToFullRes: detectionFrameWidth must be positive (got ${detectionFrameWidth}).`,
    );
  }
  const scale = fullResWidth / detectionFrameWidth;
  return corners.map((p) => ({ x: p.x * scale, y: p.y * scale })) as unknown as Quad;
}
