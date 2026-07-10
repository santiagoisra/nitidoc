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
 * `cropToVisibleRect` (D-4 WYSIWYG) -> `materializeRawCapture` -> stays in
 * `'capturing'` (this screen never navigates away on a successful capture).
 * A thrown error is caught, the partial bitmap released, a toast shown, and
 * the screen stays put — capture failures must never strand the user.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Flashlight, FlashlightOff } from 'lucide-react';
import { Button, useToast } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { CameraSelector } from '@/features/scanner/components/CameraSelector';
import { CameraView } from '@/features/scanner/components/CameraView';
import { CaptureButton } from '@/features/scanner/components/CaptureButton';
import { CaptureCountThumbnail } from '@/features/scanner/components/CaptureCountThumbnail';
import { ImportFallback } from '@/features/scanner/components/ImportFallback';
import { useActivePage } from '@/features/scanner/hooks/useActivePage';
import { decodeImportedFile } from '@/features/scanner/lib/captureFallback';
import { captureFullResFrame, cropToVisibleRect } from '@/features/scanner/lib/captureFrame';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { RawCapture } from '@/features/scanner/store/documentSlice';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

/** Duration of the post-capture screen-flash feedback (design "Feedback"). */
const FLASH_DURATION_MS = 180;

export interface CaptureScreenProps {
  readonly openCamera: (deviceId?: string) => Promise<void>;
  readonly switchCamera: (deviceId: string) => Promise<void>;
  readonly setTorch: (on: boolean) => Promise<void>;
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

export function CaptureScreen({ openCamera, switchCamera, setTorch }: CaptureScreenProps): ReactNode {
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
  const setPhase = useScannerStore((s) => s.setPhase);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inFlightRef = useRef(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [flash, setFlash] = useState(false);
  const [pendingBumps, setPendingBumps] = useState(0);

  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

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

  const handleToggleTorch = useCallback(() => {
    void setTorch(!torchOn);
  }, [setTorch, torchOn]);

  const handleNext = useCallback(() => {
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

    inFlightRef.current = true;
    setIsCapturing(true);
    setPendingBumps((n) => n + 1);
    setFlash(true);
    // Guarded — `navigator.vibrate` is absent on desktop/many browsers;
    // optional chaining makes this a silent no-op there (design "Feedback").
    navigator.vibrate?.(15);
    window.setTimeout(() => setFlash(false), FLASH_DURATION_MS);

    // Tracks the bitmap this call currently owns responsibility for closing.
    // Set to null the instant ownership is successfully handed off to
    // `materializeRawCapture` (which closes it regardless of 'added' vs
    // 'blocked-cap') — anything still non-null in `catch` means the hand-off
    // never completed and must be released here instead (F1 hygiene: never
    // leak a live bitmap on a thrown capture).
    let owned: ImageBitmap | null = null;
    try {
      const fullRes = await captureFullResFrame(video, track, imageCaptureSupported);
      owned = fullRes.bitmap;

      const rect = video.getBoundingClientRect();
      const cropped = await cropToVisibleRect(owned, video.videoWidth, video.videoHeight, {
        width: rect.width,
        height: rect.height,
      });
      owned = cropped;

      await materializeRawCapture({
        id: crypto.randomUUID(),
        originalBitmap: owned,
        originalWidth: owned.width,
        originalHeight: owned.height,
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
    }
  }, [imageCaptureSupported, isAtCap, materializeRawCapture, showToast, t]);

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
          id: crypto.randomUUID(),
          originalBitmap: decoded.bitmap,
          originalWidth: decoded.width,
          originalHeight: decoded.height,
        });
      } catch (error) {
        setImportError(error instanceof Error ? error.message : t('scanner.couldNotReadImage'));
      } finally {
        setImporting(false);
      }
    },
    [isAtCap, materializeRawCapture, t],
  );

  const displayCount = rawCaptures.length + pendingBumps;
  const lastThumbnail = rawCaptures.length > 0 ? (rawCaptures[rawCaptures.length - 1] as RawCapture).thumbnail : null;

  if (!cameraUsable) {
    // No-camera variant (design "Phase-gating decouple"): NEVER mounts a
    // live `CameraView` here — permission denied / no device / a camera
    // error all fall into this same branch, distinguished only by which
    // copy `ImportFallback` shows.
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-4 overflow-y-auto bg-bg p-4"
        data-testid="capture-screen-no-camera"
      >
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
    <div className="relative h-full min-h-[70dvh] w-full overflow-hidden bg-black" data-testid="capture-screen">
      <div
        className={`absolute inset-0 transition-transform duration-150 ease-out ${
          isCapturing ? 'scale-[0.97]' : 'scale-100'
        }`}
      >
        <CameraView ref={videoRef} fill />
      </div>

      {/* Screen-flash feedback (design "Feedback") — always mounted so the opacity transition can animate; toggled true then false shortly after a capture. */}
      <div
        aria-hidden="true"
        data-testid="capture-flash"
        className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-300 ${
          flash ? 'opacity-70' : 'opacity-0'
        }`}
      />

      <div
        className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent p-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <div className="pointer-events-auto">
          <CameraSelector onSelect={(deviceId) => void switchCamera(deviceId)} />
        </div>
        {torchSupported && (
          <div className="pointer-events-auto">
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
          </div>
        )}
      </div>

      <div
        className="absolute inset-x-0 bottom-0 grid grid-cols-3 items-center gap-2 bg-gradient-to-t from-black/60 to-transparent p-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
      >
        <div className="flex justify-start">
          <CaptureCountThumbnail count={displayCount} lastThumbnail={lastThumbnail} onRetakeLast={handleRetakeLast} />
        </div>
        <div className="flex justify-center">
          <CaptureButton onCapture={() => void handleCapture()} countdown={0} disabled={isCapturing || isAtCap} />
        </div>
        <div className="flex justify-end">
          {rawCaptures.length > 0 && (
            <Button type="button" variant="primary" onClick={handleNext} data-testid="capture-next">
              {t('capture.next')}
            </Button>
          )}
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
