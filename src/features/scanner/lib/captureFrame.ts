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
       // Persist the capped full source unchanged. Preview `object-cover` is
       // presentation-only; using it to crop would remove page-edge evidence
       // needed for safe detection and later corner editing.
      rawBitmap = await capturer.grabFrame();
    } catch {
       // grabFrame() is not implemented/supported everywhere ImageCapture
       // itself is; takePhoto() is the documented fallback within the same API.
      const blob = await capturer.takePhoto();
      objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.src = objectUrl;
      await img.decode();
      rawBitmap = await createImageBitmap(img);
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

/**
 * Fallback: draws the live `<video>` element onto a canvas. Manual guide
 * captures opt into its decoded preview dimensions, which are the coordinate
 * space used by the object-cover mapper; ordinary captures retain the
 * track-settings full-source behaviour.
 */
async function captureViaDrawImage(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  usePreviewDimensions = false,
): Promise<CapturedFrameResult> {
  const settings = track.getSettings();
  const sourceWidth = usePreviewDimensions && video.videoWidth > 0 ? video.videoWidth : settings.width ?? video.videoWidth;
  const sourceHeight = usePreviewDimensions && video.videoHeight > 0 ? video.videoHeight : settings.height ?? video.videoHeight;

  const target = capCaptureDimensions(sourceWidth, sourceHeight);
  const bitmap = await resizeToBitmap(video, sourceWidth, sourceHeight, target);
  return { bitmap, width: target.width, height: target.height };
}

/**
 * Captures the current frame at full resolution, applying the 16MP cap.
 * Picks `ImageCapture` when `preferImageCapture` is true (i.e.
 * `CameraSlice.imageCaptureSupported`), otherwise falls back to
 * `drawImage(video)`. `usePreviewDimensions` makes the drawImage result use
 * the decoded video coordinate space and is required for manual guide crops.
 */
export async function captureFullResFrame(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  preferImageCapture: boolean,
  usePreviewDimensions = false,
): Promise<CapturedFrameResult> {
  if (preferImageCapture && getImageCaptureConstructor()) {
    try {
      return await captureViaImageCapture(track);
    } catch {
      // Feature-detection said ImageCapture exists, but the concrete call
      // failed at runtime (seen on some partial implementations) — fall
      // through to the always-available drawImage path rather than failing
      // the capture outright.
      return captureViaDrawImage(video, track, usePreviewDimensions);
    }
  }

  return captureViaDrawImage(video, track, usePreviewDimensions);
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
