/**
 * `useDocumentDetection` — the live-detection loop (design section 2.1;
 * Group 4 / Slice D).
 *
 * Responsibilities (scope of this hook, per tasks.md group 4):
 *  - Use the shared module-level `WorkerClient` singleton and call `init()`
 *    idempotently (task 4.1.3; Slice D review fix C2 — see workerClient.ts).
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
 *
 * Auto-capture countdown (Slice D review fix C1): the countdown is driven
 * IMPERATIVELY with a timer chain, not via a `useEffect` observing a ref.
 * When a sustained stability window completes inside `runOneFrame`, the hook
 * arms a single timer chain that writes `countdown` 3 -> 2 -> 1 -> 0 into the
 * store (reactive, so the FAB ring reflects it) and, on reaching 0, fires the
 * caller-supplied capture callback. Losing stability, no detection, toggling
 * auto-capture off, or unmount all cancel the chain and reset `countdown`.
 */

import { useCallback, useEffect, useRef } from 'react';
import { getSharedWorkerClient, type WorkerClient } from '@/features/scanner/lib/workerClient';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import { lerpQuad, maxCornerVariance } from '@/features/scanner/lib/detectionMath';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { Quad } from '@/shared/types/geometry';

/** `requestVideoFrameCallback` isn't in lib.dom yet on all TS lib targets; declare the minimal surface used. */
interface VideoFrameCallbackHost {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

/** A timestamped stability sample (Slice D review fix M1 — time-windowed, not count-windowed). */
interface StabilitySample {
  readonly t: number;
  readonly quad: Quad;
}

export interface UseDocumentDetectionOptions {
  /**
   * Invoked when a sustained stability window completes and the auto-capture
   * countdown reaches 0. The caller (ScannerScreen) runs the capture sequence.
   * Optional so the hook stays usable in isolation / tests that only assert
   * countdown state.
   */
  readonly onAutoCapture?: () => void;
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

/** Interval between countdown ticks (3 -> 2 -> 1 -> 0), in ms. */
const COUNTDOWN_TICK_MS = 1000;

export function useDocumentDetection(
  options: UseDocumentDetectionOptions = {},
): UseDocumentDetectionResult {
  // Slice D review fix C2: reuse the shared, module-level worker singleton so
  // StrictMode remounts do not create a second worker / second OpenCV download.
  const workerClient = getSharedWorkerClient();

  const initPromiseRef = useRef<Promise<void> | null>(null);
  const initStatusRef = useRef<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const initProgressRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const loopHandleRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const useRvfcRef = useRef(true);

  /** Stability buffer: recent timestamped samples used by maxCornerVariance (task 4.3.1; fix M1). */
  const stabilityBufferRef = useRef<StabilitySample[]>([]);
  const stableSinceRef = useRef<number | null>(null);

  /** Imperative countdown timer handles (fix C1). Non-empty iff a countdown is currently armed. */
  const countdownTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /** Latest onAutoCapture, held in a ref so the loop callback never goes stale. */
  const onAutoCaptureRef = useRef<UseDocumentDetectionOptions['onAutoCapture']>(options.onAutoCapture);
  onAutoCaptureRef.current = options.onAutoCapture;

  const setCorners = useScannerStore((s) => s.setCorners);
  const setQuality = useScannerStore((s) => s.setQuality);
  const setStability = useScannerStore((s) => s.setStability);
  const setCountdown = useScannerStore((s) => s.setCountdown);
  const setNoDetectionSince = useScannerStore((s) => s.setNoDetectionSince);

  // Idempotent init (task 4.1.3): only the first caller actually triggers
  // workerClient.init(); subsequent calls (re-renders, remount while a
  // previous init is still pending, StrictMode double-mount sharing the same
  // singleton) share the same in-flight promise. The promise ref is module-
  // independent per hook instance, but because the worker is shared, a second
  // instance's init() also resolves against the same already-initialized
  // worker without triggering a second OpenCV download.
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

  /** Cancels any armed auto-capture countdown and resets the reactive countdown state (fix C1 / H2). */
  const cancelCountdown = useCallback(() => {
    if (countdownTimersRef.current.length > 0) {
      countdownTimersRef.current.forEach(clearTimeout);
      countdownTimersRef.current = [];
      setCountdown(0);
    }
  }, [setCountdown]);

  const resetStabilityTracking = useCallback(() => {
    stabilityBufferRef.current = [];
    stableSinceRef.current = null;
    cancelCountdown();
    setStability(0);
  }, [cancelCountdown, setStability]);

  /**
   * Arms the imperative auto-capture countdown (fix C1). Idempotent: if a
   * countdown is already running, this is a no-op so a sustained-stable stream
   * of frames cannot re-arm (and reset) it every frame. Writes 3 -> 2 -> 1 -> 0
   * into the reactive store countdown; at 0 it fires `onAutoCapture` and clears
   * the armed handles.
   */
  const armCountdown = useCallback(() => {
    if (countdownTimersRef.current.length > 0) {
      return; // already counting down — do not re-arm
    }
    setCountdown(3);
    const timers = [
      setTimeout(() => setCountdown(2), COUNTDOWN_TICK_MS),
      setTimeout(() => setCountdown(1), COUNTDOWN_TICK_MS * 2),
      setTimeout(() => {
        setCountdown(0);
        // The chain has completed; drop the handles so a subsequent stable
        // window can arm a fresh countdown, then fire the capture callback.
        countdownTimersRef.current = [];
        onAutoCaptureRef.current?.();
      }, COUNTDOWN_TICK_MS * 3),
    ];
    countdownTimersRef.current = timers;
  }, [setCountdown]);

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

          // Stability buffer (task 4.3.1; fix M1): append the RAW corners (not
          // the interpolated overlay ones) with the frame timestamp, then drop
          // samples older than STABILITY_MS so the variance window is a real
          // time window regardless of frame rate (60fps vs 10fps).
          const now = Date.now();
          const buffer = stabilityBufferRef.current;
          buffer.push({ t: now, quad: result.corners });
          const windowStart = now - DETECTION.STABILITY_MS;
          while (buffer.length > 0 && (buffer[0] as StabilitySample).t < windowStart) {
            buffer.shift();
          }

          const variance = maxCornerVariance(buffer.map((sample) => sample.quad));
          const isStable = variance < DETECTION.STABILITY_VARIANCE_PX;
          setStability(isStable ? 1 : 0);

          if (isStable && autoCaptureEnabled) {
            if (stableSinceRef.current === null) {
              stableSinceRef.current = now;
            }
            const elapsed = now - stableSinceRef.current;
            if (elapsed >= DETECTION.STABILITY_MS) {
              // Sustained stability reached — arm the countdown (idempotent).
              armCountdown();
            }
          } else {
            // Variance exceeded the threshold before the countdown completed
            // (task 4.3.2): cancel the countdown and wait for a new window.
            stableSinceRef.current = null;
            cancelCountdown();
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
  }, [
    armCountdown,
    cancelCountdown,
    resetStabilityTracking,
    setCorners,
    setNoDetectionSince,
    setQuality,
    setStability,
    workerClient,
  ]);

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

  // Cancel any armed auto-capture countdown the moment auto-capture is toggled
  // off (Slice D review fix H2). Subscribing directly to the store (rather than
  // re-rendering on `autoCaptureEnabled`) keeps the loop's callbacks stable.
  useEffect(() => {
    const unsubscribe = useScannerStore.subscribe((state, prev) => {
      if (prev.autoCaptureEnabled && !state.autoCaptureEnabled) {
        stableSinceRef.current = null;
        cancelCountdown();
      }
    });
    return unsubscribe;
  }, [cancelCountdown]);

  // Stop the loop and cancel any pending countdown timers on unmount. The
  // shared worker is deliberately NOT terminated here (fix C2): a later mount
  // within the same session reuses the singleton and its completed init().
  useEffect(() => {
    return () => {
      stop();
      cancelCountdown();
    };
  }, [stop, cancelCountdown]);

  return {
    start,
    stop,
    workerClient,
    initState: { status: initStatusRef.current, progress: initProgressRef.current },
  };
}
