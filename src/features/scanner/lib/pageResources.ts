/**
 * Pure DOM/`OffscreenCanvas` helpers for the layered-memory page lifecycle
 * (design section 2.2/2.3, D-MEM / ADR-007). NO OpenCV here — this module
 * only performs generic bitmap compress/decode/thumbnail operations, so it
 * stays unit-testable outside a real browser. Mirrors the same
 * `OffscreenCanvas`-when-available / detached-`<canvas>`-fallback pattern
 * already used by `captureFrame.ts`/`captureFallback.ts` (design section 8
 * fallback table).
 *
 * Ownership note: none of these helpers close the `bitmap` they are given —
 * callers (`useActivePage`) own that per the transition-contract table
 * (design section 2.2), since the SAME live bitmap is sometimes drawn into
 * more than one output in the same transition (e.g. materialize-on-capture
 * both compresses and thumbnails `warpedBase`).
 */

import { FILTER } from '@/features/scanner/lib/filterConstants';

export interface ThumbnailDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Aspect-preserving downscale math for the cached per-page thumbnail (design
 * section 2.3). Returns the ORIGINAL dimensions (rounded to integers)
 * unchanged when the longest edge is already `<= maxEdge` — never upscales.
 * DOM-free, pure, and independently unit-testable.
 */
export function computeThumbnailDimensions(
  width: number,
  height: number,
  maxEdge: number,
): ThumbnailDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError(
      `computeThumbnailDimensions: width and height must be positive finite numbers (got ${width}x${height}).`,
    );
  }
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) {
    throw new RangeError(`computeThumbnailDimensions: maxEdge must be a positive finite number (got ${maxEdge}).`);
  }

  const longestEdge = Math.max(width, height);
  if (longestEdge <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }

  // Scale both dimensions by the same factor so the longest edge lands
  // exactly on maxEdge while preserving the width/height ratio.
  const scale = maxEdge / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Promisified `<canvas>.toBlob` — the fallback path when
 * `OffscreenCanvas.convertToBlob` is unavailable (design section 2.3 /
 * section 8 fallback table). `HTMLCanvasElement.toBlob` is callback-based in
 * every browser that implements it.
 */
function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('pageResources: canvas.toBlob produced a null Blob.'));
        }
      },
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Compresses a live `ImageBitmap` to a JPEG `Blob` (design section 2.3:
 * cached `originalBlob`/`warpedBlob`, ~q0.85 starting value). Uses
 * `OffscreenCanvas.convertToBlob` when available; falls back to a detached
 * `<canvas>.toBlob` otherwise (design section 8 fallback table). Does NOT
 * close `bitmap` — see module-level ownership note.
 */
export async function compressBitmapToJpeg(
  bitmap: ImageBitmap,
  quality: number = FILTER.JPEG_QUALITY,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('compressBitmapToJpeg: failed to acquire 2d context.');
    }
    ctx.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('compressBitmapToJpeg: failed to acquire 2d context.');
  }
  ctx.drawImage(bitmap, 0, 0);
  try {
    return await canvasToBlob(canvas, quality);
  } finally {
    // Release the scratch canvas's backing store immediately (memory
    // hygiene pattern already used by mainThreadImageData.ts).
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Decodes a cached JPEG `Blob` back into a live `ImageBitmap` (design
 * section 2.2 "Activate" / "Reentrada al editor de una pagina inactiva").
 * Thin, named wrapper over `createImageBitmap` — kept as its own function
 * (rather than inlined at call sites) so `useActivePage` stays decode-
 * source-agnostic and the operation is independently mockable in tests.
 */
export async function decodeBlobToBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/**
 * Produces a `~maxEdge`px (longest side) thumbnail `ImageBitmap` from a live
 * bitmap (design section 2.3), preserving aspect ratio, never upscaling.
 * Uses `OffscreenCanvas.transferToImageBitmap()` when available; falls back
 * to `createImageBitmap(<canvas>)` otherwise. Does NOT close `bitmap` — see
 * module-level ownership note.
 */
export async function makeThumbnail(
  bitmap: ImageBitmap,
  maxEdge: number = FILTER.THUMBNAIL_MAX_EDGE,
): Promise<ImageBitmap> {
  const target = computeThumbnailDimensions(bitmap.width, bitmap.height, maxEdge);

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('makeThumbnail: failed to acquire 2d context.');
    }
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    return canvas.transferToImageBitmap();
  }

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('makeThumbnail: failed to acquire 2d context.');
  }
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  try {
    return await createImageBitmap(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
