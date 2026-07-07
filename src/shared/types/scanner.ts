import type { AspectRatioName, Quad } from '@/shared/types/geometry';

/**
 * The captured frame at full resolution. Immutable container: `source` is
 * never mutated once set. Edits are expressed as an `EditRecipe` instead
 * (design section 5.2 — non-destructive editing pattern).
 */
export interface CapturedFrame {
  readonly source: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
}

/**
 * The six per-page filter presets (Fase 2, design section 1.1). `original`,
 * `enhanced`, `grayscale` render via Canvas2D `ctx.filter` on the main
 * thread; `bw`, `bw-high-contrast`, `eco` render via the OpenCV worker's
 * `APPLY_FILTER` RPC (ADR-008).
 */
export type FilterPreset =
  | 'original'
  | 'enhanced'
  | 'grayscale'
  | 'bw'
  | 'bw-high-contrast'
  | 'eco';

/**
 * Per-page filter parameters embedded in `EditRecipe` (design section 1.1;
 * ADR-009). Pure JSON — never holds binary handles. The warp base stays
 * UNFILTERED; the filter is a presentation-layer overlay applied on top.
 */
export interface FilterParams {
  readonly preset: FilterPreset;
  /** -100..100, 0 = neutral. */
  readonly brightness: number;
  /** -100..100, 0 = neutral. */
  readonly contrast: number;
  /** 0..100, 0 = off. */
  readonly sharpness: number;
}

/** The identity filter: `original` preset, no brightness/contrast/sharpness adjustment. */
export const NEUTRAL_FILTER: FilterParams = {
  preset: 'original',
  brightness: 0,
  contrast: 0,
  sharpness: 0,
} as const;

/**
 * Non-destructive edit recipe applied on top of a `CapturedFrame` to derive
 * the warped/presented image. JSON-serializable — never holds binary
 * handles (no ImageBitmap/Mat references here).
 */
export interface EditRecipe {
  readonly corners: Quad;
  readonly aspectRatio: AspectRatioName;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly flipH: boolean;
  readonly flipV: boolean;
  /** Per-page filter, JSON-only (design section 1.1; ADR-009). */
  readonly filter: FilterParams;
}
