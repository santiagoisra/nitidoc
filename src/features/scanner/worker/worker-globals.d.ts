/// <reference lib="webworker" />

/**
 * Narrow, `any`-free typings for the classic-worker globals used to load
 * OpenCV.js via `importScripts` (see `opencvLoader.ts`).
 *
 * The `@techstark/opencv-js` UMD build, when loaded with `importScripts` in a
 * classic worker, executes its `typeof importScripts === 'function'` branch and
 * assigns the OpenCV runtime to the global `cv` (`root.cv = factory()`). That
 * runtime is an Emscripten `Module` that exposes:
 *   - `onRuntimeInitialized` — settable callback fired once the WASM runtime is
 *     ready.
 *   - `calledRun` — boolean flag, `true` once the runtime has already run.
 *   - `then(fn)` — thenable that invokes `fn(Module)` immediately if
 *     `calledRun`, otherwise after `onRuntimeInitialized`.
 * (Verified directly against `node_modules/@techstark/opencv-js/dist/opencv.js`.)
 *
 * `lib.webworker.d.ts` already declares `importScripts`, so it is not redeclared
 * here — only the OpenCV runtime shape attached to the worker global scope.
 */

interface OpenCvRuntimeGlobal {
  onRuntimeInitialized?: (() => void) | undefined;
  calledRun?: boolean;
  then?: (onFulfilled: (module: OpenCvRuntimeGlobal) => void) => OpenCvRuntimeGlobal;
  readonly [key: string]: unknown;
}

interface DedicatedWorkerGlobalScope {
  /**
   * The OpenCV.js runtime, present only AFTER `importScripts('/opencv/opencv.js')`
   * has executed. Undefined before that.
   */
  cv?: OpenCvRuntimeGlobal;
}
