/**
 * Scanner screen wiring `useCamera` + `CameraView` + `CameraSelector` +
 * `useDocumentDetection` + `DetectionOverlay` + `CaptureButton` +
 * `QualityHints` + `CornerEditor` + `ImportFallback` +
 * `OpenCvDegradedBanner` together (Group 3 / Slice C camera lifecycle +
 * Group 4 / Slice D live detection and auto-capture + Group 5 / Slice E
 * corner editor and warp + Group 6 / Slice F edge cases and fallbacks).
 *
 * Rewritten to the phase-driven, active-page/multipage model in Group 1c
 * (design section 5.1, ADR-010): `DocumentSlice.phase` is now the SOLE phase
 * owner (F1's legacy single-page capture state is gone). This screen renders:
 *  - `idle`/`capturing`/`tray` -> the live camera view + `CaptureTray`
 *    (design section 5.2, Group 5/PR8: thumbnail strip + page counter +
 *    "Listo").
 *  - `editing-corners` -> `CornerEditor`, in one of two modes: a FRESH
 *    capture (not yet a page — local `draftCapture` state below) or a
 *    RE-ENTERED page from the grid (`activatePage` already populated
 *    `activeWorking`/`activePageId`).
 *  - `grid` -> `PageGrid` (design section 5.3, Group 5/PR8), lazy-loaded so
 *    `@dnd-kit` stays out of the initial bundle: drag-reorder, tap-to-edit,
 *    delete, "Capture more"/"Finish".
 *  - `done` -> a finish summary.
 *
 * Capture sequence (design section 2.2): pause the detection loop, capture
 * the full-res frame, scale the last known detected corners from the
 * downscaled detection space to the full-res capture space, and hold the
 * immutable capture in LOCAL state (`draftCapture` — replaces F1's legacy
 * `originalFrame` store field; a fresh capture is NOT part of `pages[]`
 * until `CornerEditor`'s Confirm triggers `materializeCapture`). Once a
 * draft exists, this screen renders `CornerEditor` (Group 5). Backing out of
 * the editor without confirming resumes the live detection loop (this
 * screen owns that transition, per Slice E scope) — the camera NEVER closes
 * across this transition (scanner spec "Confirmar una pagina no cierra la
 * camara").
 *
 * Import fallback sequence (task 6.3.2; design ADR-006): the SAME
 * pipeline is reused for a desktop-without-camera or permission-denied
 * import. `handleImportedFile` decodes the file (`decodeImportedFile`),
 * runs ONE `workerClient.detect` call on a downscaled copy of the imported
 * bitmap to pre-populate corners (falling back to `null` -> full-frame
 * corners in `CornerEditor` exactly like the no-detection/non-convex camera
 * paths), holds the full-res bitmap in the SAME `draftCapture` local state,
 * and lets `CornerEditor` take over — no separate warp code path exists for
 * import.
 */

import type { ReactNode } from 'react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Flashlight, FlashlightOff } from 'lucide-react';
import { Button } from '@/shared/ui';
import { CameraSelector } from '@/features/scanner/components/CameraSelector';
import { CameraView } from '@/features/scanner/components/CameraView';
import { CaptureButton } from '@/features/scanner/components/CaptureButton';
import { CaptureTray } from '@/features/scanner/components/CaptureTray';
import { CornerEditor, type CornerEditorConfirmResult } from '@/features/scanner/components/CornerEditor';
import { DetectionOverlay } from '@/features/scanner/components/DetectionOverlay';
import { ImportFallback } from '@/features/scanner/components/ImportFallback';
import { OpenCvDegradedBanner } from '@/features/scanner/components/OpenCvDegradedBanner';
import { QualityHints } from '@/features/scanner/components/QualityHints';
import { useActivePage } from '@/features/scanner/hooks/useActivePage';
import { useCamera } from '@/features/scanner/hooks/useCamera';
import { useDocumentDetection } from '@/features/scanner/hooks/useDocumentDetection';
import { decodeImportedFile } from '@/features/scanner/lib/captureFallback';
import { captureFullResFrame } from '@/features/scanner/lib/captureFrame';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import { isTooFar, scaleCornersToFullRes } from '@/features/scanner/lib/detectionMath';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { isConvex, orderCorners } from '@/features/scanner/lib/geometry';
import { bitmapToImageData } from '@/features/scanner/lib/mainThreadImageData';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { Quad } from '@/shared/types/geometry';

/**
 * Group 5 / PR8: lazy-loaded feature boundary for the reorderable page grid
 * (design section 5.3, section 8 empirical item). `@dnd-kit` is only pulled
 * into a chunk once `phase === 'grid'` actually renders `<PageGrid>` —
 * keeping it OUT of the initial bundle (F1's <200KB gzip budget).
 */
const PageGrid = lazy(() => import('@/features/scanner/components/PageGrid'));

/**
 * Fallback detection-frame height used only before the camera has reported its
 * real negotiated resolution. `createImageBitmap(video, { resizeWidth: 640 })`
 * preserves the source aspect ratio, so the real height is derived per stream
 * from `realResolution` (Slice D review fix M2). This 4:3 fallback is a
 * reasonable default until that resolution is known and never stretches the
 * overlay because the overlay's viewBox uses the SAME height as the isTooFar
 * area denominator.
 */
const DETECTION_FRAME_FALLBACK_HEIGHT = Math.round((DETECTION.DOWNSCALE_WIDTH * 4) / 3);

/**
 * Bounds how long the import fallback waits for OpenCV to finish loading
 * before giving up on a DETECT pre-seed and opening the editor with
 * frame-completo corners instead (fix M5). A generous 15s covers a slow
 * first-time ~10MB WASM download on a real connection without leaving the
 * UI looking frozen indefinitely if OpenCV never becomes ready at all.
 */
const IMPORT_DETECT_TIMEOUT_MS = 15_000;

/**
 * A fresh, not-yet-confirmed capture (camera OR import). Replaces F1's
 * legacy `originalFrame` store field — held LOCALLY because it is not part of the
 * document (`pages[]`) until `CornerEditor`'s Confirm calls
 * `materializeCapture` (design section 2.2 "Materialize on capture").
 * `pageId` is generated up front so it can be reused as the new page's id.
 */
interface DraftCapture {
  readonly pageId: string;
  readonly source: ImageBitmap;
  readonly width: number;
  readonly height: number;
}

export function ScannerScreen(): ReactNode {
  const { openCamera, switchCamera, setTorch } = useCamera();

  const permission = useScannerStore((s) => s.permission);
  const torchSupported = useScannerStore((s) => s.torchSupported);
  const torchOn = useScannerStore((s) => s.torchOn);
  const devices = useScannerStore((s) => s.devices);
  const lastCameraError = useScannerStore((s) => s.lastCameraError);
  const imageCaptureSupported = useScannerStore((s) => s.imageCaptureSupported);
  const realResolution = useScannerStore((s) => s.realResolution);

  const corners = useScannerStore((s) => s.corners);
  const rawCorners = useScannerStore((s) => s.rawCorners);
  const quality = useScannerStore((s) => s.quality);
  const countdown = useScannerStore((s) => s.countdown);
  const autoCaptureEnabled = useScannerStore((s) => s.autoCaptureEnabled);
  const setAutoCaptureEnabled = useScannerStore((s) => s.setAutoCaptureEnabled);
  const noDetectionSince = useScannerStore((s) => s.noDetectionSince);
  const setPhase = useScannerStore((s) => s.setPhase);
  const phase = useScannerStore((s) => s.phase);
  const pages = useScannerStore((s) => s.pages);
  const resetDocument = useScannerStore((s) => s.resetDocument);
  const applyFilterToAll = useScannerStore((s) => s.applyFilterToAll);
  const reorderPages = useScannerStore((s) => s.reorderPages);
  // Group 5 / PR8: minimal wiring so the grid is functional. Group 6 / PR9
  // replaces this call site with `usePageDeletion` (5s undo toast) — see
  // design section 5.5.
  const deletePage = useScannerStore((s) => s.deletePage);
  const opencvStatus = useScannerStore((s) => s.opencv.status);
  const opencvLastError = useScannerStore((s) => s.opencv.lastError);

  // Group 2 / PR5 controller: Materialize-on-capture, Activate/Deactivate,
  // Re-warp (design section 2.2), plus the 30-page cap guard (design section
  // 2.3 / D-MEM).
  const { activeWorking, activePageId, isAtCap, canAddPage, materializeCapture, activatePage, deactivateActivePage, rewarpActivePage } =
    useActivePage();

  const [draftCapture, setDraftCapture] = useState<DraftCapture | null>(null);

  const [importError, setImportError] = useState<string | null>(null);
  // LOW-2: reflects that an import is being processed (decode + optional
  // OpenCV DETECT pre-seed) so the fallback UI can disable its picker and
  // announce progress. Cleared on both success and failure.
  const [importing, setImporting] = useState(false);

  /**
   * Corners handed off to the corner editor, scaled to the captured frame's
   * full-res space right when the capture happened (task 5.1.1; perspective
   * spec "Handles preseleccionados desde deteccion automatica"). Captured
   * into a ref at capture time (see runCaptureSequence below) rather than
   * recomputed from the CURRENT `rawCorners` here, since detection is
   * stopped during editing and `rawCorners` would otherwise be stale or, on
   * a second capture, referring to a different frame than the one being
   * edited.
   */
  const editorInitialCornersRef = useRef<Quad | null>(null);

  const [started, setStarted] = useState(false);
  const [showNoDetectionHint, setShowNoDetectionHint] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Held in a ref so the detection hook's `onAutoCapture` callback (below) is
  // stable and always calls the latest capture sequence without re-arming the
  // detection loop's memoized callbacks.
  const runCaptureSequenceRef = useRef<() => Promise<void>>();
  const handleAutoCapture = useCallback(() => {
    void runCaptureSequenceRef.current?.();
  }, []);

  const {
    start: startDetection,
    stop: stopDetection,
    workerClient,
    retryManualInit,
    ensureOpenCvInit,
  } = useDocumentDetection({
    onAutoCapture: handleAutoCapture,
  });

  useEffect(() => {
    if (!started) {
      return;
    }
    void openCamera();
    // Only re-run when `started` flips — openCamera is stable across
    // renders via useCallback, re-invoking it on every render would
    // needlessly reopen the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // Bug fix found while building the task 7.2 E2E fixture test: OpenCV was
  // ONLY ever initialized as a side effect of the live-detection loop
  // starting (`useDocumentDetection.start()`, which requires a granted
  // camera permission and a mounted <video>). When the import fallback is
  // reached WITHOUT the camera ever opening (permission denied, or no
  // camera at all — tasks 6.1/6.2), NOTHING ever called `ensureOpenCvInit()`,
  // so both the one-shot DETECT (task 6.3.2) and the editor's later WARP
  // call failed with NOT_INITIALIZED every single time. Kicking it off here
  // — as soon as the scanner screen is entered, regardless of camera outcome,
  // matching design section 4.2's own trigger condition ("al montar la ruta
  // del escaner... o al primer intento de abrir camara") — lets OpenCV load
  // in the BACKGROUND while the permission-denied/no-camera screen is
  // showing, so by the time the user has picked a file the worker is likely
  // already ready. `ensureOpenCvInit` shares the SAME status-mirroring +
  // bounded-backoff-retry machinery `useDocumentDetection.start()` uses
  // (task 6.6.1), so this call site gets identical degraded-mode behavior
  // instead of a parallel, untracked `init()` call.
  useEffect(() => {
    if (!started) {
      return;
    }
    ensureOpenCvInit().catch(() => {
      // Load failure (even after exhausted retries) is already surfaced
      // reactively via `OpenCvSlice.status === 'error'` (task 6.6.1's
      // degraded-mode banner) — nothing further to do with the rejection
      // here.
    });
  }, [started, ensureOpenCvInit]);

  // Task 4.1.3: start the detection loop once the video element exists and
  // the camera has granted access. useDocumentDetection.start() is
  // idempotent while already running, so this can safely re-run whenever
  // its dependencies change without double-starting the loop.
  //
  // Slice E addition, extended in Group 1c: the loop must stay stopped while
  // `phase` is 'editing-corners' or 'capturing' — the corner editor owns
  // resuming it (via handleEditorCancel/materialize/deactivate below) once
  // the user is done with this page, so DETECT never races the editor's own
  // warp calls over the same worker. `tray`/`grid`/`done`/`idle` all resume
  // it automatically whenever the camera <video> is mounted (continuous
  // capture keeps the camera open — scanner spec "Confirmar una pagina no
  // cierra la camara"); when it is not mounted (e.g. `grid`, which renders
  // no `CameraView`), `videoRef.current` is null and this is a no-op.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || permission !== 'granted' || phase === 'editing-corners' || phase === 'capturing') {
      return;
    }
    startDetection(video);
    return () => {
      stopDetection();
    };
  }, [permission, phase, startDetection, stopDetection]);

  // Task 4.6.1: track how long detection has been failing and surface the
  // "capture anyway" hint once NO_DETECTION_MS elapses.
  useEffect(() => {
    if (noDetectionSince === null) {
      setShowNoDetectionHint(false);
      return;
    }
    const elapsed = Date.now() - noDetectionSince;
    if (elapsed >= DETECTION.NO_DETECTION_MS) {
      setShowNoDetectionHint(true);
      return;
    }
    const timer = setTimeout(() => setShowNoDetectionHint(true), DETECTION.NO_DETECTION_MS - elapsed);
    return () => clearTimeout(timer);
  }, [noDetectionSince]);

  const runCaptureSequence = useCallback(async () => {
    const video = videoRef.current;
    const stream = useScannerStore.getState().stream;
    const track = stream?.getVideoTracks()[0];
    if (!video || !track) {
      return;
    }

    // Slice D review fix H1: reentrancy guard. Auto-capture (countdown -> 0)
    // and a manual FAB tap can fire almost simultaneously; without this guard
    // both would run captureFullResFrame and the second full-res ImageBitmap
    // would overwrite the first. Already being in 'capturing' means a sequence
    // owns the frame — bail out.
    if (useScannerStore.getState().phase === 'capturing') {
      return;
    }

    // Design section 2.3 / D-MEM: hard cap at FILTER.PAGE_CAP pages. The tray
    // placeholder disables the capture button at the cap (see `canAddPage`
    // below), but guard here too in case a caller (auto-capture) races it.
    if (useScannerStore.getState().pages.length >= FILTER.PAGE_CAP) {
      return;
    }

    // Design section 2.2: pause the loop before capturing so DETECT and the
    // full-res capture never race over the same video frame / worker.
    stopDetection();
    setPhase('capturing');

    try {
      const captured = await captureFullResFrame(video, track, imageCaptureSupported);
      const lastRawCorners = useScannerStore.getState().rawCorners;

      // Fix M1: order the scaled corners defensively before handing them to
      // the editor. Today the worker's DETECT already emits ordered corners, so
      // this is normally a no-op — but that ordering is an undocumented
      // upstream assumption. Re-ordering here makes the editor's [TL,TR,BR,BL]
      // seed invariant hold regardless of the detection source (e.g. a future
      // import path that pre-seeds corners without running DETECT).
      const scaledCorners =
        lastRawCorners != null
          ? orderCorners(scaleCornersToFullRes(lastRawCorners, DETECTION.DOWNSCALE_WIDTH, captured.width))
          : null;

      // Task 5.1.1 / scanner spec "Contorno... no convexo...": only hand a
      // scaled detection off to the editor as a pre-seed when it is actually
      // a valid convex quad. A non-convex or missing detection means the
      // editor falls back to distributing handles across the full frame
      // (CornerEditor.frameCorners) instead of pre-seeding invalid corners.
      editorInitialCornersRef.current =
        scaledCorners != null && isConvex(scaledCorners) ? scaledCorners : null;

      setDraftCapture({
        pageId: crypto.randomUUID(),
        source: captured.bitmap,
        width: captured.width,
        height: captured.height,
      });
      setPhase('editing-corners');

      // On success the draft is handed off; CornerEditor renders now that
      // `phase` is 'editing-corners'. Backing out of or confirming the
      // editor resumes the loop — see handleEditorCancel / handleDraftConfirm
      // below.
    } catch {
      // Slice D review fix M4: if capture throws (e.g. ImageCapture failure),
      // never leave the scanner frozen in 'capturing'. Restore a usable phase
      // and resume the live detection loop so the user can retry. `tray` keeps
      // the camera+tray view (identical rendering to `idle` here); it is the
      // more accurate phase once at least one page may already exist.
      setPhase('tray');
      if (videoRef.current) {
        startDetection(videoRef.current);
      }
    }
  }, [imageCaptureSupported, setPhase, startDetection, stopDetection]);

  // Keep the ref pointing at the latest capture sequence so the detection
  // hook's stable `onAutoCapture` callback always invokes the current one.
  runCaptureSequenceRef.current = runCaptureSequence;

  /**
   * Import fallback pipeline (task 6.3.2; design ADR-006): decode the
   * user-selected file, run ONE `DETECT` against a downscaled copy to
   * pre-populate corners (same contract as the camera loop: non-convex or
   * missing detection means `editorInitialCornersRef` stays null and
   * `CornerEditor` falls back to `frameCorners`), hold the full-res bitmap
   * in the SAME `draftCapture` local state as the camera path, and let
   * `CornerEditor` take over. Reuses the SAME `workerClient`/`CornerEditor`
   * path the camera capture sequence uses — no parallel warp logic.
   *
   * IMPORTANT (bug found and fixed while building the task 7.2 E2E fixture
   * test): when the import fallback is reached WITHOUT the camera ever
   * opening (permission denied, or no camera at all), `useDocumentDetection`'s
   * `start()` — previously the ONLY caller of OpenCV `INIT` — never runs, so
   * OpenCV was never even asked to load, and BOTH the one-shot DETECT below
   * and the editor's later `WARP` call failed with `NOT_INITIALIZED` every
   * single time. Fixed by having ScannerScreen's own `ensureOpenCvInit`
   * effect (above) kick off the load as soon as the scanner screen mounts,
   * regardless of camera outcome; `await ensureOpenCvInit()` here is a
   * defensive re-await of that SAME idempotent promise in case the user
   * picks a file before the background load finished.
   */
  const handleImportedFile = useCallback(
    async (file: File) => {
      // Design section 2.3 / D-MEM: same hard cap as the camera path.
      if (useScannerStore.getState().pages.length >= FILTER.PAGE_CAP) {
        setImportError(`Document limit reached (${FILTER.PAGE_CAP} pages).`);
        return;
      }

      setImportError(null);
      setImporting(true); // LOW-2: mark processing before any async work runs.
      try {
        const captured = await decodeImportedFile(file);

        // Ensure OpenCV is loading/loaded BEFORE attempting DETECT — see the
        // bug note above. Bounded with a timeout race (fix M5): `ensureOpenCvInit`
        // can legitimately take a long time (first-ever ~10MB WASM download).
        // `ensureOpenCvInit` itself no longer hangs indefinitely — HIGH-2 gave
        // its underlying `INIT` attempt a hard `INIT_TIMEOUT_MS` ceiling that
        // rejects with OPENCV_LOAD_FAILED on a hung worker — so this race is no
        // longer the ONLY thing standing between the import and a frozen screen.
        // It is kept purely as a tighter, import-specific bound (feedback sooner
        // than the full init ceiling) that also falls through to the
        // frame-completo editor. HIGH-1: the timer handle is captured and
        // ALWAYS cleared in `finally`, so a race won by `ensureOpenCvInit()`
        // never leaves a live timer whose eventual rejection becomes an
        // unhandled promise rejection.
        let scaledCorners: Quad | null = null;
        let importTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            ensureOpenCvInit(),
            new Promise((_resolve, reject) => {
              importTimeoutHandle = setTimeout(
                () => reject(new Error('OpenCV init timed out')),
                IMPORT_DETECT_TIMEOUT_MS,
              );
            }),
          ]);

          // One-shot DETECT on a downscaled copy (mirrors the live loop's
          // `createImageBitmap(video, { resizeWidth })`, but against the
          // imported bitmap instead of a <video> frame).
          const detectionBitmap = await createImageBitmap(captured.bitmap, {
            resizeWidth: Math.min(DETECTION.DOWNSCALE_WIDTH, captured.width),
          });
          // Capture the detection width NOW: `workerClient.detect` transfers
          // (detaches) the bitmap to the worker, after which `detectionBitmap.width`
          // reads 0 — which fed `scaleCornersToFullRes` a 0 and made it throw, so a
          // perfectly good detection was swallowed and the editor fell back to
          // frame-complete corners.
          const detectionWidth = detectionBitmap.width;
          // Task 6.7.1: same offscreenSupported gating as the live loop —
          // extract ImageData on the main thread and use detectImageData
          // when the worker cannot rely on its own OffscreenCanvas.
          const offscreenSupported = useScannerStore.getState().offscreenSupported;
          try {
            const result = offscreenSupported
              ? await workerClient.detect(detectionBitmap, false)
              : await workerClient.detectImageData(bitmapToImageData(detectionBitmap), false);
            if (result.corners) {
              const upscaled = orderCorners(
                scaleCornersToFullRes(result.corners, detectionWidth, captured.width),
              );
              scaledCorners = isConvex(upscaled) ? upscaled : null;
            }
          } finally {
            // MEDIUM-1: on the OffscreenCanvas path the worker only closes the
            // transferred bitmap on the HAPPY path, so a rejecting `detect()`
            // would leak `detectionBitmap` in the main thread. Close it here.
            // On the detectImageData path `bitmapToImageData` ALREADY consumed
            // and closed the bitmap, so closing again must be avoided (double
            // close) — only close when we took the OffscreenCanvas branch.
            if (offscreenSupported) {
              detectionBitmap.close();
            }
          }
        } catch {
          // OPENCV_LOAD_FAILED (degraded mode, task 6.6.1 / HIGH-2 hung init),
          // a timed-out init, or DETECT_FAILED: fall through with no pre-seed,
          // same as a non-convex/missing camera detection (task 6.5.1 parity).
          // The editor's own WARP call will fail too in true degraded mode,
          // surfaced via `warp-error` — this is the documented degraded-mode
          // limit.
        } finally {
          // HIGH-1: always clear the race timer. If `ensureOpenCvInit()` won
          // the race, the timer is still armed; left uncleared its later
          // rejection has no `.catch` and becomes an unhandled rejection.
          if (importTimeoutHandle !== null) {
            clearTimeout(importTimeoutHandle);
          }
        }

        editorInitialCornersRef.current = scaledCorners;
        setDraftCapture({
          pageId: crypto.randomUUID(),
          source: captured.bitmap,
          width: captured.width,
          height: captured.height,
        });
        setPhase('editing-corners');
      } catch (error) {
        setImportError(error instanceof Error ? error.message : 'Could not read the selected image.');
      } finally {
        setImporting(false); // LOW-2: clear processing on success OR failure.
      }
    },
    [ensureOpenCvInit, setPhase, workerClient],
  );

  const handleStart = useCallback(() => {
    setStarted(true);
  }, []);

  const handleToggleTorch = useCallback(() => {
    void setTorch(!torchOn);
  }, [setTorch, torchOn]);

  const handleManualCapture = useCallback(() => {
    void runCaptureSequence();
  }, [runCaptureSequence]);

  const handleToggleAutoCapture = useCallback(() => {
    setAutoCaptureEnabled(!autoCaptureEnabled);
  }, [autoCaptureEnabled, setAutoCaptureEnabled]);

  const handleCaptureAnyway = useCallback(() => {
    void runCaptureSequence();
  }, [runCaptureSequence]);

  /**
   * Discards the current FRESH-CAPTURE draft (never touches `DocumentSlice`
   * — the draft never became a page) and resumes the live detection loop
   * (Slice E owns this transition). Releases the draft's live bitmap itself
   * (design section 7 memory hygiene) since nothing else retains it.
   */
  const handleEditorCancel = useCallback(() => {
    setDraftCapture((current) => {
      current?.source.close();
      return null;
    });
    setPhase('tray');
    editorInitialCornersRef.current = null;
    if (videoRef.current) {
      startDetection(videoRef.current);
    }
  }, [setPhase, startDetection]);

  /**
   * Confirms a FRESH capture: hands the warped result off to
   * `materializeCapture` (design section 2.2 "Materialize on capture" —
   * compress+thumbnail, `addPage`, close the live bitmaps) and returns to the
   * camera immediately. Compression runs in the background; the camera never
   * closes and detection resumes via the phase-driven effect above (scanner
   * spec "Confirmar una pagina no cierra la camara").
   */
  const handleDraftConfirm = useCallback(
    (result: CornerEditorConfirmResult) => {
      const draft = draftCapture;
      if (!draft) return;
      setDraftCapture(null);
      editorInitialCornersRef.current = null;
      setPhase('tray');
      void materializeCapture({
        pageId: draft.pageId,
        recipe: result.recipe,
        originalBitmap: draft.source,
        warpedBase: result.warpedBase,
        originalWidth: draft.width,
        originalHeight: draft.height,
        warpedWidth: result.warpedBase.width,
        warpedHeight: result.warpedBase.height,
      });
    },
    [draftCapture, materializeCapture, setPhase],
  );

  /**
   * Re-entry (grid tap -> activatePage -> 'editing-corners') Confirm: writes
   * the fresh warp + recipe into the active page (design section 2.2
   * "Re-warp (active)") then deactivates (recompresses since now dirty,
   * closes the full-res bitmaps) and returns to the grid.
   */
  const handleActivePageConfirm = useCallback(
    (result: CornerEditorConfirmResult) => {
      if (!activePageId) return;
      rewarpActivePage({ pageId: activePageId, freshWarpedBase: result.warpedBase, recipe: result.recipe });
      setPhase('grid');
      void deactivateActivePage();
    },
    [activePageId, rewarpActivePage, deactivateActivePage, setPhase],
  );

  /**
   * Re-entry Cancel: no store write ever happened during interactive editing
   * (CornerEditor keeps LOCAL state until Confirm), so simply deactivating
   * discards this session's edits (`activeDirty` is still false) and returns
   * to the grid.
   */
  const handleActivePageCancel = useCallback(() => {
    setPhase('grid');
    void deactivateActivePage();
  }, [deactivateActivePage, setPhase]);

  /** Grid tile tap -> activatePage -> open the corner editor for that page (design section 5.3). */
  const handleActivatePageTap = useCallback(
    (pageId: string) => {
      void activatePage(pageId).then(() => setPhase('editing-corners'));
    },
    [activatePage, setPhase],
  );

  const handleTrayDone = useCallback(() => {
    setPhase('grid');
  }, [setPhase]);

  const handleGridCaptureMore = useCallback(() => {
    setPhase('tray');
  }, [setPhase]);

  const handleGridFinish = useCallback(() => {
    setPhase('done');
  }, [setPhase]);

  const handleScanAgain = useCallback(() => {
    resetDocument();
    setPhase('idle');
    if (videoRef.current) {
      startDetection(videoRef.current);
    }
  }, [resetDocument, setPhase, startDetection]);

  if (!started) {
    return (
      <Button variant="primary" type="button" onClick={handleStart} data-testid="open-scanner">
        Open scanner
      </Button>
    );
  }

  // Task 6.1.1 (permission denied) and task 6.2.1 (no camera on desktop):
  // both render the SAME `ImportFallback`, which shares the pipeline with
  // the camera path (ADR-006) via `handleImportedFile`. `phase` still gates
  // the corner-editor branch below, so once a file is imported the screen
  // falls straight through to `CornerEditor` exactly like a camera capture.
  if (permission === 'denied' && !(phase === 'editing-corners' || phase === 'capturing' || phase === 'done')) {
    return (
      <ImportFallback reason="permission-denied" onFileSelected={(file) => void handleImportedFile(file)} errorMessage={importError} busy={importing} />
    );
  }

  // Task 6.2.1: no videoinput device at all (desktop without a camera) — do
  // NOT show a camera-open error; go straight to the import fallback. This
  // check must come before `lastCameraError` because a `NotFoundError`
  // clears `devices` (see useCamera.ts) without necessarily setting
  // `lastCameraError`, and even if some other camera error is ALSO present,
  // having zero devices is the more specific, more actionable condition.
  if (
    devices.length === 0 &&
    permission !== 'granted' &&
    !(phase === 'editing-corners' || phase === 'capturing' || phase === 'done')
  ) {
    return (
      <ImportFallback reason="no-camera" onFileSelected={(file) => void handleImportedFile(file)} errorMessage={importError} busy={importing} />
    );
  }

  if (lastCameraError != null && !(phase === 'editing-corners' || phase === 'capturing' || phase === 'done')) {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <p role="alert" className="text-sm text-danger" data-testid="camera-error">
          Could not open the camera. Try again, or import an image instead.
        </p>
        <ImportFallback reason="no-camera" onFileSelected={(file) => void handleImportedFile(file)} errorMessage={importError} busy={importing} />
      </div>
    );
  }

  // Group 5 / Slice E, rewired Group 1c: a FRESH, not-yet-confirmed capture
  // (camera or import) hands off to the corner editor instead of the live
  // camera view. 'capturing' also renders this branch (briefly, while
  // captureFullResFrame resolves) so the screen never flashes back to a
  // stale camera view mid-capture; at that instant `draftCapture` is still
  // null, so it falls through to the camera-view branch below instead.
  if ((phase === 'editing-corners' || phase === 'capturing') && draftCapture) {
    return (
      <CornerEditor
        // Fix M3: key the editor by the draft's page id so a second capture
        // REMOUNTS it with fresh `corners`/`aspectOverride` state. Without a
        // key, the useState seeds only apply on first mount and the next
        // capture would inherit the previous draft's dragged corners / aspect
        // override.
        key={draftCapture.pageId}
        pageId={draftCapture.pageId}
        originalBitmap={draftCapture.source}
        width={draftCapture.width}
        height={draftCapture.height}
        initialCorners={editorInitialCornersRef.current}
        initialRecipe={null}
        onConfirm={handleDraftConfirm}
        onCancel={handleEditorCancel}
        onApplyToAll={pages.length > 0 ? applyFilterToAll : undefined}
      />
    );
  }

  // Re-entry: a page tapped in the grid was already activated (activeWorking
  // populated by `activatePage`) before `phase` flipped to 'editing-corners'
  // (design section 5.3/5.4).
  if (phase === 'editing-corners' && activeWorking && activePageId) {
    const activePage = pages.find((page) => page.id === activePageId);
    if (activePage) {
      return (
        <CornerEditor
          key={activePageId}
          pageId={activePageId}
          originalBitmap={activeWorking.originalBitmap}
          width={activeWorking.originalBitmap.width}
          height={activeWorking.originalBitmap.height}
          initialCorners={null}
          initialRecipe={activePage.recipe}
          onConfirm={handleActivePageConfirm}
          onCancel={handleActivePageCancel}
          onApplyToAll={pages.length > 1 ? applyFilterToAll : undefined}
        />
      );
    }
  }

  // Group 5 / PR8: real reorderable `PageGrid` (design section 5.3),
  // lazy-loaded so `@dnd-kit` stays out of the initial bundle. Replaces the
  // inline `page-grid-placeholder` a prior PR shipped for end-to-end
  // runnability.
  if (phase === 'grid') {
    return (
      <Suspense fallback={<p data-testid="page-grid-loading">Loading…</p>}>
        <PageGrid
          pages={pages}
          onActivatePage={handleActivatePageTap}
          onDeletePage={deletePage}
          onReorder={reorderPages}
          onCaptureMore={handleGridCaptureMore}
          onFinish={handleGridFinish}
        />
      </Suspense>
    );
  }

  if (phase === 'done') {
    return (
      <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="scan-done">
        <p className="text-sm text-text-muted">
          Scan complete — {pages.length} page{pages.length === 1 ? '' : 's'}.
        </p>
        <Button type="button" variant="primary" onClick={handleScanAgain} data-testid="scan-again">
          Scan another document
        </Button>
      </div>
    );
  }

  // Slice D review fix M2: derive the real detection-frame height from the
  // camera's negotiated aspect ratio. createImageBitmap(video, { resizeWidth })
  // preserves aspect, so a 16:9 stream yields a 640x360 detection frame, not
  // 640x853. Using the real height both stops the overlay from stretching the
  // contour and makes isTooFar's area denominator correct.
  const frameWidth = DETECTION.DOWNSCALE_WIDTH;
  const frameHeight =
    realResolution != null && realResolution.width > 0
      ? Math.round((DETECTION.DOWNSCALE_WIDTH * realResolution.height) / realResolution.width)
      : DETECTION_FRAME_FALLBACK_HEIGHT;
  const tooFar = rawCorners != null && isTooFar(rawCorners, frameWidth, frameHeight);

  // Task 6.6.1: OpenCV failed to load (backoff exhausted or still mid-retry
  // in the 'error' state). Degraded mode still shows the live camera view —
  // capture is manual-only (no overlay/auto-capture/quality hints, all of
  // which need OpenCV) — and the banner communicates why + offers a manual
  // retry. `CornerEditor`'s warp call succeeds transparently once OpenCV
  // recovers (design section 4.4 rationale documented on the banner
  // component itself).
  const openCvDegraded = opencvStatus === 'error';

  // `idle`/`capturing` (transient, no draft yet)/`tray` all render the SAME
  // continuous camera view (design section 5.1: "capturing/tray -> camera +
  // tray"). The tray strip PLACEHOLDER (Group 5/PR8 owns the real
  // `CaptureTray`) only makes sense once at least one page exists.
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4">
      {openCvDegraded && <OpenCvDegradedBanner lastError={opencvLastError} onRetry={retryManualInit} />}

      <CameraView
        ref={videoRef}
        overlay={
          !openCvDegraded && <DetectionOverlay corners={corners} frameWidth={frameWidth} frameHeight={frameHeight} />
        }
      />

      {!openCvDegraded && <QualityHints quality={quality} tooFar={tooFar} />}

      {!openCvDegraded && showNoDetectionHint && (
        <div className="flex flex-col items-center gap-2 text-center" data-testid="no-detection-hint">
          <p className="text-sm text-text-muted">No document detected yet.</p>
          <Button variant="secondary" type="button" onClick={handleCaptureAnyway} data-testid="capture-anyway">
            Capture anyway
          </Button>
        </div>
      )}

      <div className="flex w-full items-center justify-between gap-3">
        <CameraSelector onSelect={(deviceId) => void switchCamera(deviceId)} />
        <div className="flex items-center gap-2">
          {!openCvDegraded && (
            <Button
              variant="secondary"
              type="button"
              onClick={handleToggleAutoCapture}
              aria-pressed={autoCaptureEnabled}
              data-testid="auto-capture-toggle"
            >
              {autoCaptureEnabled ? 'Auto on' : 'Auto off'}
            </Button>
          )}
          {torchSupported && (
            <Button
              variant="secondary"
              type="button"
              onClick={handleToggleTorch}
              aria-pressed={torchOn}
              data-testid="torch-toggle"
            >
              {torchOn ? (
                <Flashlight size={18} strokeWidth={1.5} aria-hidden="true" />
              ) : (
                <FlashlightOff size={18} strokeWidth={1.5} aria-hidden="true" />
              )}
              <span className="sr-only">Toggle torch</span>
            </Button>
          )}
        </div>
      </div>

      <CaptureTray pages={pages} isAtCap={isAtCap} onDone={handleTrayDone} />

      <CaptureButton onCapture={handleManualCapture} countdown={countdown} disabled={!canAddPage} />
    </div>
  );
}
