/**
 * Pure helper for the 16MP capture cap (design section 7, "Cap de 16MP").
 *
 * DOM-free and testable in Node: given the frame's natural width/height, it
 * returns the dimensions to actually use for the capture canvas/bitmap,
 * downscaling proportionally so `width * height <= MAX_CAPTURE_PIXELS`.
 * Must run BEFORE creating any canvas/OffscreenCanvas for the capture
 * (design section 7 — applied on the MAIN thread; the worker assumes input
 * is already capped).
 */

import { DETECTION } from '@/features/scanner/lib/detectionConstants';

export interface CaptureDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Returns capped integer dimensions preserving the original aspect ratio.
 * If the input is already within the pixel budget, it is returned unchanged
 * (as integers). Both `width` and `height` must be positive finite numbers.
 */
export function capCaptureDimensions(
  width: number,
  height: number,
  maxPixels: number = DETECTION.MAX_CAPTURE_PIXELS,
): CaptureDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError(
      `capCaptureDimensions: width and height must be positive finite numbers (got ${width}x${height}).`,
    );
  }

  const totalPixels = width * height;
  if (totalPixels <= maxPixels) {
    return { width: Math.round(width), height: Math.round(height) };
  }

  // Scale both dimensions by the same factor so w' * h' = maxPixels while
  // preserving width/height ratio: factor = sqrt(maxPixels / (w * h)).
  const scale = Math.sqrt(maxPixels / totalPixels);
  const scaledWidth = Math.max(1, Math.floor(width * scale));
  const scaledHeight = Math.max(1, Math.floor(height * scale));

  return { width: scaledWidth, height: scaledHeight };
}
