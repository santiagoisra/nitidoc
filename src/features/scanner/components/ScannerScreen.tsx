/**
 * Scanner screen wiring `useCamera` + `CameraView` + `CameraSelector` +
 * `useDocumentDetection` + `DetectionOverlay` + `CaptureButton` +
 * `QualityHints` + `CornerEditor` together (Group 3 / Slice C camera
 * lifecycle + Group 4 / Slice D live detection and auto-capture + Group 5 /
 * Slice E corner editor and warp).
 *
 * Capture sequence (design section 2.2): pause the detection loop, capture
 * the full-res frame, scale the last known detected corners from the
 * downscaled detection space to the full-res capture space, and store the
 * immutable `CapturedFrame` (moves `CaptureSlice.phase` to
 * 'editing-corners'). Once in that phase, this screen renders `CornerEditor`
 * (Group 5). Backing out of the editor without confirming resumes the live
 * detection loop (this screen owns that transition, per Slice E scope).
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Flashlight, FlashlightOff } from 'lucide-react';
import { Button } from '@/shared/ui';
import { CameraSelector } from '@/features/scanner/components/CameraSelector';
import { CameraView } from '@/features/scanner/components/CameraView';
import { CaptureButton } from '@/features/scanner/components/CaptureButton';
import { CornerEditor } from '@/features/scanner/components/CornerEditor';
import { DetectionOverlay } from '@/features/scanner/components/DetectionOverlay';
import { QualityHints } from '@/features/scanner/components/QualityHints';
import { useCamera } from '@/features/scanner/hooks/useCamera';
import { useDocumentDetection } from '@/features/scanner/hooks/useDocumentDetection';
import { captureFullResFrame } from '@/features/scanner/lib/captureFrame';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import { isTooFar, scaleCornersToFullRes } from '@/features/scanner/lib/detectionMath';
import { isConvex, orderCorners } from '@/features/scanner/lib/geometry';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { Quad } from '@/shared/types/geometry';

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
  const setOriginalFrame = useScannerStore((s) => s.setOriginalFrame);
  const setPhase = useScannerStore((s) => s.setPhase);
  const phase = useScannerStore((s) => s.phase);
  const originalFrame = useScannerStore((s) => s.originalFrame);
  const resetCaptureSlice = useScannerStore((s) => s.resetCaptureSlice);

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

  const { start: startDetection, stop: stopDetection } = useDocumentDetection({
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

  // Task 4.1.3: start the detection loop once the video element exists and
  // the camera has granted access. useDocumentDetection.start() is
  // idempotent while already running, so this can safely re-run whenever
  // its dependencies change without double-starting the loop.
  //
  // Slice E addition: the loop must stay stopped while `phase` is
  // 'editing-corners' or 'capturing' — the corner editor owns resuming it
  // (via handleEditorCancel/handleEditorConfirm below) once the user is done
  // with this frame, so DETECT never races the editor's own warp calls over
  // the same worker.
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

      setOriginalFrame({
        source: captured.bitmap,
        width: captured.width,
        height: captured.height,
        capturedAt: Date.now(),
      });

      // On success the frame is handed off; CornerEditor renders once `phase`
      // becomes 'editing-corners' (set by setOriginalFrame). Backing out of
      // or confirming the editor resumes the loop — see handleEditorCancel /
      // handleEditorConfirm below.
    } catch {
      // Slice D review fix M4: if capture throws (e.g. ImageCapture failure),
      // never leave the scanner frozen in 'capturing'. Restore a usable phase
      // and resume the live detection loop so the user can retry.
      setPhase('idle');
      if (videoRef.current) {
        startDetection(videoRef.current);
      }
    }
  }, [imageCaptureSupported, setOriginalFrame, setPhase, startDetection, stopDetection]);

  // Keep the ref pointing at the latest capture sequence so the detection
  // hook's stable `onAutoCapture` callback always invokes the current one.
  runCaptureSequenceRef.current = runCaptureSequence;

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
   * Discards the current capture (original frame + any warp result/recipe)
   * and resumes the live detection loop (Slice E owns this transition per
   * the apply prompt: "Slice E tambien es dueña de reanudar el loop de
   * deteccion si el usuario vuelve atras"). `resetCaptureSlice` itself closes
   * the retained `originalFrame`/`warpedImage` bitmaps (design section 7) —
   * this handler does not close them again.
   */
  const handleEditorCancel = useCallback(() => {
    resetCaptureSlice();
    setPhase('idle');
    editorInitialCornersRef.current = null;
    if (videoRef.current) {
      startDetection(videoRef.current);
    }
  }, [resetCaptureSlice, setPhase, startDetection]);

  /**
   * Confirms the current recipe/warp as the finished capture. Fase 1 has a
   * single screen with no downstream export step, so "done" simply marks
   * the phase and leaves the warped preview + recipe in the store for the
   * user to see; a fresh capture (handleManualCapture) starts a new cycle,
   * whose setOriginalFrame will close this originalFrame's bitmap per the
   * store's existing close-before-overwrite hygiene.
   */
  const handleEditorConfirm = useCallback(() => {
    setPhase('done');
  }, [setPhase]);

  if (!started) {
    return (
      <Button variant="primary" type="button" onClick={handleStart} data-testid="open-scanner">
        Open scanner
      </Button>
    );
  }

  if (permission === 'denied') {
    return (
      <p role="alert" className="max-w-sm text-center text-sm text-danger" data-testid="permission-denied">
        Camera access was denied. Enable camera permission in your browser settings and reload, or use the
        import fallback (coming in a later slice).
      </p>
    );
  }

  if (lastCameraError != null) {
    return (
      <p role="alert" className="max-w-sm text-center text-sm text-danger" data-testid="camera-error">
        Could not open the camera. Try again, or use the import fallback (coming in a later slice).
      </p>
    );
  }

  // Group 5 / Slice E: once a frame is captured, hand off to the corner
  // editor instead of the live camera view. 'capturing' also renders this
  // branch (briefly, while captureFullResFrame resolves) so the screen
  // never flashes back to a stale camera view mid-capture.
  if ((phase === 'editing-corners' || phase === 'capturing') && originalFrame) {
    return (
      <CornerEditor
        // Fix M3: key the editor by the frame's capture timestamp so a second
        // capture REMOUNTS it with fresh `corners`/`aspectOverride` state.
        // Without a key, the useState seeds only apply on first mount and the
        // next capture would inherit the previous frame's dragged corners /
        // aspect override.
        key={originalFrame.capturedAt}
        frame={originalFrame}
        initialCorners={editorInitialCornersRef.current}
        onConfirm={handleEditorConfirm}
        onCancel={handleEditorCancel}
      />
    );
  }

  if (phase === 'done' && originalFrame) {
    return (
      <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="scan-done">
        <p className="text-sm text-text-muted">Scan complete.</p>
        <Button type="button" variant="primary" onClick={handleEditorCancel} data-testid="scan-again">
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

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4">
      <CameraView
        ref={videoRef}
        overlay={<DetectionOverlay corners={corners} frameWidth={frameWidth} frameHeight={frameHeight} />}
      />

      <QualityHints quality={quality} tooFar={tooFar} />

      {showNoDetectionHint && (
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
          <Button
            variant="secondary"
            type="button"
            onClick={handleToggleAutoCapture}
            aria-pressed={autoCaptureEnabled}
            data-testid="auto-capture-toggle"
          >
            {autoCaptureEnabled ? 'Auto on' : 'Auto off'}
          </Button>
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

      <CaptureButton onCapture={handleManualCapture} countdown={countdown} />

      {devices.length === 0 && (
        <p className="text-center text-sm text-text-muted" data-testid="no-camera-hint">
          No camera detected. An import fallback will be available in a later slice.
        </p>
      )}
    </div>
  );
}
