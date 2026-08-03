/// <reference lib="webworker" />

/**
 * Off-main-thread JPEG encode + thumbnail for a freshly captured frame
 * (capture-latency, bug 5).
 *
 * WHY THIS EXISTS: every manual capture used to run
 * `Promise.all([makeThumbnail, compressBitmapToJpeg])` over a ~12MP
 * `ImageBitmap` ON THE MAIN THREAD, and the capture screen kept "Siguiente"
 * disabled for the whole duration. On a fast phone that window is invisible.
 * On a slow one it is the entire experience — reported from a real device as
 * "se demora muchísimo entre la captura y poder tocar Siguiente".
 *
 * `OffscreenCanvas.convertToBlob` may hand the actual entropy coding to a
 * browser-internal thread, but `drawImage` at full resolution is a synchronous
 * rasterization, and it was happening on the thread that also has to keep the
 * viewfinder painting and buttons responding.
 *
 * Deliberately a SEPARATE worker from `opencv.worker.ts`: that one is a classic
 * worker whose single-message-loop is occupied by OpenCV's ~10MB init and by
 * detect/warp round-trips. Queueing capture encodes behind that would trade one
 * stall for another, and widening its protocol for work that needs no computer
 * vision would couple two unrelated concerns.
 */

import { computeThumbnailDimensions } from '@/features/scanner/lib/pageResources';

export interface EncodeRequest {
  readonly id: string;
  /** TRANSFERRED in — the main thread must not touch it after posting. */
  readonly bitmap: ImageBitmap;
  readonly quality: number;
  readonly thumbMaxEdge: number;
}

export type EncodeResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly originalBlob: Blob;
      /** TRANSFERRED back — the worker must not touch it after posting. */
      readonly thumbnail: ImageBitmap;
    }
  | { readonly id: string; readonly ok: false; readonly error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function draw(bitmap: ImageBitmap, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('encode.worker: failed to acquire a 2d context.');
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

ctx.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const { id, bitmap, quality, thumbMaxEdge } = event.data;

  void (async () => {
    try {
      const thumbSize = computeThumbnailDimensions(bitmap.width, bitmap.height, thumbMaxEdge);

      // Full-res encode first, then the thumbnail: both read the same bitmap,
      // and it can only be closed once both are done.
      const fullCanvas = draw(bitmap, bitmap.width, bitmap.height);
      const originalBlob = await fullCanvas.convertToBlob({ type: 'image/jpeg', quality });

      const thumbCanvas = draw(bitmap, thumbSize.width, thumbSize.height);
      const thumbnail = thumbCanvas.transferToImageBitmap();

      // The worker owns the transferred-in bitmap and is the only one that can
      // release it — leaking one per capture would be a steady drain across a
      // 30-page document.
      bitmap.close();

      const response: EncodeResponse = { id, ok: true, originalBlob, thumbnail };
      ctx.postMessage(response, [thumbnail]);
    } catch (error) {
      bitmap.close();
      const response: EncodeResponse = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown encode failure',
      };
      ctx.postMessage(response);
    }
  })();
};
