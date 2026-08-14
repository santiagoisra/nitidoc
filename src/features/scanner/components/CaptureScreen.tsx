/**
 * Full-bleed, persistent capture screen (Fase 2.3, capture-ux-redesign.md,
 * Unit 3). Replaces the old idle/capturing camera+tray view for the
 * `'idle'`/`'capturing'` phases: manual captures accumulate as
 * `DocumentSlice.rawCaptures` while the camera stays open and NO per-frame
 * DETECT runs (detection is deferred to the `'processing'` batch step,
 * Unit 4) — see the design doc's "Phase model".
 *
 * Camera ownership: `openCamera`/`switchCamera`/`setTorch` are passed down
 * from `ScannerScreen`'s single `useCamera()` hook instance rather than
 * calling `useCamera()` again here, deliberately — that hook keeps its own
 * `streamRef`/generation-token refs PER HOOK INSTANCE, so a second instance
 * would race the first over the same underlying `MediaStream` with an
 * independent (and therefore unsynchronized) supersession counter.
 *
 * Phase-gating decouple (design "Phase-gating decouple (critical)"):
 * `cameraUsable` folds permission/devices/lastCameraError into ONE boolean
 * this screen checks itself, instead of `ScannerScreen` early-returning
 * before this screen is even reached. When `!cameraUsable` this renders the
 * no-camera variant: no live `CameraView` is ever mounted (never risk a
 * black/frozen video element), only the accumulated raw thumbnails + an
 * "Import another" fallback (reusing `ImportFallback`'s file input, but
 * routed through the LIGHTWEIGHT `materializeRawCapture` pipeline — no
 * DETECT, no CornerEditor; that per-image analysis is Unit 4's job now) +
 * "Siguiente".
 *
 * Capture flow (design "Capture flow (rewrite runCaptureSequence)"):
 * tap -> guard (in-flight ref OR `isAtCap`) -> `captureFullResFrame` ->
 * `materializeRawCapture` -> stays in
 * `'capturing'` (this screen never navigates away on a successful capture).
 * A thrown error is caught, the partial bitmap released, a toast shown, and
 * the screen stays put — capture failures must never strand the user.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Flashlight, FlashlightOff } from 'lucide-react';
import { BackButton, Button, useToast } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { CameraSelector } from '@/features/scanner/components/CameraSelector';
import { CameraView } from '@/features/scanner/components/CameraView';
import { CaptureButton } from '@/features/scanner/components/CaptureButton';
import { CaptureCountThumbnail } from '@/features/scanner/components/CaptureCountThumbnail';
import { ImportFallback } from '@/features/scanner/components/ImportFallback';
import { PaperFormatPicker } from '@/features/scanner/components/PaperFormatPicker';
import { useActivePage } from '@/features/scanner/hooks/useActivePage';
import { decodeImportedFile } from '@/features/scanner/lib/captureFallback';
import { captureFullResFrame } from '@/features/scanner/lib/captureFrame';
import { mapObjectCoverGuideToSourceQuad } from '@/features/scanner/lib/cameraGuideGeometry';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { capturePaperSelection, getPaperFormat } from '@/features/scanner/lib/paperFormats';
import type { DocumentPage, RawCapture } from '@/features/scanner/store/documentSlice';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import { randomId } from '@/shared/lib/randomId';
import type { PaperFormatAlias } from '@/shared/types/paper';

/**
 * Duration of the post-capture screen-flash feedback. Redesign (HANDOFF-UI.md
 * section 5.2): the flash is now SECONDARY — the fly-to-tray animation is the
 * primary capture feedback — so it is short and subtle (200ms, ~.75 opacity).
 */
const FLASH_DURATION_MS = 200;

/** A white rect cloned from the crop, flying into the count tile (design 5.2). */
interface FlyState {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The CSS `--fly-target` translate that lands the rect on the tile. */
  readonly target: string;
}

export interface CaptureScreenProps {
  readonly openCamera: (deviceId?: string) => Promise<void>;
  readonly switchCamera: (deviceId: string) => Promise<void>;
  readonly setTorch: (on: boolean) => Promise<void>;
  /**
   * Returns to the welcome screen (navigation-ux, bug 1). Without it this
   * screen was a one-way door: once the camera opened there was no route to
   * the history or to importing a file short of killing the app. Captures
   * already taken are NOT discarded — coming back resumes them.
   */
  readonly onBack: () => void;
}

/** Small, filter-less thumbnail tile for the no-camera variant's raw-capture strip. Never decodes a blob — draws the cached thumbnail as-is. */
function RawThumbnailTile({ raw }: { readonly raw: RawCapture }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = raw.thumbnail.width;
    canvas.height = raw.thumbnail.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(raw.thumbnail, 0, 0);
  }, [raw.thumbnail]);

  return (
    <canvas
      ref={canvasRef}
      className="aspect-[3/4] h-20 shrink-0 rounded bg-surface object-cover"
      data-testid={`capture-raw-thumb-${raw.id}`}
      aria-hidden="true"
    />
  );
}

export function CaptureScreen({ openCamera, switchCamera, setTorch, onBack }: CaptureScreenProps): ReactNode {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { materializeRawCapture, isAtCap } = useActivePage();

  const permission = useScannerStore((s) => s.permission);
  const devices = useScannerStore((s) => s.devices);
  const lastCameraError = useScannerStore((s) => s.lastCameraError);
  const imageCaptureSupported = useScannerStore((s) => s.imageCaptureSupported);
  const torchSupported = useScannerStore((s) => s.torchSupported);
  const torchOn = useScannerStore((s) => s.torchOn);
  const rawCaptures = useScannerStore((s) => s.rawCaptures);
  const pages = useScannerStore((s) => s.pages);
  const setPhase = useScannerStore((s) => s.setPhase);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const guideRef = useRef<HTMLDivElement | null>(null);
  // Wraps the count tile so `handleCapture` can read its screen position and
  // aim the fly-to-tray animation at it (design 5.2).
  const trayRef = useRef<HTMLDivElement | null>(null);
  const inFlightRef = useRef(false);
  // Post-capture flash auto-off timer — tracked so it is cleared on unmount
  // (a capture right before leaving `capturing` must not fire `setFlash` after
  // the component is gone).
  const flashTimerRef = useRef<number | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [flash, setFlash] = useState(false);
  const [fly, setFly] = useState<FlyState | null>(null);
  const [pendingBumps, setPendingBumps] = useState(0);
  /**
   * "Siguiente" tapped while a capture was still materializing
   * (capture-latency, bug 5). The ref is what `handleCapture`'s `finally`
   * reads — it needs the value synchronously, before any re-render — while the
   * state drives the button's busy label so the user can see the tap landed.
   */
  const nextQueuedRef = useRef(false);
  const [nextQueued, setNextQueued] = useState(false);
  // Bumped once per capture to re-play the CaptureButton shutter-ring animation.
  const [shutterKey, setShutterKey] = useState(0);

  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [paperAlias, setPaperAlias] = useState<PaperFormatAlias>('a4');
  const paperLabels: Record<PaperFormatAlias, string> = {
    a4: t('capture.paperA4A3'),
    oficio: t('capture.paperOficio'),
    letter: t('capture.paperLetter'),
    legal: t('capture.paperLegal'),
    ticket: t('capture.paperTicket'),
    original: t('capture.paperOriginal'),
  };
  const selectedPaperFormat = getPaperFormat(paperAlias);
  const selectedPaperLabel = paperLabels[paperAlias];
  const paperPicker = <PaperFormatPicker value={paperAlias} onChange={setPaperAlias} disabled={isCapturing} />;

  const cameraUsable = permission !== 'denied' && devices.length > 0 && lastCameraError == null;

  // Re-arm camera on entry (design "Re-arm camera on entry to 'capturing'"):
  // this screen only mounts while phase is 'idle'/'capturing', so mounting
  // itself IS "entry" — covers the very first "Open scanner" tap AND every
  // later re-entry (grid "Capturar más" / done "Escanear otro") without
  // reopening an already-live stream. Mount-only by design; a stream that
  // dies mid-session (tab backgrounded, OS reclaims the camera) is instead
  // handled by `useCamera`'s own visibilitychange re-acquisition.
  useEffect(() => {
    const stream = useScannerStore.getState().stream;
    const track = stream?.getVideoTracks()[0] ?? null;
    if (!track || track.readyState === 'ended') {
      void openCamera();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear a pending flash-off timer on unmount (F1 hygiene: no state updates
  // after the component leaves the tree — also silences a test-teardown warning).
  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    },
    [],
  );

  const handleToggleTorch = useCallback(() => {
    void setTorch(!torchOn);
  }, [setTorch, torchOn]);

  const handleNext = useCallback(() => {
    // Advancing while a capture is still materializing would lose it:
    // `useBatchProcess.run()` snapshots `rawCaptures`, so the in-flight one
    // would never be processed.
    //
    // This used to `return` outright — the tap was DISCARDED, with no feedback
    // at all (capture-latency, bug 5). On a fast phone the window is
    // invisible; on a slow one the user taps "Siguiente", nothing happens, and
    // the app looks broken rather than busy. Now the intent is remembered and
    // acted on the moment the capture lands, so a tap is never wasted.
    if (inFlightRef.current) {
      nextQueuedRef.current = true;
      setNextQueued(true);
      return;
    }
    setPhase('processing');
  }, [setPhase]);

  const handleRetakeLast = useCallback(() => {
    useScannerStore.getState().removeLastRawCapture();
  }, []);

  const handleCapture = useCallback(async () => {
    if (inFlightRef.current || isAtCap) {
      return; // Anti-double-tap + hard-cap guard (design "Capture flow").
    }
    const video = videoRef.current;
    const stream = useScannerStore.getState().stream;
    const track = stream?.getVideoTracks()[0];
    if (!video || !track) {
      return;
    }

    // Snapshot manual-crop inputs before changing UI state or awaiting a
    // hardware frame. The guide can reflow while a capture is in flight.
    const capturePaperAlias = paperAlias;
    const capturePaperFormat = getPaperFormat(capturePaperAlias);
    const videoRect = video.getBoundingClientRect();
    const guideRect = guideRef.current?.getBoundingClientRect();
    const requiresGuide = capturePaperFormat.portraitRatio !== undefined;
    const hasMeasuredGuide =
      guideRect != null &&
      Number.isFinite(videoRect.width) &&
      Number.isFinite(videoRect.height) &&
      Number.isFinite(guideRect.width) &&
      Number.isFinite(guideRect.height) &&
      videoRect.width > 0 &&
      videoRect.height > 0 &&
      guideRect.width > 0 &&
      guideRect.height > 0;

    // A named-paper capture promises that the visible guide is its crop.
    // Reject synchronously before a camera read or animation when the layout
    // has not been measured (for example during a resize/reflow).
    if (requiresGuide && !hasMeasuredGuide) {
      showToast({ message: t('capture.captureFailed'), variant: 'danger' });
      return;
    }

    inFlightRef.current = true;
    setIsCapturing(true);
    setPendingBumps((n) => n + 1);
    setShutterKey((k) => k + 1);
    setFlash(true);
    // Guarded — `navigator.vibrate` is absent on desktop/many browsers;
    // optional chaining makes this a silent no-op there (design "Feedback").
    navigator.vibrate?.(15);
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setFlash(false);
    }, FLASH_DURATION_MS);

    // Fly-to-tray (design 5.2): clone a white rect the size of the visible
    // crop and send it toward the count tile — the primary capture feedback.
    // Aimed here, on the tap, from the CURRENT on-screen geometry; the counter
    // then pops (`count-pop`) when the rect lands. Skipped if the tile isn't
    // laid out yet (defensive) — the flash + shutter ring still fire.
    const trayRect = trayRef.current?.getBoundingClientRect();
    if (trayRect) {
      const startCx = videoRect.left + videoRect.width / 2;
      const startCy = videoRect.top + videoRect.height / 2;
      const tileCx = trayRect.left + trayRect.width / 2;
      const tileCy = trayRect.top + trayRect.height / 2;
      setFly({
        left: startCx,
        top: startCy,
        width: videoRect.width,
        height: videoRect.height,
        target: `translate(calc(-50% + ${tileCx - startCx}px), calc(-50% + ${tileCy - startCy}px))`,
      });
    }

    // Tracks the bitmap this call currently owns responsibility for closing.
    // Set to null the instant ownership is successfully handed off to
    // `materializeRawCapture` (which closes it regardless of 'added' vs
    // 'blocked-cap') — anything still non-null in `catch` means the hand-off
    // never completed and must be released here instead (F1 hygiene: never
    // leak a live bitmap on a thrown capture).
    let owned: ImageBitmap | null = null;
    try {
      // Manual guide geometry is measured against the displayed video. A
      // still may use another orientation/aspect, so use the video-frame
      // capture path whenever a named guide is active.
      const fullRes = await captureFullResFrame(
        video,
        track,
        imageCaptureSupported && !requiresGuide,
        requiresGuide,
      );
      owned = fullRes.bitmap;

      const guideQuad =
        guideRect && requiresGuide
          ? mapObjectCoverGuideToSourceQuad(
              { width: owned.width, height: owned.height },
              videoRect,
              guideRect,
            )
          : null;
      if (requiresGuide && !guideQuad) {
        throw new Error('capture: manual guide could not be measured.');
      }
      await materializeRawCapture({
        id: randomId(),
        originalBitmap: owned,
        originalWidth: owned.width,
        originalHeight: owned.height,
        paper: capturePaperSelection(capturePaperAlias),
        ...(guideQuad ? { guideQuad } : {}),
      });
      owned = null;
    } catch {
      owned?.close();
      showToast({ message: t('capture.captureFailed'), variant: 'danger' });
      // Stays in 'capturing' — nothing else to do (design "on throw: close
      // partial bitmap, toast, stay in 'capturing'").
    } finally {
      inFlightRef.current = false;
      setIsCapturing(false);
      setPendingBumps((n) => Math.max(0, n - 1));

      // Honour a "Siguiente" tapped during the capture, now that the raw
      // capture is safely in the store and `useBatchProcess` will see it
      // (capture-latency, bug 5). Fires on the failure path too: the user
      // asked to move on, and a failed capture already showed its own toast —
      // trapping them on the camera to re-tap would be a second insult.
      if (nextQueuedRef.current) {
        nextQueuedRef.current = false;
        setNextQueued(false);
        setPhase('processing');
      }
    }
  }, [imageCaptureSupported, isAtCap, materializeRawCapture, paperAlias, setPhase, showToast, t]);

  const handleImportAnother = useCallback(
    async (file: File) => {
      if (isAtCap) {
        setImportError(t('common.documentLimitReached', { cap: FILTER.PAGE_CAP }));
        return;
      }
      setImportError(null);
      setImporting(true);
      try {
        const decoded = await decodeImportedFile(file);
        await materializeRawCapture({
          id: randomId(),
          originalBitmap: decoded.bitmap,
          originalWidth: decoded.width,
          originalHeight: decoded.height,
          paper: capturePaperSelection(paperAlias),
        });
      } catch (error) {
        setImportError(error instanceof Error ? error.message : t('scanner.couldNotReadImage'));
      } finally {
        setImporting(false);
      }
    },
    [isAtCap, materializeRawCapture, paperAlias, t],
  );

  // Bug 5 fix: by the time the user re-enters 'capturing' via grid/adjust
  // "Capturar más", `rawCaptures` has already been cleared into `pages` by
  // `useBatchProcess.run()` — counting `rawCaptures.length` alone made the
  // camera counter drop to 0 even though the document already has pages.
  // Summing both collections reflects the whole document-in-progress; this
  // degrades to the original `rawCaptures.length` math whenever `pages` is
  // empty, so the very first capture flow is unchanged.
  const displayCount = pages.length + rawCaptures.length + pendingBumps;
  const lastThumbnail =
    rawCaptures.length > 0
      ? (rawCaptures[rawCaptures.length - 1] as RawCapture).thumbnail
      : pages.length > 0
        ? (pages[pages.length - 1] as DocumentPage).thumbnail
        : null;

  if (!cameraUsable) {
    // No-camera variant (design "Phase-gating decouple"): NEVER mounts a
    // live `CameraView` here — permission denied / no device / a camera
    // error all fall into this same branch, distinguished only by which
    // copy `ImportFallback` shows.
    return (
      <div
        className="flex h-full w-full flex-col items-center gap-4 overflow-y-auto bg-bg p-4"
        data-testid="capture-screen-no-camera"
      >
        {/* The no-camera variant needs the way out just as much — arguably
            more, since a user who landed here by denying permission is the
            most likely to want the history or a different entry point. */}
        <div className="flex w-full items-center justify-start">
          <BackButton onClick={onBack} testId="capture-back" />
        </div>

        <div className="w-full text-text">{paperPicker}</div>

        <ImportFallback
          reason={permission === 'denied' ? 'permission-denied' : 'no-camera'}
          onFileSelected={(file) => void handleImportAnother(file)}
          errorMessage={importError}
          busy={importing}
        />

        {lastCameraError != null && (
          <p role="alert" className="text-sm text-danger" data-testid="camera-error">
            {t('scanner.cameraError')}
          </p>
        )}

        {rawCaptures.length > 0 && (
          <div className="flex w-full items-center gap-2 overflow-x-auto" data-testid="capture-no-camera-thumbs">
            {rawCaptures.map((raw) => (
              <RawThumbnailTile key={raw.id} raw={raw} />
            ))}
          </div>
        )}

        {rawCaptures.length > 0 && (
          <Button type="button" variant="primary" onClick={handleNext} data-testid="capture-next">
            {t('capture.next')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="relative grid h-full min-h-[70dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-black" data-testid="capture-screen">
      <div
        className={`absolute inset-0 transition-transform duration-150 ease-out ${
          isCapturing ? 'scale-[0.97]' : 'scale-100'
        }`}
      >
        <CameraView ref={videoRef} fill />
      </div>

      {/* Screen-flash feedback (secondary now, design 5.2) — always mounted so the opacity transition can animate; toggled true then false shortly after a capture. */}
      <div
        aria-hidden="true"
        data-testid="capture-flash"
        className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-200 ${
          flash ? 'opacity-75' : 'opacity-0'
        }`}
      />

      {/* Fly-to-tray rect (design 5.2) — the primary capture feedback. Keyed on
          `shutterKey` so each shot remounts and re-plays the one-shot flight;
          clears itself on animation end. Disabled motion (prefers-reduced-
          motion) collapses the flight to ~0ms so it never lingers on screen. */}
      {fly && (
        <div
          key={shutterKey}
          aria-hidden="true"
          data-testid="capture-fly"
          onAnimationEnd={() => setFly(null)}
          className="animate-fly-tray pointer-events-none fixed z-50 rounded-lg bg-white/85"
          style={
            {
              left: fly.left,
              top: fly.top,
              width: fly.width,
              height: fly.height,
              '--fly-target': fly.target,
            } as CSSProperties
          }
        />
      )}

      <div
        data-testid="capture-toolbar"
        className="pointer-events-none z-10 flex min-w-0 items-start justify-between gap-2 bg-gradient-to-b from-[rgba(10,8,6,0.72)] to-transparent py-3 pl-[calc(env(safe-area-inset-left)_+_0.75rem)] pr-[calc(env(safe-area-inset-right)_+_0.75rem)]"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <div
          className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
          data-testid="capture-toolbar-leading"
        >
          <BackButton onClick={onBack} tone="overlay" testId="capture-back" />
          <CameraSelector onSelect={(deviceId) => void switchCamera(deviceId)} />
        </div>
        {torchSupported && (
          <div className="pointer-events-auto h-11 w-11 shrink-0" data-testid="torch-control">
            <Button
              variant="secondary"
              type="button"
              onClick={handleToggleTorch}
              aria-pressed={torchOn}
              data-testid="torch-toggle"
              className="h-11 w-11 shrink-0 !p-0"
            >
              {torchOn ? (
                <Flashlight size={18} strokeWidth={1.5} aria-hidden="true" />
              ) : (
                <FlashlightOff size={18} strokeWidth={1.5} aria-hidden="true" />
              )}
              <span className="sr-only">{t('scanner.toggleTorch')}</span>
            </Button>
          </div>
        )}
      </div>

      <div className="pointer-events-none relative z-10 min-h-0 min-w-0 overflow-hidden px-4" data-testid="capture-guide-layout">
        {selectedPaperFormat.portraitRatio && selectedPaperFormat.nominalMm && (
          <div
            ref={guideRef}
            data-testid="capture-paper-guide-frame"
            className="absolute left-1/2 top-1/2 h-auto w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2"
            style={{ aspectRatio: selectedPaperFormat.portraitRatio }}
          >
            {/* A single guide box is the geometry source for both its visible border and the outside dimmer.
                The oversized shadow is clipped by the guide row, leaving this rectangle fully transparent. */}
            <div
              aria-hidden="true"
              data-testid="capture-paper-guide-mask"
              className="absolute inset-0"
              style={{ boxShadow: '0 0 0 9999px rgb(0 0 0 / 55%)' }}
            />
            <svg
              role="img"
              aria-label={t('capture.paperGuide', { format: selectedPaperLabel })}
              data-testid="capture-paper-guide-container"
              viewBox={`0 0 ${selectedPaperFormat.nominalMm.width} ${selectedPaperFormat.nominalMm.height}`}
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full"
            >
              <rect data-testid="capture-paper-guide" x="1" y="1" width={selectedPaperFormat.nominalMm.width - 2} height={selectedPaperFormat.nominalMm.height - 2} fill="none" stroke="rgba(45, 212, 191, 0.9)" strokeWidth="2" strokeDasharray="8 6" pointerEvents="none" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        )}
      </div>

      <div
        className="z-10 min-w-0 bg-gradient-to-t from-[rgba(10,8,6,0.8)] to-transparent p-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
      >
        <div className="mb-3">{paperPicker}</div>
        <div className="grid grid-cols-3 items-center gap-2">
          <div className="flex justify-start" ref={trayRef}>
            <CaptureCountThumbnail count={displayCount} lastThumbnail={lastThumbnail} onRetakeLast={handleRetakeLast} />
          </div>
          <div className="flex justify-center">
            <CaptureButton onCapture={() => void handleCapture()} disabled={isCapturing || isAtCap} shutterKey={shutterKey} />
          </div>
        {/* "Siguiente" is deliberately NOT `disabled={isCapturing}` any more
            (capture-latency, bug 5): a disabled button swallows the tap
            entirely, which is exactly how the intent got lost. It stays
            tappable, `handleNext` queues the transition, and the label reports
            that it is waiting rather than leaving the user wondering whether
            the tap registered at all. */}
          <div className="flex justify-end">
            {rawCaptures.length > 0 && (
              <Button type="button" variant="primary" onClick={handleNext} data-testid="capture-next">
                {nextQueued ? t('common.processing') : t('capture.next')}
              </Button>
            )}
          </div>
        </div>
        {isAtCap && (
          <p className="col-span-3 text-center text-xs text-text-muted" data-testid="capture-cap-hint">
            {t('common.documentLimitReached', { cap: FILTER.PAGE_CAP })}
          </p>
        )}
      </div>
    </div>
  );
}
