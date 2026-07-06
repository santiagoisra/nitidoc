/**
 * Pure, DOM-free math for the live-detection loop (Group 4 / Slice D):
 * corner interpolation (anti-jitter overlay smoothing), the stability
 * buffer's per-point variance calculation, scaling detected corners from
 * the downscaled detection frame to full resolution, and the "too far"
 * quality heuristic based on contour area ratio.
 *
 * Kept separate from `geometry.ts` (which owns corner ORDERING/convexity/
 * aspect-ratio inference for the warp pipeline) because this module is
 * specifically about per-frame signal processing in the live loop, not the
 * one-shot warp geometry. Both are DOM-free and testable in Node.
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
 * Interpolates a whole quad of 4 corners (design section 2.1, anti-jitter
 * overlay smoothing). If there is no previous quad, the new one is used
 * as-is (nothing to interpolate from yet).
 */
export function lerpQuad(prev: Quad | null, next: Quad, alpha: number): Quad {
  if (!prev) {
    return next;
  }
  return [
    lerpPoint(prev[0], next[0], alpha),
    lerpPoint(prev[1], next[1], alpha),
    lerpPoint(prev[2], next[2], alpha),
    lerpPoint(prev[3], next[3], alpha),
  ] as Quad;
}

/**
 * Per-point variance of a buffer of quads (design section 2.1 stability
 * buffer). Returns the MAXIMUM per-corner variance across all 4 corners —
 * the buffer is only considered stable when every corner's variance is
 * under the threshold, so the max is the single number callers need to
 * compare against `STABILITY_VARIANCE_PX`.
 *
 * Variance here is the mean squared distance from each corner's mean
 * position across the buffer (population variance of the 2D point cloud
 * per corner index). Returns 0 for a buffer with fewer than 2 samples
 * (nothing to vary yet).
 */
export function maxCornerVariance(buffer: readonly Quad[]): number {
  if (buffer.length < 2) {
    return 0;
  }

  let maxVariance = 0;
  for (let cornerIndex = 0; cornerIndex < 4; cornerIndex += 1) {
    const points = buffer.map((quad) => quad[cornerIndex as 0 | 1 | 2 | 3]);
    const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const variance =
      points.reduce((sum, p) => sum + ((p.x - meanX) ** 2 + (p.y - meanY) ** 2), 0) / points.length;
    if (variance > maxVariance) {
      maxVariance = variance;
    }
  }
  return maxVariance;
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

/** Shoelace formula area of an arbitrary quad (unsigned). */
function quadArea(quad: Quad): number {
  let area = 0;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i] as Point;
    const b = quad[(i + 1) % quad.length] as Point;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * Ratio of the detected contour's area to the full detection frame's area
 * (scanner spec "Documento demasiado lejos del encuadre" / design section
 * 4.5). Computed on the UI thread from the corners already returned by the
 * worker — does NOT re-invoke OpenCV.
 */
export function contourAreaRatio(corners: Quad, frameWidth: number, frameHeight: number): number {
  const frameArea = frameWidth * frameHeight;
  if (frameArea <= 0) {
    return 0;
  }
  return quadArea(corners) / frameArea;
}

/**
 * Below this contour-to-frame area ratio, the document is considered too
 * far from the camera ("acercate mas"). Starting value — same spirit as
 * `DETECTION`'s calibratable constants (design section 11): not asserted
 * as an exact final threshold, only the classification contract is
 * guaranteed behavior.
 */
export const TOO_FAR_AREA_RATIO_THRESHOLD = 0.25;

/** True when the detected contour is too small relative to the frame (document too far away). */
export function isTooFar(corners: Quad, frameWidth: number, frameHeight: number): boolean {
  return contourAreaRatio(corners, frameWidth, frameHeight) < TOO_FAR_AREA_RATIO_THRESHOLD;
}
