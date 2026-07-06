/**
 * Minimal scanner screen wiring `useCamera` + `CameraView` + `CameraSelector`
 * together (Group 3 / Slice C). This is intentionally thin: no live
 * detection overlay, no auto-capture, no corner editor — those land in
 * Groups 4/5. Its purpose here is to give the camera hook/components a real
 * consumer so the production build actually exercises this code path
 * (rather than being tree-shaken away), and to give Playwright something to
 * drive with Chromium's fake media stream.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Flashlight, FlashlightOff } from 'lucide-react';
import { Button } from '@/shared/ui';
import { CameraSelector } from '@/features/scanner/components/CameraSelector';
import { CameraView } from '@/features/scanner/components/CameraView';
import { useCamera } from '@/features/scanner/hooks/useCamera';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

export function ScannerScreen(): ReactNode {
  const { openCamera, switchCamera, setTorch } = useCamera();
  const permission = useScannerStore((s) => s.permission);
  const torchSupported = useScannerStore((s) => s.torchSupported);
  const torchOn = useScannerStore((s) => s.torchOn);
  const devices = useScannerStore((s) => s.devices);
  const lastCameraError = useScannerStore((s) => s.lastCameraError);
  const [started, setStarted] = useState(false);

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

  const handleStart = useCallback(() => {
    setStarted(true);
  }, []);

  const handleToggleTorch = useCallback(() => {
    void setTorch(!torchOn);
  }, [setTorch, torchOn]);

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

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4">
      <CameraView />
      <div className="flex w-full items-center justify-between gap-3">
        <CameraSelector onSelect={(deviceId) => void switchCamera(deviceId)} />
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
      {devices.length === 0 && (
        <p className="text-center text-sm text-text-muted" data-testid="no-camera-hint">
          No camera detected. An import fallback will be available in a later slice.
        </p>
      )}
    </div>
  );
}
