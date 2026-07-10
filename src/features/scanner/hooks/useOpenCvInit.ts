/**
 * `useOpenCvInit` — OpenCV `INIT` state machine + bounded-backoff retry
 * keeper hook (Fase 2.3 / capture-ux-redesign.md "Unit 2 — Extract
 * `useOpenCvInit` keeper hook"). Originally extracted out of the live
 * per-frame detection loop's own hook (`useDocumentDetection.ts`) so the
 * init/backoff/`OpenCvSlice`-mirroring machinery was independently defined
 * and testable, decoupled from that loop. Unit 6 removed the live-detection
 * loop entirely (capture is manual-only; per-page detection now runs inside
 * the deferred `'processing'` batch step, `useBatchProcess.ts`) — `
 * ScannerScreen` is this hook's sole call site today.
 *
 * Owns:
 *  - Idempotent `ensureOpenCvInit()` (one promise cached per hook instance;
 *    the underlying `WorkerClient` itself stays the module-level shared
 *    singleton via `getSharedWorkerClient()` — Slice D review fix C2 — so a
 *    real double download/INIT never happens even across remounts).
 *  - Bounded exponential backoff auto-retry on failure (1s/2s/4s, design
 *    section 4.4), plus `retryManualInit()` for an unlimited manual retry
 *    that also re-arms the automatic budget.
 *  - A hard `INIT_TIMEOUT_MS` ceiling (Slice F review fix HIGH-2) so a HUNG
 *    `init()` (never resolves nor rejects — the real reported failure mode:
 *    the OpenCV `import()` inside the worker hangs) is treated as an
 *    `OPENCV_LOAD_FAILED` rejection instead of leaving the caller stuck on
 *    `status: 'loading'` forever.
 *  - Mirrors `idle -> loading -> ready` / `error` into the store's
 *    `OpenCvSlice` (`setOpenCvStatus`) so ANY consumer can render a
 *    degraded-mode banner.
 *
 * Consumer contract: this hook must be called EXACTLY ONCE per session —
 * never from two independent call sites — since `ensureOpenCvInit()` caches
 * its in-flight promise PER HOOK INSTANCE; two instances would each cache
 * their OWN promise and could race a real second `workerClient.init()`
 * postMessage (`init()` itself is not idempotent, see `workerClient.ts`).
 * `ScannerScreen` calls it once and passes `ensureOpenCvInit`/`workerClient`
 * down to `ProcessingScreen` -> `useBatchProcess` (injected, not re-obtained
 * via a second `useOpenCvInit()` call — see that hook's own doc comment).
 * `onInitSuccess` is unused by that current caller (it existed to let the
 * old live-detection loop resume itself after a BACKGROUND retry recovered
 * OpenCV) but stays optional for any future consumer with the same need.
 */

import { useCallback, useEffect, useRef } from 'react';
import { getSharedWorkerClient, WorkerError, type WorkerClient } from '@/features/scanner/lib/workerClient';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

export interface UseOpenCvInitOptions {
  /**
   * Invoked synchronously after EVERY successful INIT attempt (the first
   * success, or a later background-auto-retry / manual recovery). Optional
   * so this hook stays usable standalone (e.g. from a future import-only
   * screen with no detection loop to resume).
   */
  readonly onInitSuccess?: () => void;
}

export interface UseOpenCvInitResult {
  /**
   * Idempotent (task 4.1.3 origin): only the first caller actually triggers
   * `workerClient.init()`; subsequent calls (re-renders, remount while a
   * previous init is still pending, StrictMode double-mount) share the same
   * in-flight promise.
   *
   * On failure (design section 4.4), schedules up to
   * `AUTO_RETRY_DELAYS_MS.length` automatic retries with bounded exponential
   * backoff. Each retry replaces the cached promise so a caller awaiting
   * `ensureOpenCvInit()` again after a failure observes the retry rather than
   * the original rejection.
   */
  readonly ensureOpenCvInit: () => Promise<void>;
  /**
   * Manual retry (design section 4.4: "reintento manual desde UI"), available
   * even after the automatic backoff budget is exhausted. Resets the
   * auto-retry counter so a manual click effectively grants a fresh backoff
   * budget for any subsequent automatic retries.
   */
  readonly retryManualInit: () => void;
  /** OpenCV init progress state, surfaced for a loading indicator (design section 4). */
  readonly initState: { readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly progress: number };
  /** The shared `WorkerClient` instance (module-level singleton — see `workerClient.ts`). */
  readonly workerClient: WorkerClient;
}

/** Bounded exponential backoff delays for automatic INIT retries (design section 4.4: "1s/2s/4s, max 3"). */
const AUTO_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/**
 * Hard ceiling for a single OpenCV `INIT` attempt (Slice F review fix HIGH-2).
 * If `workerClient.init()` neither resolves nor rejects within this window,
 * `attemptInit` treats it as an `OPENCV_LOAD_FAILED` rejection so the
 * backoff -> degraded -> banner path fires uniformly instead of the screen
 * hanging silently on `status: 'loading'` forever. 18s is generous enough to
 * cover a genuinely slow first-time ~10MB WASM download on a real connection
 * before declaring the attempt hung.
 */
const INIT_TIMEOUT_MS = 18_000;

export function useOpenCvInit(options: UseOpenCvInitOptions = {}): UseOpenCvInitResult {
  // Slice D review fix C2: reuse the shared, module-level worker singleton so
  // StrictMode remounts (or, per this hook's own consumer contract, any
  // future second call site) do not create a second worker / second OpenCV
  // download.
  const workerClient = getSharedWorkerClient();

  const initPromiseRef = useRef<Promise<void> | null>(null);
  const initStatusRef = useRef<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const initProgressRef = useRef(0);

  /** Count of automatic retries already attempted this session (design section 4.4). */
  const autoRetryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setOpenCvStatus = useScannerStore((s) => s.setOpenCvStatus);

  /** Latest onInitSuccess, held in a ref so attemptInit's closure never goes stale. */
  const onInitSuccessRef = useRef<UseOpenCvInitOptions['onInitSuccess']>(options.onInitSuccess);
  onInitSuccessRef.current = options.onInitSuccess;

  /**
   * Runs a single INIT attempt against the shared worker client, mirroring
   * progress/status into both the local refs (`initState` return value) and
   * the store's `OpenCvSlice` (design section 4.4). Does NOT retry by
   * itself — retry scheduling is `runAttemptWithAutoRetry`'s job below.
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
        // Notify the caller (via the optional `onInitSuccess` callback) so
        // it can react if this success came from a BACKGROUND retry rather
        // than its own initial `ensureOpenCvInit()` call.
        onInitSuccessRef.current?.();
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
   * Schedules ONE automatic retry (if the backoff budget allows) after
   * `attemptInit` has already failed. Recursive: the scheduled retry itself
   * calls `runAttemptWithAutoRetry` again on failure, so failure #2 schedules
   * the SECOND backoff delay, failure #3 the third, and failure #4 (after the
   * budget of `AUTO_RETRY_DELAYS_MS.length` retries is exhausted) schedules
   * nothing further — only `retryManualInit` can trigger another attempt at
   * that point.
   */
  const runAttemptWithAutoRetry = useCallback((): Promise<void> => {
    return attemptInit().catch((error: unknown) => {
      if (autoRetryCountRef.current < AUTO_RETRY_DELAYS_MS.length) {
        const delay = AUTO_RETRY_DELAYS_MS[autoRetryCountRef.current] as number;
        autoRetryCountRef.current += 1;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          // The scheduled retry's own promise chain is intentionally NOT
          // returned/awaited from this `setTimeout` callback — swallow a
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

  const ensureOpenCvInit = useCallback((): Promise<void> => {
    if (initPromiseRef.current && initStatusRef.current !== 'error') {
      return initPromiseRef.current;
    }
    const promise = runAttemptWithAutoRetry();
    initPromiseRef.current = promise;
    return promise;
  }, [runAttemptWithAutoRetry]);

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

  // Clear any pending auto-retry timer on unmount so it never fires against
  // an unmounted hook instance / closes over stale callbacks.
  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  return {
    ensureOpenCvInit,
    retryManualInit,
    initState: { status: initStatusRef.current, progress: initProgressRef.current },
    workerClient,
  };
}
