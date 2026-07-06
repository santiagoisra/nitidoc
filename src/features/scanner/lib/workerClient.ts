/**
 * RPC client wrapping `postMessage` communication with `opencv.worker.ts`
 * (design section 1.3). Correlates requests/responses by a monotonic
 * `id`, using a `Map<number, {resolve, reject}>` (design ADR-002).
 *
 * Vite worker convention: constructed with
 * `new Worker(new URL('./opencv.worker.ts', import.meta.url), { type: 'module' })`
 * so Vite's worker plugin picks it up and code-splits it correctly (both
 * in dev and in the production build).
 */

import type {
  AspectRatioName,
  DetectResponse,
  ImageDataLike,
  Quad,
  WarpResponse,
  WarpResponseImageData,
  WorkerErrorCode,
  WorkerRequest,
  WorkerResponse,
} from '@/features/scanner/worker/messages';

export class WorkerError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

interface PendingEntry {
  readonly resolve: (value: WorkerResponse) => void;
  readonly reject: (reason: WorkerError) => void;
}

export interface WorkerClient {
  init(onProgress: (progress: number) => void): Promise<void>;
  detect(bitmap: ImageBitmap, withQuality: boolean): Promise<DetectResponse>;
  warp(
    image: ImageDataLike,
    corners: Quad,
    aspectRatio: AspectRatioName,
  ): Promise<WarpResponse | WarpResponseImageData>;
  /** True while a DETECT request is in flight (drop-latest backpressure, design section 2.1). */
  isBusy(): boolean;
  terminate(): void;
}

function isErrorResponse(
  response: WorkerResponse,
): response is Extract<WorkerResponse, { type: 'ERROR' }> {
  return response.type === 'ERROR';
}

export function createWorkerClient(): WorkerClient {
  const worker = new Worker(new URL('../worker/opencv.worker.ts', import.meta.url), {
    type: 'module',
  });

  return createWorkerClientForWorker(worker);
}

function createWorkerClientForWorker(worker: Worker): WorkerClient {

  let nextId = 1;
  const pending = new Map<number, PendingEntry>();
  let detectInFlight = false;
  let progressCallback: ((progress: number) => void) | null = null;

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;

    if (response.type === 'PROGRESS') {
      progressCallback?.(response.progress);
      return;
    }

    const entry = pending.get(response.id);
    if (!entry) {
      // Response for a request we no longer track (e.g. a stale DETECT
      // whose caller already moved on) — safe to ignore.
      return;
    }
    pending.delete(response.id);

    if (response.type === 'DETECT_RESULT') {
      detectInFlight = false;
    }

    if (isErrorResponse(response)) {
      if (response.code === 'DETECT_FAILED') {
        detectInFlight = false;
      }
      entry.reject(new WorkerError(response.code, response.message));
      return;
    }

    entry.resolve(response);
  });

  worker.addEventListener('error', (event: ErrorEvent) => {
    // An uncaught error in the worker (e.g. failed to even load the
    // module) rejects every pending request; the caller decides on
    // retry/backoff policy (design section 4.4).
    const error = new WorkerError('OPENCV_LOAD_FAILED', event.message);
    for (const [, entry] of pending) {
      entry.reject(error);
    }
    pending.clear();
    detectInFlight = false;
  });

  function send<T extends WorkerResponse>(
    request: WorkerRequest,
    transfer: readonly Transferable[],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.set(request.id, {
        resolve: resolve as (value: WorkerResponse) => void,
        reject,
      });
      worker.postMessage(request, transfer as Transferable[]);
    });
  }

  return {
    async init(onProgress) {
      progressCallback = onProgress;
      const id = nextId++;
      await send({ id, type: 'INIT' }, []);
    },

    async detect(bitmap, withQuality) {
      const id = nextId++;
      detectInFlight = true;
      try {
        return await send<DetectResponse>({ id, type: 'DETECT', bitmap, withQuality }, [bitmap]);
      } finally {
        detectInFlight = false;
      }
    },

    async warp(image, corners, aspectRatio) {
      const id = nextId++;
      return send<WarpResponse | WarpResponseImageData>(
        { id, type: 'WARP', image, corners, aspectRatio },
        [image.data.buffer],
      );
    },

    isBusy() {
      return detectInFlight;
    },

    terminate() {
      worker.terminate();
      // Reject every in-flight request before dropping them (fix L2): a
      // bare `.clear()` left callers awaiting `detect()`/`warp()`/`init()`
      // hanging forever with no resolve/reject ever firing. Mirrors the
      // worker `error` handler's own reject-then-clear behavior above.
      const terminationError = new WorkerError(
        'NOT_INITIALIZED',
        'Worker terminated while a request was still in flight.',
      );
      for (const [, entry] of pending) {
        entry.reject(terminationError);
      }
      pending.clear();
      detectInFlight = false;
    },
  };
}

/**
 * Module-level shared WorkerClient singleton (Slice D review fix C2).
 *
 * DECISION — one worker per app session, NOT one per hook instance.
 * The detection hook previously created the worker via `useMemo` + a
 * per-instance ref. Under React 18 StrictMode (dev) the component mounts,
 * unmounts, and remounts with a FRESH ref, so `new Worker()` ran twice and
 * OpenCV.js downloaded twice; the per-instance cleanup never terminated the
 * first worker, leaking an orphan worker on every StrictMode double-mount and
 * on every navigate-away/return.
 *
 * Making the worker a lazily-created module singleton guarantees:
 *  (a) a single OpenCV download even when StrictMode double-mounts, because the
 *      same worker (and its already-resolved / in-flight `init()` promise) is
 *      reused instead of reconstructed;
 *  (b) no orphaned workers accumulate on remount, because the hook no longer
 *      owns the worker lifecycle and therefore never calls `terminate()` on
 *      unmount — the shared instance simply stays alive for the session.
 *
 * Consequently, hook unmount MUST NOT terminate this client. If a full teardown
 * is ever needed (e.g. leaving the scanner feature entirely), call
 * `terminateSharedWorkerClient()` explicitly.
 */
let sharedWorkerClient: WorkerClient | null = null;

export function getSharedWorkerClient(): WorkerClient {
  if (!sharedWorkerClient) {
    sharedWorkerClient = createWorkerClient();
  }
  return sharedWorkerClient;
}

/** Terminates and clears the shared client. Intended for explicit teardown / tests only. */
export function terminateSharedWorkerClient(): void {
  if (sharedWorkerClient) {
    sharedWorkerClient.terminate();
    sharedWorkerClient = null;
  }
}
