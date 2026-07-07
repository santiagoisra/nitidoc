/// <reference lib="webworker" />

/**
 * Loader for OpenCV.js inside a CLASSIC Web Worker (design section 3 ADR-001,
 * section 4).
 *
 * WHY `importScripts` and not `import()`: `@techstark/opencv-js` redistributes
 * the exact official prebuilt single-thread OpenCV.js asset — a CLASSIC
 * Emscripten UMD bundle (~10MB unminified, WASM embedded inline, no separate
 * `.wasm`). That build assumes a classic global-script scope; its bootstrap
 * never completes when loaded as a bundled dynamic `import()` inside an
 * ES-module worker (confirmed empirically: `init()` hangs indefinitely, the
 * worker message loop stays blocked). Loading it as a plain static script via
 * `self.importScripts('/opencv/opencv.js')` in a CLASSIC worker hits the UMD's
 * `typeof importScripts === 'function'` branch (`root.cv = factory()`) and
 * bootstraps correctly — the canonical opencv.js-in-worker pattern.
 *
 * The asset is served at `/opencv/opencv.js` (copied from node_modules into
 * `public/opencv/` by `scripts/copy-opencv.mjs` before dev/build/E2E). Because
 * the WASM is embedded inline, NO `locateFile` and NO separate `.wasm` fetch
 * are needed — a single `importScripts` is sufficient.
 */

/** URL of the served OpenCV.js UMD asset (see scripts/copy-opencv.mjs). */
const OPENCV_ASSET_URL = '/opencv/opencv.js';

/**
 * Minimal surface of the Emscripten-style `cv` runtime this app depends on.
 * Kept intentionally narrow instead of importing the full generated `CV` type,
 * to keep the loader boundary explicit and easy to audit. The worker
 * (cvBindings.ts) narrows the parts it actually calls (`Mat`, `MatVector`,
 * `cvtColor`, …) via its own local typing.
 */
export interface CvRuntime {
  onRuntimeInitialized: (() => void) | undefined;
  readonly [key: string]: unknown;
}

export type OnProgress = (progress: number, indeterminate: boolean) => void;

/**
 * Streams the OpenCV.js asset purely to report determinate download progress
 * when the server sends a usable `Content-Length`. The bytes read here are
 * discarded — the actual runtime is still instantiated by `importScripts`
 * below (which re-reads the asset from the HTTP cache). Any failure is
 * non-fatal: we fall back to indeterminate progress and let `importScripts`
 * do the real work.
 *
 * Returns `true` if determinate progress was reported to completion, `false`
 * otherwise (caller then reports indeterminate).
 */
async function tryStreamingProgressFetch(onProgress: OnProgress): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(OPENCV_ASSET_URL);
  } catch {
    return false;
  }

  if (!response.ok || !response.body) {
    return false;
  }

  const contentLengthHeader = response.headers.get('Content-Length');
  const total = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;

  if (total === null || Number.isNaN(total) || total <= 0) {
    // No usable Content-Length: report indeterminate and let importScripts run.
    onProgress(0, true);
    return false;
  }

  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    onProgress(Math.min(received / total, 1), false);
  }

  return true;
}

/**
 * Resolves once the OpenCV WASM runtime has finished initializing.
 *
 * After `importScripts`, the global `cv` object exists but its WASM runtime
 * initializes asynchronously. This build (verified against
 * `node_modules/@techstark/opencv-js/dist/opencv.js`) exposes:
 *   - `cv.calledRun === true` once the runtime has already run, and
 *   - `cv.onRuntimeInitialized`, a callback fired exactly once when it becomes
 *     ready (the same signal `cv.then(fn)` internally waits on).
 * We check `calledRun` first (runtime may already be up by the time we look),
 * otherwise we chain onto `onRuntimeInitialized` — preserving any previously
 * assigned callback.
 */
function waitForRuntime(cv: CvRuntime): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof cv['calledRun'] === 'boolean' && cv['calledRun']) {
      resolve();
      return;
    }
    const previous = cv.onRuntimeInitialized;
    cv.onRuntimeInitialized = () => {
      previous?.();
      resolve();
    };
  });
}

let cvSingleton: CvRuntime | null = null;
let loadPromise: Promise<CvRuntime> | null = null;

/**
 * Loads OpenCV.js exactly once (subsequent calls return the cached
 * promise/instance). Reports progress via `onProgress` and resolves once the
 * WASM runtime has initialized.
 *
 * MUST run inside a CLASSIC worker: relies on `self.importScripts`.
 */
export async function loadOpenCv(onProgress: OnProgress): Promise<CvRuntime> {
  if (cvSingleton) {
    onProgress(1, false);
    return cvSingleton;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    const workerScope = self as DedicatedWorkerGlobalScope;

    if (typeof workerScope.importScripts !== 'function') {
      throw new Error(
        'loadOpenCv must run inside a classic Web Worker (importScripts unavailable).',
      );
    }

    try {
      await tryStreamingProgressFetch(onProgress);
    } catch {
      // Streaming progress is best-effort only; never let it block the load.
      onProgress(0, true);
    }

    // Synchronous: on return, the OpenCV runtime is assigned to `self.cv`.
    workerScope.importScripts(OPENCV_ASSET_URL);

    const cv = workerScope.cv as CvRuntime | undefined;
    if (!cv) {
      throw new Error('importScripts loaded opencv.js but global `cv` was not defined.');
    }

    await waitForRuntime(cv);

    onProgress(1, false);
    cvSingleton = cv;
    return cv;
  })();

  try {
    return await loadPromise;
  } catch (error) {
    // Allow a subsequent call to retry a fresh load after a failure (design
    // section 4.4). Do not get stuck on a permanently-rejected cached promise.
    loadPromise = null;
    throw error;
  }
}

/** Test-only reset hook; not used in production code paths. */
export function __resetOpenCvLoaderForTests(): void {
  cvSingleton = null;
  loadPromise = null;
}
