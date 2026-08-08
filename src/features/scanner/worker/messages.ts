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
import type { WarpGeometry } from '@/shared/types/paper';
import type { FilterPreset } from '@/shared/types/scanner';

export type { Point, Quad, QualityMetrics, AspectRatioName };

// ─────────────── Requests (main -> worker) ───────────────

export interface InitRequest {
  readonly id: number;
  readonly type: 'INIT';
  /**
   * ABSOLUTE URL of the served OpenCV.js asset, computed on the main thread
   * (where `location.origin` is always reliable) and passed in so the worker
   * never resolves a relative path itself. In some worker contexts (notably
   * Vite's dev server) the worker's own base URL is opaque/blob-like, so a
   * relative `fetch('/opencv/opencv.js')` throws "Failed to parse URL" and a
   * relative `importScripts` fails to resolve — hanging init. An absolute URL
   * works uniformly in dev and production.
   */
  readonly assetUrl: string;
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

/**
 * Fallback DETECT request for environments where NEITHER the main thread NOR
 * the worker's own global scope has `OffscreenCanvas` (design section 8, "Sin
 * OffscreenCanvas" — historically Safari < 16.4, whose worker global scope
 * also lacked `OffscreenCanvas` before it existed on the main thread). The
 * worker cannot draw an `ImageBitmap` into a canvas to extract pixels without
 * `OffscreenCanvas` (it has no `<canvas>` DOM element to fall back to), so in
 * this case the MAIN thread extracts `ImageData` itself (via a regular
 * `<canvas>`) and sends it directly instead of a bitmap.
 */
export interface DetectRequestImageData {
  readonly id: number;
  readonly type: 'DETECT_IMAGEDATA';
  readonly image: ImageDataLike;
  readonly withQuality: boolean;
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
  /** Numeric crop constraint resolved on the main thread. */
  readonly geometry: WarpGeometry;
}

/**
 * One preset+slider combination to render over the SAME base `image`
 * (design section 4.1). `ApplyFilterRequest.variants` carries 1 (single
 * active/export render) or up to 3 (batched adaptive-preset previews,
 * design section 4.3) of these.
 */
export interface FilterVariant {
  readonly preset: FilterPreset;
  readonly brightness: number;
  readonly contrast: number;
  readonly sharpness: number;
}

export interface ApplyFilterRequest {
  readonly id: number;
  readonly type: 'APPLY_FILTER';
  /**
   * Base = UNFILTERED warp (thumbnail-sized for previews, full-res for
   * export). `image.data.buffer` is transferred (zero-copy; detaches on the
   * caller — clone if reused, same contract as WARP).
   */
  readonly image: ImageDataLike;
  /** Same base image reused across every variant (design section 4.3). */
  readonly variants: readonly FilterVariant[];
  /**
   * `true` -> reply with `ImageBitmap`(s) (needs worker `OffscreenCanvas`);
   * `false` -> reply with `ImageDataLike` (fallback, design section 8 parity,
   * mirrors `WARP`'s `offscreenSupported` branch). NOTE: design.md section
   * 4.1's doc-comment states this backwards (`false` -> bitmap, `true` ->
   * ImageDataLike) — a copy/paste inversion contradicting the field's own
   * name and every other bitmap-flag in this file (e.g. `offscreenSupported`
   * in `opencv.worker.ts`). Implemented here with the natural, name-matching
   * polarity; flagged to the orchestrator for design.md correction.
   */
  readonly outputBitmap: boolean;
}

export type WorkerRequest =
  | InitRequest
  | DetectRequest
  | DetectRequestImageData
  | WarpRequest
  | ApplyFilterRequest;

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

/**
 * One rendered variant in an `ApplyFilterResponse.results` list, in the
 * same order/length as the request's `variants` (design section 4.1).
 */
export type FilteredResult =
  | { readonly kind: 'bitmap'; readonly bitmap: ImageBitmap }
  | { readonly kind: 'imagedata'; readonly image: ImageDataLike };

export interface ApplyFilterResponse {
  readonly id: number;
  readonly type: 'APPLY_FILTER_RESULT';
  /** Same order and length as `request.variants`. */
  readonly results: readonly FilteredResult[];
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
  | 'INVALID_INPUT'
  | 'FILTER_FAILED';

export type WorkerResponse =
  | ProgressEvent
  | InitDoneResponse
  | DetectResponse
  | WarpResponse
  | WarpResponseImageData
  | ApplyFilterResponse
  | ErrorResponse;
