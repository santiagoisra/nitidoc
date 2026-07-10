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

/** The displayed element's CSS box (e.g. `video.getBoundingClientRect()`). */
export interface VisibleRectBox {
  readonly width: number;
  readonly height: number;
}

/**
 * Aspect mismatch below this threshold is treated as "already matches" —
 * avoids a no-op 1px crop from floating point noise.
 */
const ASPECT_EPSILON = 0.01;

/**
 * Fase 2.3 (capture-ux-redesign.md, D-4 "WYSIWYG"): the live camera preview
 * renders full-bleed with `object-cover`, which means the browser silently
 * crops whichever dimension of the native video stream overflows the
 * displayed box. Without correcting for this, a captured full-res frame
 * would include content the user never actually saw framed on screen (and
 * detection in Unit 4 would run on that same unseen margin). This crops the
 * captured `bitmap` down to exactly the portion `object-cover` was showing.
 *
 * `nativeWidth`/`nativeHeight` are the live `<video>` element's own
 * negotiated resolution (`video.videoWidth`/`video.videoHeight`) — used only
 * to derive the SOURCE aspect ratio, since `captureFullResFrame`'s own 16MP
 * cap (`capCaptureDimensions`) may scale `bitmap` to different absolute
 * pixel dimensions than the live video while preserving the same ratio.
 * `box` is the displayed element's CSS box (what `object-cover` fits into).
 *
 * Takes ownership of `bitmap`: it is closed unless returned UNCHANGED
 * (aspect ratio already matches the box, or the box/native dimensions are
 * not yet usable — e.g. before layout, or a non-browser test environment —
 * in which case guessing a crop would be worse than not cropping at all).
 */
export async function cropToVisibleRect(
  bitmap: ImageBitmap,
  nativeWidth: number,
  nativeHeight: number,
  box: VisibleRectBox,
): Promise<ImageBitmap> {
  if (box.width <= 0 || box.height <= 0 || nativeWidth <= 0 || nativeHeight <= 0) {
    return bitmap;
  }

  const sourceAspect = nativeWidth / nativeHeight;
  const boxAspect = box.width / box.height;

  if (Math.abs(sourceAspect - boxAspect) < ASPECT_EPSILON) {
    return bitmap;
  }

  // Crop FRACTIONS derived from comparing the native/box aspect ratios,
  // applied to the bitmap's own (possibly 16MP-capped, but proportionally
  // identical) pixel dimensions.
  let cropWidthFraction = 1;
  let cropHeightFraction = 1;
  if (boxAspect > sourceAspect) {
    // Box is relatively WIDER than the source -> object-cover crops height.
    cropHeightFraction = sourceAspect / boxAspect;
  } else {
    // Box is relatively TALLER than the source -> object-cover crops width.
    cropWidthFraction = boxAspect / sourceAspect;
  }

  const cropWidth = Math.max(1, Math.round(bitmap.width * cropWidthFraction));
  const cropHeight = Math.max(1, Math.round(bitmap.height * cropHeightFraction));
  const x = Math.round((bitmap.width - cropWidth) / 2);
  const y = Math.round((bitmap.height - cropHeight) / 2);

  try {
    return await createImageBitmap(bitmap, x, y, cropWidth, cropHeight);
  } finally {
    bitmap.close();
  }
}
