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
   *
   * FIX (Fase 2.2 punch-list item 1): the original value (100) was
   * calibrated as if the Laplacian ran on a full-resolution frame. Detection
   * always runs on the `DOWNSCALE_WIDTH`-wide (640px) frame
   * (`useDocumentDetection`'s `createImageBitmap(video, { resizeWidth: 640
   * })`), where high-frequency detail — and therefore Laplacian variance —
   * is systematically much lower even for a genuinely sharp document. At
   * 100, `isBlurry` was true almost every frame regardless of actual focus,
   * which is what made the (then-mislabeled "hold steady") blur hint appear
   * permanently stuck. Lowered to 20 so only frames that are actually blurry
   * at 640px trip it.
   */
  BLUR_THRESHOLD: 20,
  /**
   * Consecutive blurry DETECT results required before the blur hint is
   * shown to the user. STARTING VALUE — a single noisy/motion-blurred frame
   * (e.g. mid-pan) should not flash the hint; a sustained run of blurry
   * frames should. Kept intentionally small — this is a cheap debounce, not
   * a full temporal filter.
   */
  BLUR_PERSIST_FRAMES: 3,
  /**
   * Mean gray intensity threshold, below which a frame is considered too
   * dark. STARTING VALUE — calibrate on real devices (R1).
   */
  DARK_THRESHOLD: 60,
  /**
   * Stability window in ms: corners must stay under
   * STABILITY_STDDEV_PX for this long to be considered stable.
   * STARTING VALUE — calibrate by feel.
   */
  STABILITY_MS: 800,
  /**
   * Per-corner position standard deviation, IN PIXELS (on the
   * `DOWNSCALE_WIDTH`-wide detection frame), under which corners are
   * considered stable. STARTING VALUE — calibrate by feel. Chosen in the
   * 6-10px range as a handheld-reasonable tolerance: sub-pixel stillness
   * (the previous, mistakenly-squared threshold) never occurs handheld.
   */
  STABILITY_STDDEV_PX: 8,
  /** Overlay corner interpolation smoothing factor (lerp alpha). */
  INTERP_ALPHA: 0.35,
  /** Time without a valid detection before showing the "capture anyway" hint. */
  NO_DETECTION_MS: 5000,
  /** Aspect ratio matching tolerance for inferAspectRatio. STARTING VALUE. */
  ASPECT_TOLERANCE: 0.06,
  /** iOS capture cap: 16 megapixels exactly. */
  MAX_CAPTURE_PIXELS: 16_777_216,
  /**
   * Minimum contour area (as a fraction of the detection frame's area) for
   * the largest contour to be considered a candidate document. STARTING
   * VALUE — calibrate on real devices (R1).
   *
   * FIX (Fase 2.2 punch-list item 1, root cause B): relaxed from 0.1 to 0.06.
   * A document does not need to fill 10% of the frame to be a legitimate
   * capture target (e.g. a document photographed slightly further back, or
   * a smaller document like a receipt within a larger frame) — 0.1 was
   * silently discarding otherwise-valid contours before they ever reached
   * the shape check below.
   */
  MIN_CONTOUR_AREA_RATIO: 0.06,
  /**
   * `approxPolyDP` epsilon, as a fraction of the contour's perimeter.
   * STARTING VALUE — calibrate on real devices (R1).
   *
   * FIX (Fase 2.2 punch-list item 1, root cause B): raised from 0.02 to
   * 0.03 so more real-world document contours (softened by shadows, texture,
   * or a slight curl) simplify down into the `MAX_APPROX_POINTS`-point range
   * the worker now accepts, instead of over-fitting the contour's noise into
   * many extra vertices.
   */
  POLY_APPROX_EPSILON_RATIO: 0.03,
  /**
   * Maximum number of `approxPolyDP` output points the worker will still
   * attempt to reduce to a quad (via `geometry.ts`'s `reduceToQuad`, the
   * extreme-points method) when the count is not exactly 4. STARTING VALUE.
   *
   * FIX (Fase 2.2 punch-list item 1, root cause B): previously the pipeline
   * required EXACTLY 4 approxPolyDP points and silently discarded every
   * other contour — real paper edges (shadows, texture, slight curl)
   * routinely approximate to 5-8 points, which is why detection "never
   * worked" on real documents. Contours with more than `MAX_APPROX_POINTS`
   * points are still discarded (too noisy/non-document-shaped to trust).
   */
  MAX_APPROX_POINTS: 8,
} as const;
