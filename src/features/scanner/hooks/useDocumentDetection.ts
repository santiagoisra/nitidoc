/**
 * `useDocumentDetection` — the live-detection loop (design section 2.1;
 * Group 4 / Slice D).
 *
 * Responsibilities (scope of this hook, per tasks.md group 4):
 *  - Own the `WorkerClient` instance and call `init()` idempotently
 *    (task 4.1.3).
 *  - Drive the loop with `requestVideoFrameCallback` (falls back to
 *    `requestAnimationFrame`), paused while `document.hidden` (task 4.1.1).
 *  - Drop-latest backpressure via `workerClient.isBusy()` — never creates a
 *    bitmap for a frame that would be dropped (task 4.1.2).
 *  - Interpolate corners (`lerpQuad`) and write them + quality to the store
 *    on every DETECT_RESULT (tasks 4.2.1 / 4.2.3).
 *  - Maintain the stability buffer and drive the auto-capture countdown
 *    (tasks 4.3.1 / 4.3.2 / 4.3.3).
 *  - Track `noDetectionSince` for the 5s "capture anyway" hint (task 4.6.1).
 *
 * Does NOT own: the overlay's rendering (that's the caller/CameraView,
 * task 4.2.2), the capture button (task 4.4.1), quality hint copy (task
 * 4.5.1), or the corner editor (Group 5 — out of scope here).
 *
 * Every `ImageBitmap` created for a detection frame is closed once the
 * worker's response for it comes back (or immediately if the frame was
 * dropped) — design section 7 memory hygiene. Drop-latest specifically does
 * NOT create a bitmap at all for a dropped frame (task 4.1.2), so there is
 * nothing to leak on the drop path.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createWorkerClient, type WorkerClient } from '@/features/scanner/lib/workerClient';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import { lerpQuad, maxCornerVariance } from '@/features/scanner/lib/detectionMath';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { Quad } from '@/shared/types/geometry';

/** `requestVideoFrameCallback` isn't in lib.dom yet on all TS lib targets; declare the minimal surface used. */
interface VideoFrameCallbackHost {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

export interface UseDocumentDetectionResult {
  /** Starts (or resumes) the detection loop against the given video element. Idempotent while already running. */
  readonly start: (video: HTMLVideoElement) => void;
  /** Stops the loop without terminating the worker (used when pausing for capture). */
  readonly stop: () => void;
  /** The shared WorkerClient instance, exposed so the capture sequence (task 4.4.2) can reuse it for warp. */
  readonly workerClient: WorkerClient;
  /** OpenCV init progress state, surfaced for a loading indicator (design section 4). */
  readonly initState: { readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly progress: number };
}

const STABILITY_BUFFER_CAPACITY = Math.max(
  2,
  Math.round(DETECTION.STABILITY_MS / 100), // ~1 sample per detected frame at a conservative 10fps floor
);

export function useDocumentDetection(): UseDocumentDetectionResult {
  const workerClientRef = useRef<WorkerClient | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const initStatusRef = useRef<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const initProgressRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const loopHandleRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const useRvfcRef = useRef(true);

  /** Stability buffer: recent (timestamp, quad) samples used by maxCornerVariance (task 4.3.1). */
  const stabilityBufferRef = useRef<Quad[]>([]);
  const stableSinceRef = useRef<number | null>(null);
  const countdownActiveRef = useRef(false);

  const setCorners = useScannerStore((s) => s.setCorners);
  const setQuality = useScannerStore((s) => s.setQuality);
  const setStability = useScannerStore((s) => s.setStability);
  const setCountdown = useScannerStore((s) => s.setCountdown);
  const setNoDetectionSince = useScannerStore((s) => s.setNoDetectionSince);

  const workerClient = useMemo(() => {
    if (!workerClientRef.current) {
      workerClientRef.current = createWorkerClient();
    }
    return workerClientRef.current;
  }, []);

  // Idempotent init (task 4.1.3): only the first caller actually triggers
  // workerClient.init(); subsequent calls (re-renders, remount while a
  // previous init is still pending) share the same in-flight promise.
  const ensureInit = useCallback((): Promise<void> => {
    if (initPromiseRef.current) {
      return initPromiseRef.current;
    }
    initStatusRef.current = 'loading';
    const promise = workerClient
      .init((progress) => {
        initProgressRef.current = progress;
      })
      .then(() => {
        initStatusRef.current = 'ready';
      })
      .catch((error: unknown) => {
        initStatusRef.current = 'error';
        throw error;
      });
    initPromiseRef.current = promise;
    return promise;
  }, [workerClient]);

  const resetStabilityTracking = useCallback(() => {
    stabilityBufferRef.current = [];
    stableSinceRef.current = null;
    countdownActiveRef.current = false;
    setCountdown(0);
    setStability(0);
  }, [setCountdown, setStability]);

  const runOneFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || !runningRef.current) {
      return;
    }

    // Drop-latest (task 4.1.2): if the worker is still busy with a prior
    // DETECT, skip this frame entirely — no bitmap is created for it.
    if (workerClient.isBusy()) {
      scheduleNextFrame();
      return;
    }

    void (async () => {
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(video, { resizeWidth: DETECTION.DOWNSCALE_WIDTH });
      } catch {
        // video not ready / zero-size frame — try again next tick.
        scheduleNextFrame();
        return;
      }

      try {
        const result = await workerClient.detect(bitmap, true);

        const autoCaptureEnabled = useScannerStore.getState().autoCaptureEnabled;
        const prevCorners = useScannerStore.getState().corners;

        if (result.corners) {
          const interpolated = lerpQuad(prevCorners, result.corners, DETECTION.INTERP_ALPHA);
          setCorners(interpolated, result.corners);
          setNoDetectionSince(null);

          // Stability buffer (task 4.3.1): append the RAW corners (not the
          // interpolated overlay ones) so variance reflects the worker's
          // actual signal, not our own smoothing.
          const buffer = stabilityBufferRef.current;
          buffer.push(result.corners);
          if (buffer.length > STABILITY_BUFFER_CAPACITY) {
            buffer.shift();
          }

          const variance = maxCornerVariance(buffer);
          const isStable = variance < DETECTION.STABILITY_VARIANCE_PX;
          setStability(isStable ? 1 : 0);

          if (isStable && autoCaptureEnabled) {
            const now = Date.now();
            if (stableSinceRef.current === null) {
              stableSinceRef.current = now;
            }
            const elapsed = now - stableSinceRef.current;
            if (elapsed >= DETECTION.STABILITY_MS) {
              countdownActiveRef.current = true;
            }
          } else {
            // Variance exceeded the threshold before the countdown
            // completed (task 4.3.2): cancel and start waiting for a new
            // stability window.
            stableSinceRef.current = null;
            if (countdownActiveRef.current) {
              countdownActiveRef.current = false;
              setCountdown(0);
            }
          }
        } else {
          // No valid contour this frame (scanner spec "Contorno... no
          // convexo..."): fade out the overlay, cancel any in-flight
          // stability/countdown, and start/continue the no-detection timer.
          setCorners(null, null);
          resetStabilityTracking();

          const noDetectionSince = useScannerStore.getState().noDetectionSince;
          if (noDetectionSince === null) {
            setNoDetectionSince(Date.now());
          }
        }

        if (result.quality) {
          setQuality(result.quality);
        }
      } catch {
        // DETECT_FAILED / worker error mid-flight — treat like "no
        // detection" for this frame rather than crashing the loop.
        setCorners(null, null);
      } finally {
        bitmap?.close();
        scheduleNextFrame();
      }
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
    })();
  }, [resetStabilityTracking, setCorners, setCountdown, setNoDetectionSince, setQuality, setStability, workerClient]);

  const scheduleNextFrame = useCallback(() => {
    if (!runningRef.current) {
      return;
    }
    const video = videoRef.current;
    if (document.hidden || !video) {
      // Paused while hidden (scanner spec "Pestaña oculta..."); resumed by
      // the visibilitychange listener below without needing to reopen the
      // camera or re-init the worker.
      loopHandleRef.current = null;
      return;
    }

    const host = video as unknown as VideoFrameCallbackHost;
    if (useRvfcRef.current && typeof host.requestVideoFrameCallback === 'function') {
      loopHandleRef.current = host.requestVideoFrameCallback(runOneFrame);
    } else {
      useRvfcRef.current = false;
      loopHandleRef.current = requestAnimationFrame(runOneFrame);
    }
  }, [runOneFrame]);

  const stop = useCallback(() => {
    runningRef.current = false;
    const video = videoRef.current;
    if (loopHandleRef.current !== null) {
      if (video && useRvfcRef.current) {
        (video as unknown as VideoFrameCallbackHost).cancelVideoFrameCallback?.(loopHandleRef.current);
      } else {
        cancelAnimationFrame(loopHandleRef.current);
      }
      loopHandleRef.current = null;
    }
  }, []);

  const start = useCallback(
    (video: HTMLVideoElement) => {
      videoRef.current = video;
      if (runningRef.current) {
        return;
      }
      runningRef.current = true;
      void ensureInit().then(() => {
        if (runningRef.current) {
          scheduleNextFrame();
        }
      });
    },
    [ensureInit, scheduleNextFrame],
  );

  // Resume the loop when the tab becomes visible again (scanner spec
  // "Pestaña oculta durante la deteccion en vivo"): scheduleNextFrame()
  // already no-ops while hidden, so the only extra step needed on becoming
  // visible is to kick the loop again if it's still supposed to be running.
  useEffect(() => {
    function handleVisibilityChange(): void {
      if (!document.hidden && runningRef.current && loopHandleRef.current === null) {
        scheduleNextFrame();
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [scheduleNextFrame]);

  // Stop the loop (but NOT terminate the worker — a later mount within the
  // same session should reuse init) on unmount.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const isCountdownActive = countdownActiveRef.current;
  useEffect(() => {
    // Countdown ticks down 3, 2, 1 once stability + auto-capture triggers
    // it (task 4.3.2). This effect only flips the visible countdown state;
    // the actual capture trigger is wired by the caller via CaptureButton
    // integration (task 4.4.2), which watches `countdown` reaching 0 after
    // having been > 0.
    if (!isCountdownActive) {
      return;
    }
    setCountdown(3);
    const timers = [
      setTimeout(() => setCountdown(2), 1000),
      setTimeout(() => setCountdown(1), 2000),
      setTimeout(() => setCountdown(0), 3000),
    ];
    return () => {
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCountdownActive]);

  return {
    start,
    stop,
    workerClient,
    initState: { status: initStatusRef.current, progress: initProgressRef.current },
  };
}
