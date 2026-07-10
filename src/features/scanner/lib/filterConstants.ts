/**
 * Calibratable constants for the filter pipeline (Fase 2, design section
 * 4.4). Mirrors `detectionConstants.ts`'s pattern.
 *
 * IMPORTANT: these are STARTING VALUES that design section 8 explicitly
 * marks as pending empirical calibration on real documents/devices. They
 * must never be asserted as exact "correct" values in tests — only the
 * surrounding contract (routing, ordering, shape) is guaranteed behavior.
 */
export const FILTER = {
  /** JPEG compression quality for cached `originalBlob`/`warpedBlob` (design section 2.3). STARTING VALUE. */
  JPEG_QUALITY: 0.85,
  /** Longest-edge px for the cached per-page thumbnail (design section 2.3). STARTING VALUE. */
  THUMBNAIL_MAX_EDGE: 150,
  /**
   * Longest-edge px for the downscaled copy `WarpedPreview` renders adaptive
   * presets on (Fase 2.2 punch-list item 3) — larger than `THUMBNAIL_MAX_EDGE`
   * since this is the PRIMARY editing preview, not a small tray/grid tile,
   * but still far below full-res to keep the debounced worker round-trip
   * cheap. STARTING VALUE.
   */
  WARPED_PREVIEW_MAX_EDGE: 500,
  /** Hard cap on document length (design section 2.3 / D-MEM). STARTING VALUE. */
  PAGE_CAP: 30,
  /** `saturate()` multiplier for the `enhanced` preset (design section 3.2). STARTING VALUE. */
  ENHANCED_SATURATION: 1.3,
  /** Brightness-slider-to-`convertScaleAbs` beta scale for adaptive presets (design section 3.3). STARTING VALUE. */
  BETA_SCALE: 0.5,
  /** Debounce for slider-driven worker calls, ms (design section 3.4). STARTING VALUE. */
  SLIDER_DEBOUNCE_MS: 120,
  /** `bw` preset adaptiveThreshold blockSize/C (design section 4.4). STARTING VALUES. */
  BW_BLOCK_SIZE: 15,
  BW_C: 10,
  /** `bw-high-contrast` preset adaptiveThreshold blockSize/C (design section 4.4). STARTING VALUES. */
  BW_HC_BLOCK_SIZE: 25,
  BW_HC_C: 15,
  /** `eco` preset adaptiveThreshold blockSize/C (design section 4.4). STARTING VALUES. */
  ECO_BLOCK_SIZE: 15,
  ECO_C: 7,
  /** Structuring-element kernel size (px) for `bw-high-contrast` denoise morphology (design section 4.4). STARTING VALUE. */
  MORPH_KERNEL: 3,
} as const;
