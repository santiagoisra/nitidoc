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
 *
 * OpenCV load state machine + backoff (Group 6 / Slice F, task 6.6.1; design
 * section 4.4): `ensureInit` now also mirrors `idle -> loading -> ready` /
 * `error` into `OpenCvSlice` (`setOpenCvStatus`) so the UI can render a
 * degraded-mode banner — this state previously lived ONLY in local refs,
 * invisible outside this hook. On `INIT` failure, up to
 * `AUTO_RETRY_DELAYS_MS.length` automatic retries are attempted with bounded
 * exponential backoff (1s/2s/4s); once exhausted, the status stays `error`
 * and `retryManualInit` (returned from this hook) lets the UI retry on
 * demand indefinitely. A successful retry (auto or manual) transitions back
 * to `ready`, which is the "OpenCV se recupera" case Group 5's `CornerEditor`
 * already handles transparently — it just calls `workerClient.warp` again,
 * which now succeeds once `cv` is loaded in the worker.
 *
 * INIT hang timeout (Slice F review fix HIGH-2): `workerClient.init()` can
 * fail in TWO shapes — it can REJECT (`OPENCV_LOAD_FAILED`, already handled by
 * the backoff/degraded machinery above), or it can HANG (never resolve nor
 * reject — the real reported failure mode: the OpenCV `import()` inside the
 * worker never settles). A hang would leave `initStatusRef` stuck on
 * `'loading'` forever: `runAttemptWithAutoRetry`'s `.catch` never fires (no
 * rejection), the store status never flips to `'error'`, and the degraded
 * banner never appears — a semi-dead screen (camera alive, no overlay, no
 * banner, no explanation). `attemptInit` therefore races `init()` against a
 * hard `INIT_TIMEOUT_MS` timer: if init has not settled by then, the timeout
 * REJECTS with `OPENCV_LOAD_FAILED`, which the existing backoff -> degraded ->
 * banner path handles UNIFORMLY at every call site (live loop AND import). The
 * timer is always cleared on whichever side of the race settles first, so it
 * never leaks.
 *
 * No-OffscreenCanvas fallback (Group 6 / Slice F, task 6.7.1; design section
 * 8): `runOneFrame` reads `CameraSlice.offscreenSupported` on every frame and
 * routes DETECT through `workerClient.detectImageData` (extracting pixels via
 * a main-thread `<canvas>`, `bitmapToImageData`) instead of transferring the
 * `ImageBitmap` when that capability is absent, so the worker's own
 * `OffscreenCanvas`-based extraction (which may equally be absent in that
 * environment) is never required.
 */

import { useCallback, useEffect, useRef } from 'react';
import { getSharedWorkerClient, WorkerError, type WorkerClient } from '@/features/scanner/lib/workerClient';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import { lerpQuad, maxCornerStdDevPx } from '@/features/scanner/lib/detectionMath';
import { bitmapToImageData } from '@/features/scanner/lib/mainThreadImageData';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { QualityMetrics, Quad } from '@/shared/types/geometry';

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
  /**
   * Manually retries `INIT` after automatic backoff has been exhausted
   * (design section 4.4 "reintento manual desde UI"). Safe to call even
   * while a retry is already in flight (idempotent, same as `ensureInit`).
   */
  readonly retryManualInit: () => void;
  /**
   * Triggers OpenCV `INIT` (idempotent, with the SAME status-mirroring +
   * backoff-retry machinery as the live-detection loop's own internal
   * trigger) without needing a `<video>` element or a running loop. Added
   * for the import-fallback pipeline (task 6.3.2): that path has no camera
   * stream at all, so it cannot rely on `start()` to have already kicked
   * off `INIT` — see the fix note in ScannerScreen.tsx's import handler for
   * the bug this closes (NOT_INITIALIZED on every import-fallback DETECT/WARP).
   */
  readonly ensureOpenCvInit: () => Promise<void>;
}

/** Interval between countdown ticks (3 -> 2 -> 1 -> 0), in ms. */
const COUNTDOWN_TICK_MS = 1000;

/** Bounded exponential backoff delays for automatic INIT retries (design section 4.4: "1s/2s/4s, max 3"). */
const AUTO_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/**
 * Hard ceiling for a single OpenCV `INIT` attempt (Slice F review fix HIGH-2).
 * If `workerClient.init()` neither resolves nor rejects within this window
 * (the real reported failure mode: the OpenCV `import()` inside the worker
 * hangs and never settles), `attemptInit` treats it as an `OPENCV_LOAD_FAILED`
 * rejection so the backoff -> degraded -> banner path fires uniformly instead
 * of the screen hanging silently on `status: 'loading'` forever. 18s is
 * generous enough to cover a genuinely slow first-time ~10MB WASM download on
 * a real connection before declaring the attempt hung.
 */
const INIT_TIMEOUT_MS = 18_000;

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

  /** Stability buffer: recent timestamped samples used by maxCornerStdDevPx (task 4.3.1; fix M1). */
  const stabilityBufferRef = useRef<StabilitySample[]>([]);
  const stableSinceRef = useRef<number | null>(null);

  /**
   * Consecutive-blurry-frame counter (Fase 2.2 punch-list item 1): the raw
   * per-frame `isBlurry` signal is noisy (a single motion-blurred or
   * transiently out-of-focus frame shouldn't flash the hint), so the hint
   * only turns on after `DETECTION.BLUR_PERSIST_FRAMES` consecutive blurry
   * DETECT results, and turns off immediately on the first sharp one.
   */
  const blurryStreakRef = useRef(0);

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
  const setOpenCvStatus = useScannerStore((s) => s.setOpenCvStatus);

  /** Count of automatic retries already attempted this session (task 6.6.1 / design section 4.4). */
  const autoRetryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Forward reference to `scheduleNextFrame` (defined further down, after
   * `runOneFrame`), set via the effect right after its own definition. Needed
   * because `attemptInit`'s success handler (defined BEFORE `scheduleNextFrame`
   * in this file) must be able to resume a stalled loop on OpenCV recovery
   * (task 6.6.1) without introducing a circular `useCallback` dependency.
   */
  const scheduleNextFrameRef = useRef<() => void>(() => {});

  /**
   * Runs a single INIT attempt against the shared worker client, mirroring
   * progress/status into both the local refs (initState return value) and
   * the store's `OpenCvSlice` (task 6.6.1). Does NOT retry by itself —
   * retry scheduling is `scheduleAutoRetry`'s job below.
   */
  const attemptInit = useCallback((): Promise<void> => {
    initStatusRef.current = 'loading';
    setOpenCvStatus({ status: 'loading' });

    // HIGH-2: race the (possibly hanging) init against a hard timeout. The
    // timer handle lives in this closure so both the success and the failure
    // arms below can clear it — a resolved/rejected init must never leave the
    // timer armed to fire later (which would surface a spurious
    // OPENCV_LOAD_FAILED after a genuine success, or leak the timer).
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const clearInitTimeout = (): void => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };
    const initTimeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null;
        reject(
          new WorkerError(
            'OPENCV_LOAD_FAILED',
            `OpenCV init did not settle within ${INIT_TIMEOUT_MS}ms (worker init hung).`,
          ),
        );
      }, INIT_TIMEOUT_MS);
    });

    const promise = Promise.race([
      workerClient.init((progress) => {
        initProgressRef.current = progress;
        setOpenCvStatus({ progress, progressIndeterminate: progress <= 0 });
      }),
      initTimeout,
    ])
      .then(() => {
        clearInitTimeout();
        initStatusRef.current = 'ready';
        autoRetryCountRef.current = 0;
        setOpenCvStatus({ status: 'ready', progress: 1, progressIndeterminate: false, lastError: null });
        // Task 6.6.1 recovery: if `start()` was already called and is
        // "supposed to be running" but never got to schedule a frame because
        // the FIRST `ensureInit()` call rejected, a later successful attempt
        // (background auto-retry or `retryManualInit`) must resume the loop
        // itself — nothing else re-invokes `scheduleNextFrame` in that case.
        // Guarded by `loopHandleRef` so this never double-schedules on top of
        // an already-running loop (e.g. the ordinary first-success path via
        // `start()`'s own `.then()` below, or a loop that paused only because
        // the tab is hidden, which must stay paused until visible again).
        if (runningRef.current && loopHandleRef.current === null && !document.hidden) {
          scheduleNextFrameRef.current();
        }
      })
      .catch((error: unknown) => {
        clearInitTimeout();
        initStatusRef.current = 'error';
        const message = error instanceof Error ? error.message : 'Unknown OpenCV load failure.';
        setOpenCvStatus({ status: 'error', lastError: message });
        throw error;
      });
    initPromiseRef.current = promise;
    return promise;
  }, [setOpenCvStatus, workerClient]);

  /**
   * Idempotent init (task 4.1.3): only the first caller actually triggers
   * workerClient.init(); subsequent calls (re-renders, remount while a
   * previous init is still pending, StrictMode double-mount sharing the same
   * singleton) share the same in-flight promise. The promise ref is module-
   * independent per hook instance, but because the worker is shared, a second
   * instance's init() also resolves against the same already-initialized
   * worker without triggering a second OpenCV download.
   *
   * On failure (task 6.6.1 / design section 4.4), schedules up to
   * `AUTO_RETRY_DELAYS_MS.length` automatic retries with bounded exponential
   * backoff. Each retry replaces `initPromiseRef` with a fresh attempt so a
   * caller awaiting `ensureInit()` again after a failure observes the retry
   * rather than the original rejection. Callers that don't re-invoke
   * `ensureInit` (e.g. the loop already gave up) still see the store's
   * `opencv.status` flip to `ready` reactively if a background retry
   * succeeds.
   */
  /**
   * Schedules ONE automatic retry (if the backoff budget allows) after
   * `attemptInit` has already failed. Recursive: the scheduled retry itself
   * calls `runAttemptWithAutoRetry` again on failure, so failure #2 schedules
   * the SECOND backoff delay, failure #3 the third, and failure #4 (after the
   * budget of `AUTO_RETRY_DELAYS_MS.length` retries is exhausted) schedules
   * nothing further — only `retryManualInit` can trigger another attempt at
   * that point. This is the piece the original single `.catch` on `ensureInit`
   * was missing: that only ever scheduled the FIRST retry, since the
   * retry's own `attemptInit()` call had no failure handler chasing it.
   */
  const runAttemptWithAutoRetry = useCallback((): Promise<void> => {
    return attemptInit().catch((error: unknown) => {
      if (autoRetryCountRef.current < AUTO_RETRY_DELAYS_MS.length) {
        const delay = AUTO_RETRY_DELAYS_MS[autoRetryCountRef.current] as number;
        autoRetryCountRef.current += 1;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          // The scheduled retry's own promise chain is intentionally NOT
          // returned/awaited from this `setTimeout` callback (a timer
          // callback can't be "returned into" anything) — swallow a
          // still-failing retry's rejection here explicitly so it never
          // becomes an unhandled promise rejection. The failure is already
          // fully surfaced via `OpenCvSlice.status`/`lastError`, and a
          // FURTHER retry (if the budget allows) is scheduled by this same
          // recursive call before the rejection reaches here.
          runAttemptWithAutoRetry().catch(() => {});
        }, delay);
      }
      throw error;
    });
  }, [attemptInit]);

  const ensureInit = useCallback((): Promise<void> => {
    if (initPromiseRef.current && initStatusRef.current !== 'error') {
      return initPromiseRef.current;
    }
    const promise = runAttemptWithAutoRetry();
    initPromiseRef.current = promise;
    return promise;
  }, [runAttemptWithAutoRetry]);

  /**
   * Manual retry (design section 4.4: "reintento manual desde UI"),
   * available even after the automatic backoff budget is exhausted. Resets
   * the auto-retry counter so a manual click effectively grants a fresh
   * backoff budget for any subsequent automatic retries. Routed through
   * `runAttemptWithAutoRetry` (not a bare `attemptInit()`) so a manual retry
   * that ALSO fails re-arms the automatic backoff chain instead of silently
   * giving up after one attempt; the trailing `.catch(() => {})` prevents an
   * unhandled rejection warning (the failure is already fully surfaced via
   * `OpenCvSlice.status`/`lastError`, same as `start()`'s own catch above).
   */
  const retryManualInit = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    autoRetryCountRef.current = 0;
    const promise = runAttemptWithAutoRetry();
    initPromiseRef.current = promise;
    promise.catch(() => {});
  }, [runAttemptWithAutoRetry]);

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
        // Task 6.7.1 (design section 8): when the main thread has no
        // `OffscreenCanvas`, extract `ImageData` here and send it directly
        // (`detectImageData`) instead of transferring the bitmap — the
        // worker's own `OffscreenCanvas`-based extraction may not exist
        // either in that environment. `offscreenSupported` is read fresh
        // from the store each frame rather than captured in a closure,
        // since Slice C sets it once at camera-open time.
        const offscreenSupported = useScannerStore.getState().offscreenSupported;
        const result = offscreenSupported
          ? await workerClient.detect(bitmap, true)
          : await workerClient.detectImageData(bitmapToImageData(bitmap), true);
        // `detectImageData` already closed `bitmap` inside `bitmapToImageData`
        // — clear the local reference so the `finally` below's `bitmap?.close()`
        // does not double-close it.
        if (!offscreenSupported) {
          bitmap = null;
        }

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

          const stdDevPx = maxCornerStdDevPx(buffer.map((sample) => sample.quad));
          const isStable = stdDevPx < DETECTION.STABILITY_STDDEV_PX;
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
          // Debounce the blur hint (Fase 2.2 punch-list item 1): only
          // report `isBlurry: true` after a sustained run of blurry frames;
          // a single sharp frame resets the streak immediately.
          blurryStreakRef.current = result.quality.isBlurry ? blurryStreakRef.current + 1 : 0;
          const debouncedQuality: QualityMetrics = {
            ...result.quality,
            isBlurry: blurryStreakRef.current >= DETECTION.BLUR_PERSIST_FRAMES,
          };
          setQuality(debouncedQuality);
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

  // Keep the forward-reference ref pointing at the latest `scheduleNextFrame`
  // so `attemptInit`'s success handler (defined earlier in this file) can
  // resume a stalled loop on OpenCV recovery (task 6.6.1) without a circular
  // `useCallback` dependency.
  scheduleNextFrameRef.current = scheduleNextFrame;

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
      void ensureInit()
        .then(() => {
          if (runningRef.current) {
            scheduleNextFrame();
          }
        })
        .catch(() => {
          // Task 6.6.1: INIT failing (even after exhausting automatic
          // retries) must not become an unhandled rejection — the failure is
          // already surfaced reactively via `OpenCvSlice.status === 'error'`
          // (read by ScannerScreen's degraded-mode banner). The loop stays
          // un-started for now, but `runningRef` is intentionally left
          // `true`: `attemptInit`'s own success handler (via
          // `scheduleNextFrameRef`) is what actually resumes the loop once a
          // LATER attempt (background auto-retry or `retryManualInit`)
          // succeeds — see that handler's comment for why gating on
          // `runningRef.current` there is exactly the "was this loop
          // supposed to be running" check needed to resume automatically
          // without any caller having to call `start()` again.
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
  // The pending auto-retry timer (task 6.6.1), if any, IS cleared here: it
  // closes over this hook instance's callbacks, and a later remount's
  // `ensureInit`/`retryManualInit` schedules its own retry against the
  // still-shared worker/store state instead.
  useEffect(() => {
    return () => {
      stop();
      cancelCountdown();
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [stop, cancelCountdown]);

  return {
    start,
    stop,
    workerClient,
    initState: { status: initStatusRef.current, progress: initProgressRef.current },
    retryManualInit,
    ensureOpenCvInit: ensureInit,
  };
}
