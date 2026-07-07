/**
 * Main-thread `ImageData` extraction for the no-`OffscreenCanvas` fallback
 * (task 6.7.1; design section 8). Used when `CameraSlice.offscreenSupported`
 * is `false` — the caller extracts pixels itself via a regular `<canvas>`
 * instead of relying on the worker's internal `OffscreenCanvas` (which may
 * not exist in that worker's own global scope either, historically Safari
 * < 16.4).
 *
 * Kept separate from `captureFrame.ts` (full-res CAPTURE path, produces a
 * `CapturedFrameResult`) because this module's only job is producing a
 * `DETECT`-ready `ImageDataLike` from an already-available `ImageBitmap`.
 */

import type { ImageDataLike } from '@/features/scanner/worker/messages';

/**
 * Draws `bitmap` into a scratch `<canvas>` and extracts its pixels as a
 * plain `ImageDataLike` (transferable, per design section 1.2). Closes the
 * input bitmap once its pixels have been read, and releases the scratch
 * canvas's backing store immediately after — mirrors the memory-hygiene
 * pattern already used by `captureFrame.ts`/`captureFallback.ts` (design
 * section 7).
 */
export function bitmapToImageData(bitmap: ImageBitmap): ImageDataLike {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('bitmapToImageData: failed to acquire 2d context.');
  }
  try {
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: imageData.width, height: imageData.height, data: imageData.data };
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
