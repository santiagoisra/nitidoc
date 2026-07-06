/**
 * Feature-detection helpers for camera capture capabilities (design section
 * 5.1 `CameraSlice.imageCaptureSupported` / `offscreenSupported`; design
 * section 8 fallback matrix).
 *
 * Each function accepts the global object it inspects as a parameter (or
 * defaults to `globalThis`) so the detection LOGIC is testable with plain
 * mocks in Node, without needing a real browser. `useCamera` calls these
 * with no arguments in production, letting them read the real globals.
 */

/** True when the `ImageCapture` constructor exists on the given global scope. */
export function detectImageCaptureSupport(scope: typeof globalThis = globalThis): boolean {
  return typeof (scope as { ImageCapture?: unknown }).ImageCapture !== 'undefined';
}

/**
 * True when `OffscreenCanvas` exists on the given global scope. This is a
 * necessary (not sufficient) condition for the worker-internal
 * OffscreenCanvas path; actual capability is confirmed by the worker at
 * INIT time, but the main thread needs this early to decide which capture
 * path (ImageBitmap vs. ImageData) to prepare (design section 8).
 */
export function detectOffscreenCanvasSupport(scope: typeof globalThis = globalThis): boolean {
  return typeof (scope as { OffscreenCanvas?: unknown }).OffscreenCanvas !== 'undefined';
}
