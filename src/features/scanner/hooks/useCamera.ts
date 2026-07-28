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

  /**
   * Mounted guard (C1 fix). If the component unmounts while `getUserMedia`
   * is still pending, the promise resolves after cleanup has already run —
   * without this guard the resolved stream would be assigned to
   * `streamRef.current` and never stopped, leaking the camera indicator.
   */
  const mountedRef = useRef(true);

  /**
   * Generation token (C2/H1 fix). Incremented at the start of every
   * `openCamera` call. If a newer call starts before an older one's
   * `getUserMedia` resolves (StrictMode double-invoke, or a fast
   * `switchCamera`), the stale call recognizes it is no longer current and
   * stops its own stream instead of racing to assign `streamRef.current`.
   */
  const generationRef = useRef(0);

  const setStream = useScannerStore((s) => s.setStream);
  const setDevices = useScannerStore((s) => s.setDevices);
  const setActiveDeviceId = useScannerStore((s) => s.setActiveDeviceId);
  const setRealResolution = useScannerStore((s) => s.setRealResolution);
  const setTorchSupported = useScannerStore((s) => s.setTorchSupported);
  const setTorchOn = useScannerStore((s) => s.setTorchOn);
  const setPermission = useScannerStore((s) => s.setPermission);
  const setCaptureCapabilities = useScannerStore((s) => s.setCaptureCapabilities);
  const setLastCameraError = useScannerStore((s) => s.setLastCameraError);
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
      // Claim this call's generation and stop whatever stream is currently
      // held BEFORE requesting a new one (C2/H1 fix). Serializing on the
      // token means that when several opens race (StrictMode double-mount,
      // rapid switchCamera), only the most recent one is allowed to win;
      // every earlier resolution below detects it has been superseded and
      // stops its own stream instead of leaking it.
      const myGeneration = ++generationRef.current;
      stopStream(streamRef.current);
      streamRef.current = null;

      setCaptureCapabilities({
        imageCaptureSupported: detectImageCaptureSupport(),
        offscreenSupported: detectOffscreenCanvasSupport(),
      });

      const constraints: MediaStreamConstraints = {
        video: deviceId != null ? { ...VIDEO_CONSTRAINTS, deviceId: { exact: deviceId } } : VIDEO_CONSTRAINTS,
      };

      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        // Superseded by a newer openCamera/switchCamera call, or the
        // component unmounted while this was pending: discard this stream
        // without ever assigning it, so it can't be an orphaned leak.
        if (myGeneration !== generationRef.current || !mountedRef.current) {
          stopStream(stream);
          return;
        }

        streamRef.current = stream;
        setStream(stream);
        setPermission('granted');
        setLastCameraError(null);

        const track = getActiveTrack(stream);
        if (track) {
          applyTrackState(track);
          setActiveDeviceId(track.getSettings().deviceId ?? deviceId ?? null);
        }

        await refreshDeviceList();
      } catch (error) {
        if (myGeneration !== generationRef.current || !mountedRef.current) {
          // A superseded/unmounted call failing is not this call's problem
          // to report — the winning call (or nothing, post-unmount) owns
          // the visible state.
          return;
        }

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

        // M1 fix: every other failure (NotReadableError, OverconstrainedError,
        // AbortError, etc.) used to `throw`, which becomes an unhandled
        // promise rejection wherever the caller does `void openCamera()`
        // (ScannerScreen does exactly that) and leaves the UI blank with no
        // feedback. Surface it as visible state instead of rejecting.
        const message = error instanceof Error ? error.message : 'Unknown camera error';
        setLastCameraError(message);
      }
    },
    [
      applyTrackState,
      refreshDeviceList,
      setActiveDeviceId,
      setCaptureCapabilities,
      setDevices,
      setLastCameraError,
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
      try {
        await track.applyConstraints({ advanced: advanced as MediaTrackConstraintSet[] });
        setTorchOn(on);
      } catch {
        // M3 fix: applyConstraints can reject (device busy, constraint not
        // actually honorable despite advertising the capability, etc). The
        // caller in ScannerScreen does `void setTorch(...)`, so letting this
        // propagate becomes an unhandled rejection. Swallow it and leave
        // `torchOn` untouched — the state must not claim a toggle succeeded
        // when the hardware rejected it.
      }
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

  // H2 fix: if the active device is unplugged (or otherwise disappears),
  // `devicechange` fires. Re-enumerate and reconcile `activeDeviceId` so the
  // CameraSelector <select> doesn't keep pointing at a device that no
  // longer exists. This intentionally does NOT re-open the camera — that
  // would be a surprising side effect for something that just refreshes a
  // list; re-acquisition on track death is already handled separately via
  // visibilitychange/track.readyState above.
  useEffect(() => {
    function handleDeviceChange(): void {
      void (async () => {
        try {
          const allDevices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = allDevices.filter(isVideoInput);
          setDevices(videoInputs);

          const currentActiveId = useScannerStore.getState().activeDeviceId;
          const stillPresent = videoInputs.some((device) => device.deviceId === currentActiveId);
          if (currentActiveId != null && !stillPresent) {
            setActiveDeviceId(null);
          }
        } catch {
          // enumerateDevices() failing here is non-fatal — same reasoning
          // as refreshDeviceList: leave devices as-is rather than throwing
          // from an event listener.
        }
      })();
    }

    // `navigator.mediaDevices` is UNDEFINED outside a secure context —
    // browsers gate the whole Media Devices API behind HTTPS (a plain
    // `http://` LAN IP does not qualify; only `localhost` is exempt).
    // Dereferencing it unconditionally threw during this effect and unwound
    // the entire React tree, so the app painted a blank screen instead of
    // degrading to the import-only flow that already exists for
    // camera-less environments (`ImportFallback`).
    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
    if (!mediaDevices) return;

    mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [setActiveDeviceId, setDevices]);

  // Mounted guard (C1 fix): flips false on unmount so any getUserMedia
  // promise still pending at that point knows not to assign its stream.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Stop tracks on unmount so the camera indicator turns off when leaving
  // the scanner screen entirely (design section 7, MediaStream row).
  useEffect(() => {
    return () => {
      stopStream(streamRef.current);
    };
  }, [stopStream]);

  return { openCamera, closeCamera, switchCamera, setTorch };
}
