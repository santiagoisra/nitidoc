/**
 * Minimal desktop-without-camera import fallback (Group 6 / Slice F, tasks
 * 6.2/6.3; design section 8 "Sin camara"; design ADR-006; scanner spec
 * "Fallback de import de imagen (desktop sin camara)").
 *
 * Deliberately NOT a drag&drop zone, NOT multi-select, and NOT HEIC-aware —
 * those are explicit out-of-scope items for Fase 1 (Fase 6). This module
 * only decodes a single user-selected `File` into an `ImageBitmap`, applies
 * the same 16MP cap used by the camera capture path
 * (`captureResize.capCaptureDimensions`), and hands the result back in the
 * exact same `CapturedFrameResult` shape `captureFrame.ts` produces so the
 * caller (ScannerScreen) can feed it into the SAME pipeline (one-shot
 * DETECT -> CornerEditor -> WARP) without a parallel code path (ADR-006).
 */

import { capCaptureDimensions } from '@/features/scanner/lib/captureResize';
import type { CapturedFrameResult } from '@/features/scanner/lib/captureFrame';

/**
 * Decodes an image `File` to an `ImageBitmap`, applying the 16MP cap before
 * the final bitmap is created (design section 7 — cap applies before any
 * canvas/bitmap allocation). Releases every intermediate resource
 * (`ImageBitmap.close()` on the raw decode, the resize canvas) once the
 * final capped bitmap has been produced.
 *
 * Throws if the file cannot be decoded as an image (e.g. corrupt data, or a
 * non-image MIME type slipping past the `accept="image/*"` filter) — the
 * caller surfaces this as a visible error rather than silently no-oping.
 */
export async function decodeImportedFile(file: File): Promise<CapturedFrameResult> {
  let rawBitmap: ImageBitmap | null = null;
  try {
    rawBitmap = await createImageBitmap(file);

    const target = capCaptureDimensions(rawBitmap.width, rawBitmap.height);
    if (target.width === rawBitmap.width && target.height === rawBitmap.height) {
      const bitmap = rawBitmap;
      rawBitmap = null; // ownership transferred to the caller; do not close below.
      return { bitmap, width: target.width, height: target.height };
    }

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('decodeImportedFile: failed to acquire 2d context for downscale.');
      }
      ctx.drawImage(rawBitmap, 0, 0, target.width, target.height);
      const bitmap = canvas.transferToImageBitmap();
      return { bitmap, width: target.width, height: target.height };
    }

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('decodeImportedFile: failed to acquire 2d context for downscale.');
    }
    ctx.drawImage(rawBitmap, 0, 0, target.width, target.height);
    const bitmap = await createImageBitmap(canvas);
    canvas.width = 0;
    canvas.height = 0;
    return { bitmap, width: target.width, height: target.height };
  } finally {
    rawBitmap?.close();
  }
}

/**
 * `accept` value for the fallback `<input type="file">` (scanner spec:
 * "input minimo de seleccion de archivo"). Exported as a constant so the
 * component and its tests share one source of truth for the negative
 * behavior contract (single file, no drag&drop, no `multiple`).
 */
export const IMPORT_FALLBACK_ACCEPT = 'image/*';
