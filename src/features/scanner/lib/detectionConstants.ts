/**
 * Calibratable constants for the detection/quality/warp pipeline
 * (design section 6.4).
 *
 * IMPORTANT: several of these are explicitly STARTING VALUES that design
 * marks as pending empirical calibration on real devices (design section
 * 11, risks R1 and the stability threshold). They must never be asserted
 * as exact expected values in tests — only the surrounding contract
 * (ordering, classification, convexity) is guaranteed behavior.
 */
export const DETECTION = {
  /** Detection frame width used for the live loop. */
  DOWNSCALE_WIDTH: 640,
  /**
   * Laplacian variance threshold at 640px width, below which a frame is
   * considered blurry. STARTING VALUE — calibrate on real devices (R1).
   */
  BLUR_THRESHOLD: 100,
  /**
   * Mean gray intensity threshold, below which a frame is considered too
   * dark. STARTING VALUE — calibrate on real devices (R1).
   */
  DARK_THRESHOLD: 60,
  /**
   * Stability window in ms: corners must stay under
   * STABILITY_VARIANCE_PX for this long to be considered stable.
   * STARTING VALUE — calibrate by feel.
   */
  STABILITY_MS: 800,
  /**
   * Per-corner position variance (px) under which corners are considered
   * stable. STARTING VALUE — calibrate by feel.
   */
  STABILITY_VARIANCE_PX: 4,
  /** Overlay corner interpolation smoothing factor (lerp alpha). */
  INTERP_ALPHA: 0.35,
  /** Time without a valid detection before showing the "capture anyway" hint. */
  NO_DETECTION_MS: 5000,
  /** Aspect ratio matching tolerance for inferAspectRatio. STARTING VALUE. */
  ASPECT_TOLERANCE: 0.06,
  /** iOS capture cap: 16 megapixels exactly. */
  MAX_CAPTURE_PIXELS: 16_777_216,
} as const;
