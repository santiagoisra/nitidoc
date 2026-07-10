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
 *  - `idle`/`capturing` -> the full-bleed `CaptureScreen` (Fase 2.3,
 *    capture-ux-redesign.md, Unit 3): persistent camera, manual raw
 *    captures accumulate in `DocumentSlice.rawCaptures`, no per-frame
 *    DETECT. `CaptureScreen` owns its own permission/no-camera fallback
 *    internally (the "phase-gating decouple") — see that component's doc
 *    comment.
 *  - `processing` -> `ProcessingScreen` (Fase 2.3, Unit 4): sequential
 *    per-raw-capture detect->warp->thumbnail batch, degraded-fallback-safe,
 *    determinate progress + Cancel. Replaces Unit 3's temporary
 *    `common.processing` text placeholder.
 *  - `editing-corners` -> `CornerEditor`, in one of two modes: a FRESH
 *    capture (not yet a page — local `draftCapture` state below) or a
 *    RE-ENTERED page from the grid (`activatePage` already populated
 *    `activeWorking`/`activePageId`). The FRESH-capture mode is now DEAD
 *    CODE (Fase 2.3, Unit 3): nothing sets `draftCapture` anymore since the
 *    new `CaptureScreen` flow never leaves `'capturing'` on a successful
 *    manual capture — kept present per the Unit 3 brief ("keep the old
 *    draft-capture editor code present if removing it would break the
 *    build") until Unit 6 removes it alongside the rest of the live-
 *    detection path. The RE-ENTRY mode stays fully live/used.
 *  - `grid` -> `PageGrid` (design section 5.3, Group 5/PR8), lazy-loaded so
 *    `@dnd-kit` stays out of the initial bundle: drag-reorder, tap-to-edit,
 *    delete, "Capture more"/"Finish".
 *  - `done` -> a finish summary.
 *
 * The trailing fallback branch at the bottom of this component (the OLD
 * live camera + `CaptureTray` + auto-capture/quality-hints view, and its
 * supporting `runCaptureSequence`/`handleManualCapture`/etc. handlers) is
 * likewise DEAD CODE post-Unit-3: `DocumentPhase` is a closed union and
 * every one of its values is now handled by an earlier branch, so this view
 * can no longer actually be reached at runtime. It stays present (same
 * "don't break the build by half-deleting" reasoning as the draft-capture
 * editor above) — full removal is Unit 6.
 *
 * Import fallback (Fase 2.3, Unit 3): the OLD `handleImportedFile`
 * DETECT-then-`CornerEditor` pipeline (task 6.3.2 / ADR-006) has been
 * REMOVED (not kept dead) — `CaptureScreen`'s own no-camera variant now owns
 * import entirely via the lighter `materializeRawCapture` pipeline (decode
 * -> raw capture, no DETECT, no per-image editor; that analysis is deferred
 * to Unit 4's batch `'processing'` step). Removing it here (rather than
 * keeping it dead) was necessary: its only callers were the 3 permission/
 * no-camera/camera-error early-return branches this same Unit 3 pass
 * deletes as part of the "phase-gating decouple" — keeping the handler
 * without any caller would itself be an unused-local build break.
 */

import type { ReactNode } from 'react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Flashlight, FlashlightOff } from 'lucide-react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { CameraSelector } from '@/features/scanner/components/CameraSelector';
import { CameraView } from '@/features/scanner/components/CameraView';
import { CaptureButton } from '@/features/scanner/components/CaptureButton';
import { CaptureScreen } from '@/features/scanner/components/CaptureScreen';
import { CaptureTray } from '@/features/scanner/components/CaptureTray';
import { CornerEditor, type CornerEditorConfirmResult } from '@/features/scanner/components/CornerEditor';
import { DetectionOverlay } from '@/features/scanner/components/DetectionOverlay';
import { OpenCvDegradedBanner } from '@/features/scanner/components/OpenCvDegradedBanner';
import { PageThumbnail } from '@/features/scanner/components/PageThumbnail';
import { ProcessingScreen } from '@/features/scanner/components/ProcessingScreen';
import { QualityHints } from '@/features/scanner/components/QualityHints';
import { useActivePage } from '@/features/scanner/hooks/useActivePage';
import { useExportPdf } from '@/features/scanner/hooks/useExportPdf';
import { usePageDeletion } from '@/features/scanner/hooks/usePageDeletion';
import { useCamera } from '@/features/scanner/hooks/useCamera';
import { useDocumentDetection } from '@/features/scanner/hooks/useDocumentDetection';
import { captureFullResFrame } from '@/features/scanner/lib/captureFrame';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import { isTooFar, scaleCornersToFullRes } from '@/features/scanner/lib/detectionMath';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { isConvex, orderCorners } from '@/features/scanner/lib/geometry';
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
  const { t } = useTranslation();
  const { openCamera, switchCamera, setTorch } = useCamera();

  const permission = useScannerStore((s) => s.permission);
  const torchSupported = useScannerStore((s) => s.torchSupported);
  const torchOn = useScannerStore((s) => s.torchOn);
  const imageCaptureSupported = useScannerStore((s) => s.imageCaptureSupported);
  const realResolution = useScannerStore((s) => s.realResolution);

  const corners = useScannerStore((s) => s.corners);
  const rawCorners = useScannerStore((s) => s.rawCorners);
  const quality = useScannerStore((s) => s.quality);
  const stability = useScannerStore((s) => s.stability);
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
  // Group 6 / PR9: deletion + 5s undo toast (design section 5.5). Replaces
  // Group 5/PR8's minimal direct `DocumentSlice.deletePage` wiring.
  const { deletePage } = usePageDeletion();
  const { exporting, exportPdf } = useExportPdf();
  const opencvStatus = useScannerStore((s) => s.opencv.status);
  const opencvLastError = useScannerStore((s) => s.opencv.lastError);

  // Group 2 / PR5 controller: Materialize-on-capture, Activate/Deactivate,
  // Re-warp (design section 2.2), plus the 30-page cap guard (design section
  // 2.3 / D-MEM).
  const { activeWorking, activePageId, isAtCap, canAddPage, materializeCapture, activatePage, deactivateActivePage, rewarpActivePage } =
    useActivePage();

  const [draftCapture, setDraftCapture] = useState<DraftCapture | null>(null);

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

  // Fase 2.3 (capture-ux-redesign.md, Unit 3): camera-opening ownership
  // moved to `CaptureScreen`'s own mount effect ("Re-arm camera on entry to
  // 'capturing'") — it fires as soon as that screen mounts (i.e. as soon as
  // `started && phase` is `'idle'`/`'capturing'`), covering both the very
  // first "Open scanner" tap AND every later re-entry (grid "Capturar más" /
  // done "Escanear otro"), which this screen's own former `started`-only
  // effect never did. `openCamera` is passed down as a PROP (the SAME
  // `useCamera()` hook instance below) rather than calling `useCamera()`
  // again inside `CaptureScreen` — that hook's `streamRef`/generation-token
  // guard is per-hook-instance, so a second instance would race this one
  // over the same `MediaStream` with an unsynchronized supersession counter.

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
  // warp calls over the same worker. `idle`/`grid`/`done` all resume it
  // automatically whenever the camera <video> is mounted (continuous capture
  // keeps the camera open — scanner spec "Confirmar una pagina no cierra la
  // camara"); when it is not mounted (e.g. `grid`, which renders no
  // `CameraView`), `videoRef.current` is null and this is a no-op.
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
      // and resume the live detection loop so the user can retry. Fase 2.3
      // (capture-ux-redesign.md) drops the dedicated `'tray'` phase — `'idle'`
      // renders the identical camera+tray fallthrough view below, unchanged
      // pending Unit 3's capture-screen rewrite.
      setPhase('idle');
      if (videoRef.current) {
        startDetection(videoRef.current);
      }
    }
  }, [imageCaptureSupported, setPhase, startDetection, stopDetection]);

  // Keep the ref pointing at the latest capture sequence so the detection
  // hook's stable `onAutoCapture` callback always invokes the current one.
  runCaptureSequenceRef.current = runCaptureSequence;

  // Fase 2.3 (capture-ux-redesign.md, Unit 3): the OLD import-fallback
  // pipeline that lived here (decode -> one-shot DETECT -> `CornerEditor`,
  // task 6.3.2 / ADR-006) has been REMOVED — see this file's top doc comment
  // for why it was removed rather than kept dead. `CaptureScreen`'s own
  // no-camera variant now owns import entirely via `materializeRawCapture`.

  const handleStart = useCallback(() => {
    setStarted(true);
    // Transitions: start -> 'capturing' (design "Phase model"). Doing this
    // alongside `setStarted` (rather than in a separate effect) means
    // `CaptureScreen` mounts with the right phase on its very first render —
    // no intermediate frame where `phase` is still the initial `'idle'`.
    setPhase('capturing');
  }, [setPhase]);

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
    setPhase('idle');
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
      setPhase('idle');
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
    // Design "Phase model": grid "Capturar más" -> 'capturing'.
    // `CaptureScreen`'s own mount effect re-arms the camera on this
    // transition (design "Re-arm camera on entry to 'capturing'").
    setPhase('capturing');
  }, [setPhase]);

  const handleGridFinish = useCallback(() => {
    setPhase('done');
  }, [setPhase]);

  const handleExportPdf = useCallback(() => {
    exportPdf(pages);
  }, [exportPdf, pages]);

  const handleScanAgain = useCallback(() => {
    resetDocument();
    // Design "Phase model": done "Escanear otro" -> resetDocument -> 'capturing'.
    // `CaptureScreen` re-arms the camera itself on mount; no need to touch
    // the (now-dead) live-detection loop here.
    setPhase('capturing');
  }, [resetDocument, setPhase]);

  if (!started) {
    return (
      <Button variant="primary" type="button" onClick={handleStart} data-testid="open-scanner">
        {t('scanner.openScanner')}
      </Button>
    );
  }

  // Fase 2.3 (capture-ux-redesign.md, Unit 3), "Phase-gating decouple
  // (critical)": `idle`/`capturing` both route to the full-bleed
  // `CaptureScreen`, which owns its own permission/no-camera/camera-error
  // fallback internally (`cameraUsable`) instead of ScannerScreen
  // early-returning before this point — replaces the 3 former
  // permission-denied/no-camera/lastCameraError early-return blocks that
  // used to live here. `openCamera`/`switchCamera`/`setTorch` are the SAME
  // `useCamera()` hook instance's functions, passed down as props (see the
  // doc comment above where that hook is destructured).
  if (phase === 'idle' || phase === 'capturing') {
    return <CaptureScreen openCamera={openCamera} switchCamera={switchCamera} setTorch={setTorch} />;
  }

  // Fase 2.3 (capture-ux-redesign.md, Unit 4): the real deferred
  // batch-processing screen — sequential per-page detect->warp->thumbnail
  // over `rawCaptures`, degraded-fallback-safe, with a determinate
  // progress bar and a Cancel that returns to `'capturing'`. Replaces
  // Unit 3's temporary `common.processing` text placeholder.
  if (phase === 'processing') {
    return (
      <ProcessingScreen
        ensureOpenCvInit={ensureOpenCvInit}
        workerClient={workerClient}
        retryManualInit={retryManualInit}
      />
    );
  }

  // Group 5 / Slice E, rewired Group 1c: a FRESH, not-yet-confirmed capture
  // hands off to the corner editor instead of the live camera view. Fase 2.3
  // (Unit 3): DEAD in practice — `'capturing'` is now intercepted above
  // (routes to `CaptureScreen`) before reaching this point, and nothing sets
  // `draftCapture` anymore, so this branch's condition is narrowed to
  // `'editing-corners'` only (kept, see this file's top doc comment).
  if (phase === 'editing-corners' && draftCapture) {
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
      <Suspense fallback={<p data-testid="page-grid-loading">{t('scanner.loading')}</p>}>
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
          {t('scanner.scanComplete', { n: pages.length })}
        </p>
        {pages.length > 0 && (
          // Fase 2.2 item 4a: the last screen before export previously showed
          // only a text count, so there was nothing to actually PREVIEW.
          // Reuses the shared `PageThumbnail` (already applies each page's
          // filter via `buildThumbnailCssFilter`) so the filtered pages are
          // visibly confirmed here, exactly like the tray/grid strips.
          <div className="flex w-full items-center gap-2 overflow-x-auto" data-testid="scan-done-pages">
            {pages.map((page) => (
              <PageThumbnail
                key={page.id}
                bitmap={page.thumbnail}
                filter={page.recipe.filter}
                testId={`scan-done-thumb-${page.id}`}
              />
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="secondary"
          onClick={handleExportPdf}
          disabled={pages.length === 0 || exporting}
          data-testid="done-export-pdf"
        >
          {exporting ? t('scanner.exporting') : t('scanner.exportPdf')}
        </Button>
        <Button type="button" variant="primary" onClick={handleScanAgain} data-testid="scan-again">
          {t('scanner.scanAnother')}
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

  // `idle`/`capturing` (transient, no draft yet) both render the SAME
  // continuous camera view (design section 5.1). The tray strip (Group
  // 5/PR8's `CaptureTray`) only makes sense once at least one page exists.
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4">
      {openCvDegraded && <OpenCvDegradedBanner lastError={opencvLastError} onRetry={retryManualInit} />}

      <CameraView
        ref={videoRef}
        overlay={
          !openCvDegraded && <DetectionOverlay corners={corners} frameWidth={frameWidth} frameHeight={frameHeight} />
        }
      />

      {!openCvDegraded && (
        <QualityHints quality={quality} tooFar={tooFar} detected={rawCorners != null} stability={stability} />
      )}

      {!openCvDegraded && showNoDetectionHint && (
        <div className="flex flex-col items-center gap-2 text-center" data-testid="no-detection-hint">
          <p className="text-sm text-text-muted">{t('scanner.noDocumentDetected')}</p>
          <Button variant="secondary" type="button" onClick={handleCaptureAnyway} data-testid="capture-anyway">
            {t('scanner.captureAnyway')}
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
              {autoCaptureEnabled ? t('scanner.autoOn') : t('scanner.autoOff')}
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
              <span className="sr-only">{t('scanner.toggleTorch')}</span>
            </Button>
          )}
        </div>
      </div>

      <CaptureTray
        pages={pages}
        isAtCap={isAtCap}
        onDone={handleTrayDone}
        exporting={exporting}
        onExportPdf={handleExportPdf}
      />

      <CaptureButton onCapture={handleManualCapture} countdown={countdown} disabled={!canAddPage} />
    </div>
  );
}
