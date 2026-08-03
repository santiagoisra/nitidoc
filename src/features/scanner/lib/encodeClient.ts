/**
 * Client for `encode.worker.ts` (capture-latency, bug 5), with a main-thread
 * fallback.
 *
 * The fallback is not decoration. `OffscreenCanvas` is what makes the worker
 * path possible at all, and the app already ships a documented
 * detached-`<canvas>` fallback for exactly the environments that lack it
 * (`pageResources.ts`, design section 8's fallback table). Where the worker
 * cannot run, capture must still work — slowly, as it did before, rather than
 * not at all.
 */

import { compressBitmapToJpeg, makeThumbnail } from '@/features/scanner/lib/pageResources';
import type { EncodeRequest, EncodeResponse } from '@/features/scanner/worker/encode.worker';

export interface EncodedCapture {
  readonly originalBlob: Blob;
  readonly thumbnail: ImageBitmap;
}

/** Whether the off-thread path can run at all in this environment. */
function workerPathAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<string, { resolve: (value: EncodedCapture) => void; reject: (reason: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL('@/features/scanner/worker/encode.worker.ts', import.meta.url), {
    name: 'nitidoc-encode',
  });

  worker.onmessage = (event: MessageEvent<EncodeResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) {
      entry.resolve({ originalBlob: message.originalBlob, thumbnail: message.thumbnail });
    } else {
      entry.reject(new Error(message.error));
    }
  };

  worker.onerror = () => {
    // A worker-level failure (bad bundle, OOM) leaves every in-flight request
    // hanging forever, which would freeze the capture screen far worse than a
    // slow encode. Fail them all and drop the worker so the next capture
    // rebuilds it — or falls back.
    const error = new Error('encode.worker failed');
    pending.forEach((entry) => entry.reject(error));
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

/**
 * Compresses `bitmap` to JPEG and derives a thumbnail, off the main thread when
 * possible.
 *
 * OWNERSHIP: this call takes `bitmap` and always releases it — on the worker
 * path it is transferred (and closed inside the worker), on the fallback path
 * it is closed here. Callers must not touch it afterwards either way, which
 * keeps the contract identical across both paths.
 */
export async function encodeCapture(
  bitmap: ImageBitmap,
  quality: number,
  thumbMaxEdge: number,
): Promise<EncodedCapture> {
  if (!workerPathAvailable()) {
    try {
      const [thumbnail, originalBlob] = await Promise.all([
        makeThumbnail(bitmap, thumbMaxEdge),
        compressBitmapToJpeg(bitmap, quality),
      ]);
      return { originalBlob, thumbnail };
    } finally {
      bitmap.close();
    }
  }

  const id = `encode-${(nextRequestId += 1)}`;
  const request: EncodeRequest = { id, bitmap, quality, thumbMaxEdge };

  return new Promise<EncodedCapture>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      // `bitmap` is TRANSFERRED: after this line the main thread's handle is
      // detached, which is precisely the point — no full-res pixels are touched
      // on this thread again.
      ensureWorker().postMessage(request, [bitmap]);
    } catch (error) {
      pending.delete(id);
      bitmap.close();
      reject(error instanceof Error ? error : new Error('Could not post to encode.worker'));
    }
  });
}

/** Test seam — drops the shared worker so a suite can start from a clean slate. */
export function resetEncodeWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
