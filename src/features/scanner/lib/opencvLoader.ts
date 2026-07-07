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

/**
 * Path of the served OpenCV.js UMD asset (see scripts/copy-opencv.mjs).
 * NOTE: consumers resolve this to an ABSOLUTE URL on the main thread and pass
 * it into `loadOpenCv`. The worker must never fetch/importScripts a bare
 * relative path — in Vite's dev worker the base URL is opaque and it fails.
 */
export const OPENCV_ASSET_PATH = '/opencv/opencv.js';

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

/**
 * Non-thenable holder for the loaded OpenCV runtime.
 *
 * CRITICAL: the Emscripten `cv` object is itself a THENABLE — it exposes a
 * `cv.then(fn)` that fires on runtime init. If a Promise is ever resolved with
 * (or an async function `return`s) the raw `cv`, the Promise machinery tries to
 * adopt the thenable's state by calling `cv.then(resolve, reject)` — and
 * `cv.then` calls `resolve(cv)` with that SAME thenable, so resolution recurses
 * on itself and the promise NEVER settles. Symptom: `INIT` reports progress to
 * completion but `INIT_DONE` never fires, so DETECT/WARP never run and the UI
 * hangs on "Processing…". We therefore hand the runtime across every `await`
 * boundary wrapped in this plain object, never as the bare thenable.
 */
export interface LoadedOpenCv {
  readonly cv: CvRuntime;
}

let cvSingleton: CvRuntime | null = null;
let loadPromise: Promise<LoadedOpenCv> | null = null;

/**
 * Loads OpenCV.js exactly once (subsequent calls return the cached
 * promise/instance). Reports progress via `onProgress` and resolves once the
 * WASM runtime has initialized. Resolves with a {@link LoadedOpenCv} wrapper —
 * never the bare (thenable) runtime — see the note above.
 *
 * MUST run inside a CLASSIC worker: relies on `self.importScripts`.
 *
 * @param assetUrl ABSOLUTE URL of the served OpenCV.js asset. Resolved on the
 *   main thread (reliable `location.origin`) — never a bare relative path,
 *   which fails to resolve in Vite's dev worker context.
 */
export async function loadOpenCv(
  onProgress: OnProgress,
  assetUrl: string,
): Promise<LoadedOpenCv> {
  if (cvSingleton) {
    onProgress(1, false);
    return { cv: cvSingleton };
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async (): Promise<LoadedOpenCv> => {
    const workerScope = self as DedicatedWorkerGlobalScope;

    if (typeof workerScope.importScripts !== 'function') {
      throw new Error(
        'loadOpenCv must run inside a classic Web Worker (importScripts unavailable).',
      );
    }

    // Report indeterminate progress, then load synchronously via importScripts.
    // We deliberately do NOT pre-stream the asset for a determinate progress
    // bar: that re-downloads the ~10 MB asset a second time (importScripts reads
    // it again anyway) and, in the bundled production worker, the streaming read
    // stalled and hung init (INIT never completed → detection/warp never ran).
    // A one-time indeterminate spinner is the right trade-off for a lazy load.
    onProgress(0, true);

    // Synchronous: on return, the OpenCV runtime is assigned to `self.cv`.
    workerScope.importScripts(assetUrl);

    const runtime = workerScope.cv as CvRuntime | undefined;
    if (!runtime) {
      throw new Error('importScripts loaded opencv.js but global `cv` was not defined.');
    }

    await waitForRuntime(runtime);

    onProgress(1, false);
    cvSingleton = runtime;
    // Wrap: never resolve this promise with the thenable runtime itself.
    return { cv: runtime };
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
