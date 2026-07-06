/**
 * Lazy loader for OpenCV.js (design section 3 ADR-001, section 4).
 *
 * Package choice: `@techstark/opencv-js`. This is NOT a "generic npm
 * build" with different semantics from what ADR-001 decided — it
 * redistributes the exact same official prebuilt single-thread OpenCV.js
 * asset (see its README: "The file `opencv.js` was downloaded from
 * https://docs.opencv.org/<version>/opencv.js"), just packaged for
 * convenient `import()`/bundler consumption instead of a manual
 * `<script>`/`importScripts` fetch. It contains no WASM threads/SIMD-
 * threads and embeds its WASM payload inline in one JS file (~10MB
 * unminified, ~3.3MB gzip) rather than as a separate `.wasm` asset.
 *
 * This module NEVER appears in a static top-level import anywhere in the
 * app — it is only ever reached via the dynamic `import()` calls below, so
 * bundlers (Vite/Rollup) place it in its own lazy chunk, never the initial
 * bundle (scanner spec: "Carga lazy de OpenCV.js").
 */

/**
 * Minimal surface of the Emscripten-style `cv` module this app depends on.
 * Kept intentionally narrow (only what this loader itself uses) instead
 * of importing the full generated `CV` type, to keep the loader boundary
 * explicit and easy to audit. The worker (Group 2.5/2.6) narrows the parts
 * of this same runtime object it actually calls (`Mat`, `MatVector`,
 * `cvtColor`, etc.) via its own local typing.
 */
export interface CvRuntime {
  onRuntimeInitialized: (() => void) | undefined;
  readonly [key: string]: unknown;
}

export type OnProgress = (progress: number, indeterminate: boolean) => void;

/**
 * Resolves the URL of the OpenCV.js chunk exactly as the bundler will
 * serve it, for the progress-tracking fetch below. Vite exposes this via
 * `import.meta.url`-relative resolution when bundling the dynamic import,
 * but the simplest robust approach — and the one used here — is to let
 * the dynamic `import()` do the fetching/instantiation itself and report
 * indeterminate progress, UNLESS a direct fetch of the same asset is
 * available with a `Content-Length` header (design section 4.3, path 1).
 *
 * We attempt the `fetch` + streaming path first using `import.meta.resolve`
 * when supported; if anything about that path fails for any reason (no
 * `Content-Length`, `import.meta.resolve` unsupported, network path
 * differs from what the bundler will use internally), we fall back to a
 * plain dynamic `import()` with indeterminate progress. This never invents
 * a progress API that OpenCV.js does not have — the only source of
 * progress is the Fetch Streams API against the JS chunk itself.
 */
async function tryStreamingProgressFetch(onProgress: OnProgress): Promise<boolean> {
  const resolveFn = (import.meta as unknown as { resolve?: (specifier: string) => string })
    .resolve;
  if (typeof resolveFn !== 'function') {
    return false;
  }

  let url: string;
  try {
    url = resolveFn('@techstark/opencv-js');
  } catch {
    return false;
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return false;
  }

  if (!response.ok || !response.body) {
    return false;
  }

  const contentLengthHeader = response.headers.get('Content-Length');
  const total = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;

  if (total === null || Number.isNaN(total) || total <= 0) {
    // No usable Content-Length: report indeterminate and let the caller
    // fall back to a plain dynamic import (design section 4.3, path 2).
    onProgress(0, true);
    return false;
  }

  const reader = response.body.getReader();
  let received = 0;
  // Drain the stream purely to report progress; the actual module
  // evaluation still happens through the dynamic `import()` below (we do
  // not attempt to construct a synthetic module from these bytes, which
  // would require bypassing the bundler's own module graph).
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    onProgress(Math.min(received / total, 1), false);
  }

  return true;
}

let cvSingleton: CvRuntime | null = null;
let loadPromise: Promise<CvRuntime> | null = null;

/**
 * Loads OpenCV.js exactly once (subsequent calls return the cached
 * promise/instance). Reports progress via `onProgress` and resolves once
 * `cv.onRuntimeInitialized` has fired.
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
    try {
      await tryStreamingProgressFetch(onProgress);
    } catch {
      // Streaming progress is best-effort only; any failure here must not
      // block the actual module load below.
      onProgress(0, true);
    }

    const imported = await import('@techstark/opencv-js');
    const cv = (
      'default' in imported ? (imported as { default: unknown }).default : imported
    ) as CvRuntime;

    await new Promise<void>((resolve) => {
      if (typeof cv['calledRun'] === 'boolean' && cv['calledRun']) {
        // Runtime already initialized synchronously by the time the
        // module resolved (can happen depending on Emscripten build
        // flags) — nothing to wait for.
        resolve();
        return;
      }
      const previous = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        previous?.();
        resolve();
      };
    });

    onProgress(1, false);
    cvSingleton = cv;
    return cv;
  })();

  try {
    return await loadPromise;
  } catch (error) {
    // Allow a subsequent call to retry a fresh load after a failure
    // (design section 4.4 — backoff/retry state machine lives in the
    // worker's INIT handler, this loader just must not get stuck on a
    // permanently-rejected cached promise).
    loadPromise = null;
    throw error;
  }
}

/** Test-only reset hook; not used in production code paths. */
export function __resetOpenCvLoaderForTests(): void {
  cvSingleton = null;
  loadPromise = null;
}
