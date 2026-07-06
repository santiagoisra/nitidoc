/**
 * Web Worker message contract (design section 1.1).
 *
 * Pattern: RPC request/response correlated by a monotonic `id`. Every
 * request carries an `id`; the worker replies with the same `id`. `INIT` is
 * the only request that may emit intermediate `PROGRESS` events before its
 * final `INIT_DONE`/`ERROR`.
 *
 * `Point`, `Quad`, `QualityMetrics`, `AspectRatioName`, and `AspectRatio` are
 * NOT redefined here — they already live in `@/shared/types/geometry`
 * (introduced in Slice A so the store could be typed ahead of this worker
 * contract). This module only imports and re-exports what it needs to keep
 * a single source of truth for those primitives.
 */

import type {
  AspectRatioName,
  Point,
  Quad,
  QualityMetrics,
} from '@/shared/types/geometry';

export type { Point, Quad, QualityMetrics, AspectRatioName };

// ─────────────── Requests (main -> worker) ───────────────

export interface InitRequest {
  readonly id: number;
  readonly type: 'INIT';
}

export interface DetectRequest {
  readonly id: number;
  readonly type: 'DETECT';
  /** Downscaled frame (~640px wide). Transferred (zero-copy). */
  readonly bitmap: ImageBitmap;
  /** If true, also compute QualityMetrics reusing the grayscale Mat. */
  readonly withQuality: boolean;
}

/** Plain ImageData, safe for postMessage with buffer transfer. */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface WarpRequest {
  readonly id: number;
  readonly type: 'WARP';
  /**
   * Full-resolution frame already extracted as ImageData on the main
   * thread. Its `.data.buffer` is transferred (zero-copy).
   */
  readonly image: ImageDataLike;
  /** Corners in `image`'s coordinate space (full resolution). */
  readonly corners: Quad;
  /** Chosen aspect ratio (auto-inferred or manual override). */
  readonly aspectRatio: AspectRatioName;
}

export type WorkerRequest = InitRequest | DetectRequest | WarpRequest;

// ─────────────── Responses (worker -> main) ───────────────

export interface ProgressEvent {
  readonly id: number;
  readonly type: 'PROGRESS';
  /** 0..1. Best-effort; see opencvLoader for why it may be indeterminate. */
  readonly progress: number;
}

export interface InitDoneResponse {
  readonly id: number;
  readonly type: 'INIT_DONE';
}

export interface DetectResponse {
  readonly id: number;
  readonly type: 'DETECT_RESULT';
  /**
   * Corners in the sent bitmap's space, or null if no convex 4-sided
   * polygon with sufficient area was found.
   */
  readonly corners: Quad | null;
  /** Present only if the request asked for withQuality. */
  readonly quality: QualityMetrics | null;
}

export interface WarpResponse {
  readonly id: number;
  readonly type: 'WARP_RESULT';
  /** Dewarped image. Transferred back (zero-copy). */
  readonly bitmap: ImageBitmap;
  /** Output dimensions chosen by the warp. */
  readonly outWidth: number;
  readonly outHeight: number;
}

/**
 * Fallback variant of the warp response for environments without
 * `OffscreenCanvas` (design section 8). Carries plain pixel data instead of
 * an `ImageBitmap`; `image.data.buffer` is transferred.
 */
export interface WarpResponseImageData {
  readonly id: number;
  readonly type: 'WARP_RESULT_IMAGEDATA';
  readonly image: ImageDataLike;
  readonly outWidth: number;
  readonly outHeight: number;
}

export interface ErrorResponse {
  readonly id: number;
  readonly type: 'ERROR';
  readonly code: WorkerErrorCode;
  readonly message: string;
}

export type WorkerErrorCode =
  | 'OPENCV_LOAD_FAILED'
  | 'NOT_INITIALIZED'
  | 'DETECT_FAILED'
  | 'WARP_FAILED'
  | 'INVALID_INPUT';

export type WorkerResponse =
  | ProgressEvent
  | InitDoneResponse
  | DetectResponse
  | WarpResponse
  | WarpResponseImageData
  | ErrorResponse;
