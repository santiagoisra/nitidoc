/**
 * `useCamera` — opens the back camera, tracks its real negotiated
 * resolution, enumerates/switches devices, controls torch, and pauses the
 * stream while the tab is hidden (design section 5.1 `CameraSlice`;
 * proposal section 3.4; scanner spec "Apertura y control de camara").
 *
 * Scope (Group 3 / Slice C): camera lifecycle only. The live-detection loop
 * that consumes frames from this stream is Group 4 (Slice D) — out of scope
 * here.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  detectImageCaptureSupport,
  detectOffscreenCanvasSupport,
} from '@/features/scanner/lib/captureFeatureDetect';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 3840 },
  height: { ideal: 2160 },
};

/** Capability check for `track.getCapabilities().torch`, not exposed in lib.dom's MediaTrackCapabilities yet. */
interface TorchCapabilities extends MediaTrackCapabilities {
  readonly torch?: boolean;
}

/** Constraint set for `applyConstraints({ advanced: [{ torch }] })`, likewise missing from lib.dom. */
interface TorchConstraintSet extends MediaTrackConstraintSet {
  readonly torch?: boolean;
}

export interface UseCameraResult {
  /** Requests the back camera (or the given device) and opens the stream. */
  readonly openCamera: (deviceId?: string) => Promise<void>;
  /** Stops the current stream's tracks and clears camera state. */
  readonly closeCamera: () => void;
  /** Switches to a different videoinput device, replacing the active stream. */
  readonly switchCamera: (deviceId: string) => Promise<void>;
  /** Toggles torch on the active track when `torchSupported` is true. */
  readonly setTorch: (on: boolean) => Promise<void>;
}

function isVideoInput(device: MediaDeviceInfo): boolean {
  return device.kind === 'videoinput';
}

function getActiveTrack(stream: MediaStream | null): MediaStreamTrack | null {
  return stream?.getVideoTracks()[0] ?? null;
}

export function useCamera(): UseCameraResult {
  const streamRef = useRef<MediaStream | null>(null);

  const setStream = useScannerStore((s) => s.setStream);
  const setDevices = useScannerStore((s) => s.setDevices);
  const setActiveDeviceId = useScannerStore((s) => s.setActiveDeviceId);
  const setRealResolution = useScannerStore((s) => s.setRealResolution);
  const setTorchSupported = useScannerStore((s) => s.setTorchSupported);
  const setTorchOn = useScannerStore((s) => s.setTorchOn);
  const setPermission = useScannerStore((s) => s.setPermission);
  const setCaptureCapabilities = useScannerStore((s) => s.setCaptureCapabilities);
  const resetCamera = useScannerStore((s) => s.resetCamera);

  const stopStream = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const applyTrackState = useCallback(
    (track: MediaStreamTrack) => {
      const settings = track.getSettings();
      setRealResolution(
        settings.width != null && settings.height != null
          ? { width: settings.width, height: settings.height }
          : null,
      );

      const capabilities = track.getCapabilities?.() as TorchCapabilities | undefined;
      setTorchSupported(capabilities?.torch === true);
      setTorchOn(false);
    },
    [setRealResolution, setTorchSupported, setTorchOn],
  );

  const refreshDeviceList = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      setDevices(allDevices.filter(isVideoInput));
    } catch {
      // enumerateDevices() failing (rare — unsupported/insecure context) is
      // non-fatal: the caller still has an open stream. Leave devices as-is.
    }
  }, [setDevices]);

  const openCamera = useCallback(
    async (deviceId?: string) => {
      setCaptureCapabilities({
        imageCaptureSupported: detectImageCaptureSupport(),
        offscreenSupported: detectOffscreenCanvasSupport(),
      });

      const constraints: MediaStreamConstraints = {
        video: deviceId != null ? { ...VIDEO_CONSTRAINTS, deviceId: { exact: deviceId } } : VIDEO_CONSTRAINTS,
      };

      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stopStream(streamRef.current);
        streamRef.current = stream;
        setStream(stream);
        setPermission('granted');

        const track = getActiveTrack(stream);
        if (track) {
          applyTrackState(track);
          setActiveDeviceId(track.getSettings().deviceId ?? deviceId ?? null);
        }

        await refreshDeviceList();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          setPermission('denied');
          return;
        }
        if (error instanceof DOMException && error.name === 'NotFoundError') {
          // No videoinput device available (desktop without a camera).
          // scanner spec "Sin camara disponible (desktop)" — the fallback
          // import UI (Group 6) reacts to devices being empty; nothing else
          // to do here besides making sure the device list reflects reality.
          setDevices([]);
          setStream(null);
          return;
        }
        throw error;
      }
    },
    [
      applyTrackState,
      refreshDeviceList,
      setActiveDeviceId,
      setCaptureCapabilities,
      setDevices,
      setPermission,
      setStream,
      stopStream,
    ],
  );

  const closeCamera = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    resetCamera();
  }, [resetCamera, stopStream]);

  const switchCamera = useCallback(
    async (deviceId: string) => {
      await openCamera(deviceId);
    },
    [openCamera],
  );

  const setTorch = useCallback(
    async (on: boolean) => {
      const track = getActiveTrack(streamRef.current);
      if (!track) {
        return;
      }
      const capabilities = track.getCapabilities?.() as TorchCapabilities | undefined;
      if (capabilities?.torch !== true) {
        return;
      }
      const advanced: TorchConstraintSet[] = [{ torch: on }];
      await track.applyConstraints({ advanced: advanced as MediaTrackConstraintSet[] });
      setTorchOn(on);
    },
    [setTorchOn],
  );

  // visibilitychange (design section 8, row "visibilitychange"; scanner spec
  // "Pestaña oculta durante la deteccion en vivo"): pause by stopping the
  // stream's tracks while hidden are NOT what design calls for — design says
  // "NO detener el track" and only pause the detection loop (Group 4's
  // concern). This hook's job is narrower: re-acquire the stream only if the
  // track actually died while hidden (e.g. OS reclaimed the camera).
  useEffect(() => {
    function handleVisibilityChange(): void {
      if (document.hidden) {
        return;
      }
      const track = getActiveTrack(streamRef.current);
      if (track && track.readyState === 'ended') {
        const deviceId = useScannerStore.getState().activeDeviceId;
        void openCamera(deviceId ?? undefined);
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [openCamera]);

  // Stop tracks on unmount so the camera indicator turns off when leaving
  // the scanner screen entirely (design section 7, MediaStream row).
  useEffect(() => {
    return () => {
      stopStream(streamRef.current);
    };
  }, [stopStream]);

  return { openCamera, closeCamera, switchCamera, setTorch };
}
