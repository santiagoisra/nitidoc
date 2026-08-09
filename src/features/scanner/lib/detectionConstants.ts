/**
 * Calibratable constants for the one-shot detection/warp pipeline (design
 * section 6.4), consumed by the deferred batch-processing step
 * (`useBatchProcess.ts`) and the DETECT/WARP worker handlers.
 *
 * IMPORTANT: several of these are explicitly STARTING VALUES that design
 * marks as pending empirical calibration on real devices (design section
 * 11, risk R1). They must never be asserted as exact expected values in
 * tests — only the surrounding contract (ordering, classification,
 * convexity) is guaranteed behavior.
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 6): the live-detection loop's
 * per-frame signal-processing constants (`STABILITY_MS`, `STABILITY_STDDEV_PX`,
 * `INTERP_ALPHA`, `BLUR_PERSIST_FRAMES`, `NO_DETECTION_MS`, `BLUR_THRESHOLD`,
 * `DARK_THRESHOLD`) were removed along with `useDocumentDetection.ts` —
 * capture is manual-only now, so there is no overlay-jitter smoothing,
 * stability buffer, auto-capture countdown, or "no detection" hint left to
 * calibrate. `BLUR_THRESHOLD`/`DARK_THRESHOLD` specifically fed
 * `opencv.worker.ts`'s `computeQuality`, which is unreachable in practice
 * post-Unit-6 (nothing calls DETECT/DETECT_IMAGEDATA with `withQuality: true`
 * anymore) — that function now sources its own two threshold constants
 * locally instead of importing them from here (see that file's own comment).
 */
export const DETECTION = {
  /** Detection frame width used for the one-shot per-page DETECT (downscaled copy of the full-res original). */
  DOWNSCALE_WIDTH: 640,
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
  /**
   * Upper bound on a candidate quad's area, as a fraction of the frame.
   *
   * A quad covering essentially the whole frame is not a detected document —
   * it is the image border itself, or a uniform background that thresholded
   * into one big blob. Returning it would be `frameCorners` wearing a
   * detection costume: the page would be reported as detected, skip the
   * `needsReview` badge, and still crop nothing. Falling through to the
   * honest fallback is strictly better for the user.
   *
   * Calibrated against measured quad areas rather than guessed. Real
   * captures — phone camera, imported photo, 9:16 framing, downscaled
   * stream, synthetic fixture — land between 33% and 52%. Frames whose
   * background thresholds into a single blob land at 92-94%. 0.90 sits in
   * the empty band between the two, leaving headroom for a page shot close
   * enough to genuinely fill most of the frame, where cropping is a no-op
   * anyway.
   */
  MAX_CONTOUR_AREA_RATIO: 0.9,
  /**
   * How many of the largest contours per binarisation strategy are examined
   * for a quad. The page is not always the single biggest region (a shadow,
   * a desk edge, or a second sheet can outrank it), but it is reliably among
   * the first few — and every extra candidate costs an `approxPolyDP`.
   */
  TOP_CONTOURS_PER_STRATEGY: 5,
  /** Candidate edge needs this fraction of Canny samples to find nearby visual support. */
  /** Calibrated against the supplied intact/cropped iPhone fixture: 0.25 separates its supported edge from a clipped frame-edge side. */
  MIN_EDGE_SUPPORT: 0.25,
  /** Samples evaluated along each candidate edge; bounded per detected page. */
  EDGE_SUPPORT_SAMPLES: 48,
  /** Canny-support search radius around each sampled candidate-edge point. */
  EDGE_SUPPORT_RADIUS_PX: 15,
  /** Candidate points this close to a frame border count as touching it. */
  BORDER_CONTACT_RATIO: 0.02,
  /** Area required before a candidate can be treated as high-confidence. */
  HIGH_CONFIDENCE_AREA_RATIO: 0.2,
} as const;
