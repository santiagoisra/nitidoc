/**
 * Full-resolution frame capture (design section 2.2 capture->warp sequence;
 * design section 7 memory hygiene; scanner spec "Captura de frame full-res").
 *
 * Two capture paths, chosen by `imageCaptureSupported`:
 *  - `ImageCapture.takePhoto()`/`grabFrame()` when supported.
 *  - `drawImage(video)` onto a canvas at the track's real size otherwise
 *    (scanner spec "Fallback a drawImage sin soporte de ImageCapture").
 *
 * Both paths apply the 16MP cap (`capCaptureDimensions`) BEFORE creating the
 * final bitmap, and both release every intermediate resource they create
 * (`ImageBitmap.close()`, `URL.revokeObjectURL()`) — scanner spec
 * "Liberacion de recursos tras captura".
 */

import { capCaptureDimensions } from '@/features/scanner/lib/captureResize';

export interface CapturedFrameResult {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
}

/**
 * `lib.dom.d.ts` declares `ImageCapture.takePhoto()` but omits `grabFrame()`,
 * which is part of the same MediaStream Image Capture spec and implemented
 * by browsers that support the API. Extend the real global interface
 * locally instead of redefining `ImageCapture` from scratch (same pattern
 * as `cvBindings.ts` for OpenCV.js's own type gaps).
 */
interface ImageCaptureLike extends ImageCapture {
  grabFrame(): Promise<ImageBitmap>;
}

interface ImageCaptureConstructor {
  new (track: MediaStreamTrack): ImageCaptureLike;
}

function getImageCaptureConstructor(): ImageCaptureConstructor | null {
  if (typeof ImageCapture === 'undefined') {
    return null;
  }
  return ImageCapture as unknown as ImageCaptureConstructor;
}

/**
 * Draws a full ImageBitmap/canvas source into a freshly sized canvas so the
 * result matches `target` dimensions (used for the 16MP downscale step).
 * Uses `OffscreenCanvas` when available, otherwise a regular `<canvas>`.
 */
async function resizeToBitmap(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  target: { width: number; height: number },
): Promise<ImageBitmap> {
  if (target.width === sourceWidth && target.height === sourceHeight) {
    return createImageBitmap(source);
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('captureFrame: failed to acquire 2d context for downscale.');
    }
    ctx.drawImage(source, 0, 0, target.width, target.height);
    return canvas.transferToImageBitmap();
  }

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('captureFrame: failed to acquire 2d context for downscale.');
  }
  ctx.drawImage(source, 0, 0, target.width, target.height);
  return createImageBitmap(canvas);
}

/** Captures via `ImageCapture.takePhoto()` (falls back to `grabFrame()` if `takePhoto` rejects). */
async function captureViaImageCapture(track: MediaStreamTrack): Promise<CapturedFrameResult> {
  const ImageCaptureCtor = getImageCaptureConstructor();
  if (!ImageCaptureCtor) {
    throw new Error('captureViaImageCapture: ImageCapture is not available.');
  }

  const capturer = new ImageCaptureCtor(track);
  let rawBitmap: ImageBitmap | null = null;
  let objectUrl: string | null = null;

  try {
    try {
      const blob = await capturer.takePhoto();
      objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.src = objectUrl;
      await img.decode();
      rawBitmap = await createImageBitmap(img);
    } catch {
      // takePhoto() is not implemented/supported everywhere that ImageCapture
      // itself is; grabFrame() is the documented fallback within the same API.
      rawBitmap = await capturer.grabFrame();
    }

    const target = capCaptureDimensions(rawBitmap.width, rawBitmap.height);
    const finalBitmap = await resizeToBitmap(rawBitmap, rawBitmap.width, rawBitmap.height, target);
    return { bitmap: finalBitmap, width: target.width, height: target.height };
  } finally {
    rawBitmap?.close();
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

/** Fallback: draws the live `<video>` element onto a canvas at its real (getSettings()) size. */
async function captureViaDrawImage(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
): Promise<CapturedFrameResult> {
  const settings = track.getSettings();
  const sourceWidth = settings.width ?? video.videoWidth;
  const sourceHeight = settings.height ?? video.videoHeight;

  const target = capCaptureDimensions(sourceWidth, sourceHeight);
  const bitmap = await resizeToBitmap(video, sourceWidth, sourceHeight, target);
  return { bitmap, width: target.width, height: target.height };
}

/**
 * Captures the current frame at full resolution, applying the 16MP cap.
 * Picks `ImageCapture` when `preferImageCapture` is true (i.e.
 * `CameraSlice.imageCaptureSupported`), otherwise falls back to
 * `drawImage(video)`.
 */
export async function captureFullResFrame(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  preferImageCapture: boolean,
): Promise<CapturedFrameResult> {
  if (preferImageCapture && getImageCaptureConstructor()) {
    try {
      return await captureViaImageCapture(track);
    } catch {
      // Feature-detection said ImageCapture exists, but the concrete call
      // failed at runtime (seen on some partial implementations) — fall
      // through to the always-available drawImage path rather than failing
      // the capture outright.
      return captureViaDrawImage(video, track);
    }
  }

  return captureViaDrawImage(video, track);
}

/**
 * Releases a previously captured frame's bitmap. Callers MUST invoke this
 * before discarding a `CapturedFrameResult`/replacing it with a new one
 * (design section 7 — no ImageBitmap outlives its capture's lifecycle
 * unless retained on purpose as `CapturedFrame.source` for re-warp).
 */
export function releaseCapturedFrame(frame: CapturedFrameResult | null): void {
  frame?.bitmap.close();
}
