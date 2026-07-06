/**
 * Shared geometry primitives used by the scanner store, the worker message
 * contract (src/features/scanner/worker/messages.ts, Group 2), and the
 * corner editor (Group 5).
 *
 * Kept here (not duplicated) so the store can be typed in this slice
 * without depending on the worker contract module, which is implemented
 * in a later slice.
 */

/** A point in pixel space within whichever image it was measured against. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 4 ordered corners: [topLeft, topRight, bottomRight, bottomLeft]. */
export type Quad = readonly [Point, Point, Point, Point];

/** Aspect ratios recognized for inference (design section 6.3). */
export type AspectRatioName = 'a4' | 'letter' | 'ticket' | 'unknown';

export interface AspectRatio {
  readonly name: AspectRatioName;
  /** width/height normalized (always <= 1 for portrait). */
  readonly ratio: number;
}

/** Quality metrics computed over the downscaled detection frame. */
export interface QualityMetrics {
  /** Laplacian variance. Higher = sharper. Threshold is a starting value, calibrated later. */
  readonly laplacianVariance: number;
  /** Mean gray intensity [0..255]. Low = dark. */
  readonly meanIntensity: number;
  /** true if laplacianVariance < BLUR_THRESHOLD (starting value). */
  readonly isBlurry: boolean;
  /** true if meanIntensity < DARK_THRESHOLD (starting value). */
  readonly isDark: boolean;
}
