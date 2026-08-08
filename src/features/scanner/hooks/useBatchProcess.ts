/**
 * `useBatchProcess` — deferred batch processing (Fase 2.3, capture-ux-
 * redesign.md, "Unit 4 — Deferred batch processing"). Converts every
 * accumulated `RawCapture` into a `DocumentPage` SEQUENTIALLY (never
 * `Promise.all` over pages — design "Memory": peak live full-res memory
 * stays bounded to ~1 page regardless of document length) once the user
 * taps "Siguiente" and `DocumentSlice.phase` becomes `'processing'`.
 *
 * Per raw capture (sorted by `order`): decode -> DETECT on a downscaled copy
 * (full-res corners scaled back up, falling back to `frameCorners` +
 * `needsReview: true` on a missing/non-convex quad) -> build the
 * NEUTRAL-filter `EditRecipe` (D-2, `createInitialRecipe` seeds it
 * internally) -> WARP the full-res original -> thumbnail+compress the warp
 * base -> `addPage` -> `removeRawCapture` (single close owner, conserves the
 * combined page cap) -> close every live bitmap this page allocated.
 *
 * Degraded fallback (mandatory — never silently drops a page): if the
 * caller's `ensureOpenCvInit()` rejected (OpenCV never loaded this session)
 * OR a per-page `workerClient.warp` call throws, that page is built WITHOUT
 * the worker instead — the original is drawn onto a main-thread canvas as an
 * IDENTITY "warp" base, `corners` falls back to `frameCorners`, and
 * `needsReview` is forced true. A `DocumentPage` is ALWAYS produced for
 * every raw capture that can be decoded at all (an undecodable/corrupt blob
 * — not expected in practice since it was produced by our own
 * `compressBitmapToJpeg` moments earlier — is the one case nothing further
 * can be done with it; it is skipped and discarded by the end-of-run
 * `clearRawCaptures()` cleanup).
 *
 * Run-once/idempotency: a `ranRef` guard plus a `processedIds` set (dedupe
 * by `raw.id`) so a StrictMode double-invoke (or any other re-entrant call
 * to `run()`) never re-adds pages. `cancel()` (and unmount) close whatever
 * bitmap the CURRENTLY in-flight page owns via a shared tracker, so a
 * cancelled batch never leaks a live bitmap even though the page it was
 * mid-way through is discarded (its `RawCapture` is left untouched in
 * `rawCaptures`, retryable on a later "Siguiente").
 *
 * `ensureOpenCvInit`/`workerClient` are INJECTED rather than obtained via a
 * fresh `useOpenCvInit()` call here, because that hook's own consumer
 * contract requires exactly one live call site per session (see
 * `useOpenCvInit.ts`'s doc comment) — `ScannerScreen` is already that one
 * call site for the whole screen's lifetime, so this hook reuses its
 * `ensureOpenCvInit`/`workerClient` (forwarded through `ProcessingScreen`)
 * instead of racing a second one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerClient } from '@/features/scanner/lib/workerClient';
import { compressBitmapToJpeg, decodeBlobToBitmap, makeThumbnail } from '@/features/scanner/lib/pageResources';
import { bitmapToImageData } from '@/features/scanner/lib/mainThreadImageData';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import { scaleCornersToFullRes } from '@/features/scanner/lib/detectionMath';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { createInitialRecipe, frameCorners } from '@/features/scanner/lib/editRecipe';
import { isConvex, measuredQuadRatio, orderCorners } from '@/features/scanner/lib/geometry';
import { classifyPaperRatio, resolveWarpGeometry } from '@/features/scanner/lib/paperFormats';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { RawCapture } from '@/features/scanner/store/documentSlice';
import type { ImageDataLike } from '@/features/scanner/worker/messages';
import type { Quad } from '@/shared/types/geometry';

export interface UseBatchProcessOptions {
  /** Idempotent, shared across the session (see module doc comment on why this is injected, not obtained via a fresh `useOpenCvInit()` call). */
  readonly ensureOpenCvInit: () => Promise<void>;
  readonly workerClient: WorkerClient;
}

export interface RunBatchResult {
  /** How many `DocumentPage`s were actually committed this run. */
  readonly addedCount: number;
  /** True when `cancel()` (or unmount) aborted the run before it finished naturally. */
  readonly cancelled: boolean;
  /**
   * How many raw captures this run ATTEMPTED to process (`sorted.length` at
   * the time the run actually started; `0` on a run-once no-op). Review fix:
   * `ProcessingScreen` used to compare `addedCount` against its own `total`
   * REACT STATE, read inside a mount-only effect's closure — that closure
   * captured `total` at its initial render value (`0`), before `run()` ever
   * updated it, so the "all pages failed" toast condition (`addedCount === 0
   * && total > 0`) could never be true. Returning the attempted count
   * directly from `run()` lets the caller check it without relying on a
   * stale closure.
   */
  readonly total: number;
}

export interface UseBatchProcessResult {
  readonly processing: boolean;
  readonly done: number;
  readonly total: number;
  /**
   * Starts the batch. No-op (resolves with `{ addedCount: 0, cancelled: false }`)
   * if already run (run-once guard) — safe to call from a mount effect under
   * StrictMode. The resolved result lets the caller (e.g. `ProcessingScreen`)
   * decide UI feedback such as the zero-pages-created banner without
   * re-deriving it from `phase` alone.
   */
  readonly run: () => Promise<RunBatchResult>;
  /** Aborts after releasing whatever the in-flight page owns; leaves `rawCaptures` untouched; returns to `'capturing'`. */
  readonly cancel: () => void;
}

/** Thrown internally to unwind out of a page's processing once `cancel()`/unmount has fired. Never surfaces past `run()`. */
class BatchCancelledError extends Error {}

/** Tracks the CURRENTLY live bitmap(s) for whichever raw capture is being processed, so `cancel()`/unmount can release them without leaking (F1 hygiene). */
interface InFlightTracker {
  originalBitmap: ImageBitmap | null;
  detectionBitmap: ImageBitmap | null;
  warpedBase: ImageBitmap | null;
}

function closeInFlight(tracker: InFlightTracker): void {
  tracker.originalBitmap?.close();
  tracker.detectionBitmap?.close();
  tracker.warpedBase?.close();
  tracker.originalBitmap = null;
  tracker.detectionBitmap = null;
  tracker.warpedBase = null;
}

/**
 * Non-closing full-res `ImageData` extraction (mirrors `CornerEditor`'s
 * private helper of the same shape) — unlike `mainThreadImageData.ts`'s
 * `bitmapToImageData`, this must NOT close `bitmap`: the degraded fallback
 * below may still need to draw the SAME `originalBitmap` again if the warp
 * this feeds into throws.
 */
function extractImageData(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('useBatchProcess: failed to acquire 2d context to extract full-res ImageData.');
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** Paints a `WARP_RESULT_IMAGEDATA` fallback response into a fresh bitmap (mirrors `CornerEditor`'s own handling of the no-OffscreenCanvas WARP reply). */
async function paintImageDataLikeToBitmap(image: ImageDataLike): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('useBatchProcess: failed to acquire 2d context for WARP_RESULT_IMAGEDATA.');
  }
  const pixelData = new Uint8ClampedArray(image.data);
  ctx.putImageData(new ImageData(pixelData, image.width, image.height), 0, 0);
  try {
    return await createImageBitmap(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Degraded/warp-fail fallback (mandatory — see module doc comment): draws `originalBitmap` onto a plain `<canvas>` UNCHANGED, i.e. an identity "warp", so a page is still produced without the worker. */
async function buildIdentityWarpedBase(originalBitmap: ImageBitmap): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas');
  canvas.width = originalBitmap.width;
  canvas.height = originalBitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('useBatchProcess: failed to acquire 2d context for the degraded identity warp.');
  }
  ctx.drawImage(originalBitmap, 0, 0);
  try {
    return await createImageBitmap(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

interface ProcessOneRawCaptureDeps {
  readonly openCvDegraded: boolean;
  readonly workerClient: WorkerClient;
  readonly tracker: InFlightTracker;
  readonly isCancelled: () => boolean;
}

/**
 * Runs the full detect -> warp -> thumbnail pipeline for ONE raw capture and
 * commits it as a `DocumentPage` (`addPage` + `removeRawCapture`). Every
 * bitmap this function allocates is tracked into `deps.tracker` IMMEDIATELY
 * upon creation (before any subsequent cancellation check), so the `finally`
 * below can always find and release whatever is still live — on success
 * that is `originalBitmap`/`warpedBase` (their job is done once compressed
 * into blobs/thumbnail); on a thrown `BatchCancelledError` (or any other
 * error) it is whatever got at least partially built.
 *
 * Throws `BatchCancelledError` (never committing anything) if `cancel()`
 * fires at any checkpoint; any OTHER thrown error means this one raw capture
 * could not be processed even by the degraded fallback (e.g. an undecodable
 * blob) — the caller decides whether to skip it and continue.
 */
async function processOneRawCapture(raw: RawCapture, deps: ProcessOneRawCaptureDeps): Promise<void> {
  const checkCancelled = (): void => {
    if (deps.isCancelled()) {
      throw new BatchCancelledError();
    }
  };

  try {
    const originalBitmap = await decodeBlobToBitmap(raw.originalBlob);
    deps.tracker.originalBitmap = originalBitmap;
    checkCancelled();

    // ── b/c. DETECT on a downscaled copy, scale back up, fall back to frameCorners ──
    let corners: Quad = frameCorners(originalBitmap.width, originalBitmap.height);
    let needsReview = false;

    if (!deps.openCvDegraded) {
      try {
        const detectionBitmap = await createImageBitmap(originalBitmap, {
          resizeWidth: Math.min(DETECTION.DOWNSCALE_WIDTH, originalBitmap.width),
        });
        deps.tracker.detectionBitmap = detectionBitmap;
        checkCancelled();

        // Capture BEFORE transfer — `workerClient.detect` transfers
        // (detaches) the bitmap, after which `.width` would read 0 (the same
        // regression the old import pipeline fixed; see cddc9ae).
        const detectionWidth = detectionBitmap.width;

        let scaledCorners: Quad | null = null;
        try {
          // iOS fix: DETECT always goes through the main-thread ImageData path
          // now (it used to pick `detect(bitmap)` when the MAIN thread reported
          // `offscreenSupported`). `detect(bitmap)` drew the transferred
          // ImageBitmap onto the WORKER's OffscreenCanvas + `getImageData` — but
          // iOS/WebKit classic workers can't reliably back that (`getContext('2d')`
          // / drawImage on a worker OffscreenCanvas fails there even though
          // `OffscreenCanvas` exists on the main thread), so every DETECT threw
          // silently and every page was flagged "Revisar" on iPhone while desktop
          // worked. `detectImageData` extracts the (already downscaled) pixels on
          // the main thread and feeds `cv.matFromImageData` directly — no worker
          // canvas — so detection is identical and reliable across platforms.
          const result = await deps.workerClient.detectImageData(bitmapToImageData(detectionBitmap), false);
          if (result.corners) {
            const upscaled = orderCorners(
              scaleCornersToFullRes(result.corners, detectionWidth, originalBitmap.width),
            );
            scaledCorners = isConvex(upscaled) ? upscaled : null;
          }
        } finally {
          // `bitmapToImageData` already closed the detection bitmap internally
          // (it owns that one-shot extraction), so there is nothing to close
          // here — `close()` is idempotent anyway if the cancel tracker also ran.
          deps.tracker.detectionBitmap = null;
        }

        if (scaledCorners) {
          corners = scaledCorners;
        } else {
          needsReview = true;
        }
      } catch (error) {
        if (error instanceof BatchCancelledError) throw error;
        // DETECT_FAILED / OPENCV_LOAD_FAILED / etc: fall through with
        // frameCorners, same contract as a missing/non-convex detection.
        needsReview = true;
      }
    } else {
      needsReview = true;
    }

    checkCancelled();

    // ── d/e. Build the recipe (NEUTRAL filter, D-2) and WARP full-res ──
    let warpedBase: ImageBitmap;
    let paper = classifyPaperRatio(measuredQuadRatio(corners));

    if (!deps.openCvDegraded) {
      try {
        const imageData = extractImageData(originalBitmap);
        const response = await deps.workerClient.warp(
          { width: imageData.width, height: imageData.height, data: imageData.data },
          corners,
          resolveWarpGeometry(paper),
        );
        // Track immediately (before any cancellation check) so a cancel
        // that fires right as this resolves can never leak the freshly
        // returned bitmap.
        warpedBase =
          response.type === 'WARP_RESULT' ? response.bitmap : await paintImageDataLikeToBitmap(response.image);
        deps.tracker.warpedBase = warpedBase;
      } catch (error) {
        if (error instanceof BatchCancelledError) throw error;
        // Per-page WARP failure (mandatory fallback — never drop the page):
        // build an identity warp base instead, and force frameCorners since
        // no real warp ran against the previously-detected quad.
        corners = frameCorners(originalBitmap.width, originalBitmap.height);
        needsReview = true;
        paper = classifyPaperRatio(measuredQuadRatio(corners));
        warpedBase = await buildIdentityWarpedBase(originalBitmap);
        deps.tracker.warpedBase = warpedBase;
      }
    } else {
      warpedBase = await buildIdentityWarpedBase(originalBitmap);
      deps.tracker.warpedBase = warpedBase;
    }

    checkCancelled();

    const recipe = createInitialRecipe(corners, paper.id === 'legal' || paper.id === 'original' ? 'unknown' : paper.id, paper);

    // ── f. thumbnail + compress ──
    // Review fix: `Promise.all` would leak the RESOLVED side's bitmap
    // (`makeThumbnail`'s result is a live `ImageBitmap`) whenever the OTHER
    // promise rejected — `Promise.all` rejects as soon as either settles
    // rejected, discarding the fulfilled value with nobody left to close it.
    // `Promise.allSettled` lets both settle, so the fulfilled bitmap (if any)
    // can be closed explicitly before rethrowing.
    const [thumbnailSettled, warpedBlobSettled] = await Promise.allSettled([
      makeThumbnail(warpedBase, FILTER.THUMBNAIL_MAX_EDGE),
      compressBitmapToJpeg(warpedBase, FILTER.JPEG_QUALITY),
    ]);

    if (thumbnailSettled.status === 'rejected') {
      // `compressBitmapToJpeg`'s own settlement (fulfilled or rejected) needs
      // no cleanup either way — its result is a plain `Blob`, never a bitmap.
      throw thumbnailSettled.reason;
    }
    if (warpedBlobSettled.status === 'rejected') {
      // `thumbnailSettled` is narrowed to 'fulfilled' here (the branch above
      // already returned on 'rejected') — its resolved bitmap must not leak.
      thumbnailSettled.value.close();
      throw warpedBlobSettled.reason;
    }

    const thumbnail = thumbnailSettled.value;
    const warpedBlob = warpedBlobSettled.value;

    if (deps.isCancelled()) {
      // `thumbnail` was never tracked (only `originalBitmap`/`warpedBase`
      // are — see the finally below); release it explicitly here rather
      // than leaking it, then unwind without ever committing this page.
      thumbnail.close();
      throw new BatchCancelledError();
    }

    // ── g. addPage, then removeRawCapture (single close owner) ──
    const { addPage, removeRawCapture, pages } = useScannerStore.getState();
    addPage({
      id: raw.id,
      order: pages.length,
      recipe,
      thumbnail,
      originalBlob: raw.originalBlob,
      warpedBlob,
      originalWidth: raw.originalWidth,
      originalHeight: raw.originalHeight,
      warpedWidth: warpedBase.width,
      warpedHeight: warpedBase.height,
      needsReview,
    });
    removeRawCapture(raw.id);
    // `thumbnail` ownership has now transferred to the new page record —
    // must NOT be closed. `originalBitmap`/`warpedBase` are still tracked
    // and get closed uniformly by the `finally` below (step h).
  } finally {
    // ── h. finally: close originalBitmap + warpedBase (+ detect downscale
    // bitmap, already closed above) — whatever is still tracked here is
    // exactly what this page's run still owns, whether it succeeded
    // (originalBitmap/warpedBase, their job done once compressed) or threw
    // at any point (whatever got at least partially built).
    closeInFlight(deps.tracker);
  }
}

export function useBatchProcess({ ensureOpenCvInit, workerClient }: UseBatchProcessOptions): UseBatchProcessResult {
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);

  const ranRef = useRef(false);
  const processedIdsRef = useRef<Set<string>>(new Set());
  const cancelledRef = useRef(false);
  const trackerRef = useRef<InFlightTracker>({ originalBitmap: null, detectionBitmap: null, warpedBase: null });

  const cancel = useCallback((): void => {
    cancelledRef.current = true;
    closeInFlight(trackerRef.current);
    setProcessing(false);
    useScannerStore.getState().setPhase('capturing');
  }, []);

  // Cleanup on unmount: never leak whatever bitmap the in-flight page owns —
  // e.g. the screen unmounted for a reason other than the Cancel button.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      closeInFlight(trackerRef.current);
    };
  }, []);

  const run = useCallback(async (): Promise<RunBatchResult> => {
    // Review fix (StrictMode deadlock): reset the shared cancel flag on
    // EVERY invocation, BEFORE the run-once guard below. Under React 18
    // StrictMode's dev-only double-invoke, this hook's own unmount-cleanup
    // effect (below) sets `cancelledRef.current = true` on the SIMULATED
    // unmount between this effect's first call (still pending on an early
    // `await`, e.g. `ensureOpenCvInit()`) and its second, surviving call.
    // Since `ranRef.current` is already `true` by the second call, it
    // short-circuits right below — but if that short-circuiting call left the
    // SHARED `cancelledRef` at `true`, the FIRST call's `await` would resume,
    // see `cancelledRef.current === true`, and abort the whole batch —
    // stranding `phase` at `'processing'` forever. Resetting here means the
    // second (surviving) call always un-cancels the first call before
    // returning. The explicit Cancel button (`cancel()` below) is unaffected:
    // it does not call `run()` again, so this reset never fires on its behalf.
    cancelledRef.current = false;

    if (ranRef.current) {
      return { addedCount: 0, cancelled: false, total: 0 }; // Run-once guard: StrictMode double-invoke / re-entry never re-runs the batch.
    }
    ranRef.current = true;

    const sorted = [...useScannerStore.getState().rawCaptures].sort((a, b) => a.order - b.order);
    setTotal(sorted.length);
    setDone(0);
    setProcessing(true);

    // ── await ensureOpenCvInit() ONCE, up front; tolerate rejection → degraded path ──
    let openCvDegraded = false;
    try {
      await ensureOpenCvInit();
    } catch {
      openCvDegraded = true;
    }

    if (cancelledRef.current) {
      return { addedCount: 0, cancelled: true, total: sorted.length }; // cancel() already reset processing/phase while INIT was in flight.
    }

    let addedCount = 0;

    for (const raw of sorted) {
      if (cancelledRef.current) break;
      if (processedIdsRef.current.has(raw.id)) continue; // dedupe by raw.id (run-once guard)

      try {
        await processOneRawCapture(raw, {
          openCvDegraded,
          workerClient,
          tracker: trackerRef.current,
          isCancelled: () => cancelledRef.current,
        });
        if (cancelledRef.current) break;
        processedIdsRef.current.add(raw.id);
        addedCount += 1;
        setDone((d) => d + 1);
      } catch (error) {
        if (error instanceof BatchCancelledError || cancelledRef.current) {
          break; // Aborted mid-page — its bitmaps were already released by cancel()/unmount.
        }
        // A per-raw failure that survived even the internal degraded
        // fallback (e.g. the raw capture's own blob is corrupt/undecodable):
        // skip it and keep the batch going rather than aborting everything.
        processedIdsRef.current.add(raw.id);
        setDone((d) => d + 1);
      }
    }

    if (cancelledRef.current) {
      return { addedCount, cancelled: true, total: sorted.length };
    }

    // Defensive cleanup (mirrors any raw the loop above could not convert,
    // e.g. an undecodable blob) + route per outcome. On success the batch
    // lands on the per-page `'adjust'` review screen (filter strip + crop/
    // rotate/retake toolbar + "add more"); the grid is reached from there.
    useScannerStore.getState().clearRawCaptures();
    setProcessing(false);
    useScannerStore.getState().setPhase(addedCount > 0 ? 'adjust' : 'capturing');
    return { addedCount, cancelled: false, total: sorted.length };
  }, [ensureOpenCvInit, workerClient]);

  return { processing, done, total, run, cancel };
}
