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
}
