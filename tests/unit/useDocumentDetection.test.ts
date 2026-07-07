import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectResponse } from '@/features/scanner/worker/messages';
import type { WorkerClient } from '@/features/scanner/lib/workerClient';
import type { Quad } from '@/shared/types/geometry';

/**
 * Slice D adversarial review regression tests for useDocumentDetection.
 *
 * Focus:
 *  - C1: the auto-capture countdown MUST actually progress 3 -> 2 -> 1 -> 0
 *    and fire the capture callback at 0 under sustained stability. Against the
 *    OLD hook (which flipped a ref inside runOneFrame and delegated the
 *    countdown to a useEffect that never saw the ref edge) this test fails:
 *    countdown never reaches 0 and onAutoCapture is never called.
 *  - C1 cancel: losing stability mid-countdown CANCELS it (no capture).
 *  - M1: the stability window is measured by TIMESTAMPS over STABILITY_MS, not
 *    by a fixed sample count. Feeding many identical frames in a burst shorter
 *    than STABILITY_MS must NOT reach stable-long-enough; only elapsed real
 *    time crossing STABILITY_MS does.
 *
 * The worker singleton and createImageBitmap are mocked so the loop runs fully
 * in fake time with no browser dependency.
 */

const STABLE_QUAD: Quad = [
  { x: 10, y: 10 },
  { x: 100, y: 10 },
  { x: 100, y: 140 },
  { x: 10, y: 140 },
];

/** A quad far from STABLE_QUAD so variance blows past the stability threshold. */
const MOVED_QUAD: Quad = [
  { x: 200, y: 200 },
  { x: 320, y: 200 },
  { x: 320, y: 360 },
  { x: 200, y: 360 },
];

// The queue of DetectResponses the fake worker will return, one per detect().
let detectQueue: DetectResponse[];
let isBusyValue: boolean;

const fakeWorkerClient: WorkerClient = {
  init: vi.fn(async () => {}),
  detect: vi.fn(async (): Promise<DetectResponse> => {
    const next = detectQueue.shift();
    if (!next) {
      return { type: 'DETECT_RESULT', id: 0, corners: null, quality: null };
    }
    return next;
  }),
  detectImageData: vi.fn(async (): Promise<DetectResponse> => {
    const next = detectQueue.shift();
    if (!next) {
      return { type: 'DETECT_RESULT', id: 0, corners: null, quality: null };
    }
    return next;
  }),
  warp: vi.fn(),
  isBusy: vi.fn(() => isBusyValue),
  terminate: vi.fn(),
};

// `WorkerError` is a real class the hook now imports (HIGH-2: it constructs a
// `WorkerError('OPENCV_LOAD_FAILED', ...)` when the init race times out), so
// the mock MUST re-export it (or a compatible stand-in) rather than dropping
// it. Re-export the genuine class via importActual so `instanceof`/`.code`
// semantics stay intact.
vi.mock('@/features/scanner/lib/workerClient', async () => {
  const actual = await vi.importActual<typeof import('@/features/scanner/lib/workerClient')>(
    '@/features/scanner/lib/workerClient',
  );
  return {
    ...actual,
    getSharedWorkerClient: () => fakeWorkerClient,
    terminateSharedWorkerClient: vi.fn(),
  };
});

import { useDocumentDetection } from '@/features/scanner/hooks/useDocumentDetection';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';

function detectResult(corners: Quad | null): DetectResponse {
  return { type: 'DETECT_RESULT', id: 0, corners, quality: null };
}

/**
 * Fake <video> element good enough for the hook: it exposes rVFC so the loop
 * schedules through it, and we drive frames manually via the captured callback.
 */
interface FakeVideo {
  el: HTMLVideoElement;
  /** Runs exactly one scheduled frame callback (the loop's runOneFrame). */
  tick: () => void;
  pending: (() => void) | null;
}

function createFakeVideo(): FakeVideo {
  const fake: FakeVideo = {
    pending: null,
    tick: () => {
      const cb = fake.pending;
      fake.pending = null;
      cb?.();
    },
    el: {} as HTMLVideoElement,
  };
  Object.assign(fake.el, {
    requestVideoFrameCallback: (cb: () => void): number => {
      fake.pending = cb;
      return 1;
    },
    cancelVideoFrameCallback: (): void => {
      fake.pending = null;
    },
  });
  return fake;
}

/** Drives one full loop iteration: schedule -> run -> await the async detect body. */
async function runFrame(video: FakeVideo): Promise<void> {
  await act(async () => {
    video.tick();
    // Let the async IIFE inside runOneFrame (createImageBitmap + detect) settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useDocumentDetection auto-capture countdown (C1 / M1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    detectQueue = [];
    isBusyValue = false;
    vi.clearAllMocks();
    // offscreenSupported: true keeps these tests on the ORIGINAL `detect()`
    // path (task 6.7.1 added a separate `detectImageData()` path gated on
    // this flag — covered by its own describe block below).
    useScannerStore.setState({ ...scannerStoreInitialState, autoCaptureEnabled: true, offscreenSupported: true });

    // createImageBitmap is not in happy-dom; the hook only needs it to resolve.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap));
    vi.spyOn(Date, 'now');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('C1: progresses 3 -> 2 -> 1 -> 0 and fires onAutoCapture after a sustained stability window', async () => {
    const onAutoCapture = vi.fn();
    const video = createFakeVideo();

    const { result } = renderHook(() => useDocumentDetection({ onAutoCapture }));

    // Two stable frames far enough apart (> STABILITY_MS) so the buffer's time
    // window is full AND elapsed stable time crosses STABILITY_MS -> arm.
    let clock = 1_000_000;
    (Date.now as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => clock);

    detectQueue.push(detectResult(STABLE_QUAD));
    await act(async () => {
      result.current.start(video.el);
      // init() resolves, then scheduleNextFrame arms the first rVFC.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Frame 1 at t0: seeds stableSince, buffer has 1 sample (variance 0).
    await runFrame(video);
    expect(useScannerStore.getState().countdown).toBe(0);

    // Frame 2 at t0 + STABILITY_MS: still stable, elapsed >= STABILITY_MS -> arm.
    clock += DETECTION.STABILITY_MS + 1;
    detectQueue.push(detectResult(STABLE_QUAD));
    await runFrame(video);

    expect(useScannerStore.getState().countdown).toBe(3);
    expect(onAutoCapture).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(useScannerStore.getState().countdown).toBe(2);

    act(() => vi.advanceTimersByTime(1000));
    expect(useScannerStore.getState().countdown).toBe(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(useScannerStore.getState().countdown).toBe(0);
    expect(onAutoCapture).toHaveBeenCalledTimes(1);
  });

  it('C1 cancel: losing stability mid-countdown cancels it and never fires capture', async () => {
    const onAutoCapture = vi.fn();
    const video = createFakeVideo();

    const { result } = renderHook(() => useDocumentDetection({ onAutoCapture }));

    let clock = 2_000_000;
    (Date.now as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => clock);

    detectQueue.push(detectResult(STABLE_QUAD));
    await act(async () => {
      result.current.start(video.el);
      await Promise.resolve();
      await Promise.resolve();
    });

    await runFrame(video); // seed stableSince

    clock += DETECTION.STABILITY_MS + 1;
    detectQueue.push(detectResult(STABLE_QUAD));
    await runFrame(video); // arm countdown -> 3
    expect(useScannerStore.getState().countdown).toBe(3);

    // Halfway through the countdown, frames with a moved quad break stability.
    // Two moved frames close together (within STABILITY_MS) so the variance
    // window holds >= 2 differing samples and the variance exceeds threshold.
    act(() => vi.advanceTimersByTime(1500));
    clock += 100;
    detectQueue.push(detectResult(MOVED_QUAD));
    await runFrame(video);
    clock += 100;
    detectQueue.push(detectResult(MOVED_QUAD));
    await runFrame(video);

    // Countdown must be cancelled/reset and no capture must ever fire.
    expect(useScannerStore.getState().countdown).toBe(0);

    act(() => vi.advanceTimersByTime(5000));
    expect(onAutoCapture).not.toHaveBeenCalled();
  });

  it('M1: the stability window is time-based — a burst of identical frames within STABILITY_MS does not arm', async () => {
    const onAutoCapture = vi.fn();
    const video = createFakeVideo();

    const { result } = renderHook(() => useDocumentDetection({ onAutoCapture }));

    // Simulate high frame rate: many identical stable frames, but all within a
    // window SHORTER than STABILITY_MS. A count-based buffer would think it is
    // "stable long enough"; a time-based one must not.
    let clock = 3_000_000;
    (Date.now as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => clock);

    detectQueue.push(detectResult(STABLE_QUAD));
    await act(async () => {
      result.current.start(video.el);
      await Promise.resolve();
      await Promise.resolve();
    });

    // 20 frames spanning only ~200ms total (10ms apart) — far under STABILITY_MS.
    for (let i = 0; i < 20; i += 1) {
      detectQueue.push(detectResult(STABLE_QUAD));
      await runFrame(video);
      clock += 10;
    }

    // Elapsed stable time (~200ms) never crossed STABILITY_MS -> no countdown.
    expect(useScannerStore.getState().countdown).toBe(0);

    // Now let real time cross STABILITY_MS with one more stable frame -> arms.
    clock += DETECTION.STABILITY_MS;
    detectQueue.push(detectResult(STABLE_QUAD));
    await runFrame(video);
    expect(useScannerStore.getState().countdown).toBe(3);
  });
});

/**
 * Group 6 / Slice F (task 6.6.1; design section 4.4): OpenCV INIT failure
 * mirrors into `OpenCvSlice` and retries with bounded exponential backoff
 * (1s/2s/4s, max 3 automatic retries), then stays retriable manually via
 * `retryManualInit` forever after the automatic budget is exhausted.
 *
 * `waitFor` (real-timer based) is deliberately NOT used here — it conflicts
 * with `vi.useFakeTimers()` (its internal polling never advances the fake
 * clock, so it always times out). Microtask flushing under fake timers is
 * done explicitly via `flushMicrotasks` instead.
 */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('useDocumentDetection OpenCV load state machine + backoff (task 6.6.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    detectQueue = [];
    isBusyValue = false;
    vi.clearAllMocks();
    useScannerStore.setState({ ...scannerStoreInitialState });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('mirrors a successful INIT into opencv.status: idle -> loading -> ready', async () => {
    const initMock = fakeWorkerClient.init as unknown as ReturnType<typeof vi.fn>;
    initMock.mockImplementation(async (onProgress: (p: number) => void) => {
      onProgress(0.5);
    });

    const video = createFakeVideo();
    expect(useScannerStore.getState().opencv.status).toBe('idle');

    const { result } = renderHook(() => useDocumentDetection());
    await act(async () => {
      result.current.start(video.el);
      await flushMicrotasks();
    });

    expect(useScannerStore.getState().opencv.status).toBe('ready');
    expect(useScannerStore.getState().opencv.lastError).toBeNull();
  });

  it('transitions to error and schedules bounded automatic retries (1s/2s/4s) on repeated INIT failure', async () => {
    const initMock = fakeWorkerClient.init as unknown as ReturnType<typeof vi.fn>;
    initMock.mockRejectedValue(new Error('WASM instantiate failed'));

    const video = createFakeVideo();
    const { result } = renderHook(() => useDocumentDetection());

    await act(async () => {
      result.current.start(video.el);
      await flushMicrotasks();
    });

    // First attempt fails — status flips to error.
    expect(useScannerStore.getState().opencv.status).toBe('error');
    expect(useScannerStore.getState().opencv.lastError).toBe('WASM instantiate failed');
    expect(initMock).toHaveBeenCalledTimes(1);

    // First auto-retry after 1s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });
    expect(initMock).toHaveBeenCalledTimes(2);

    // Second auto-retry after 2s more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });
    expect(initMock).toHaveBeenCalledTimes(3);

    // Third auto-retry after 4s more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
      await flushMicrotasks();
    });
    expect(initMock).toHaveBeenCalledTimes(4);

    // Automatic budget (3 retries) is now exhausted — no further calls even
    // after a long wait, until a manual retry is requested.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();
    });
    expect(initMock).toHaveBeenCalledTimes(4);
    expect(useScannerStore.getState().opencv.status).toBe('error');
  });

  it('retryManualInit retries immediately even after the automatic backoff budget is exhausted, and succeeding recovers to ready', async () => {
    const initMock = fakeWorkerClient.init as unknown as ReturnType<typeof vi.fn>;
    initMock.mockRejectedValue(new Error('network error'));

    const video = createFakeVideo();
    const { result } = renderHook(() => useDocumentDetection());

    await act(async () => {
      result.current.start(video.el);
      await flushMicrotasks();
    });
    expect(useScannerStore.getState().opencv.status).toBe('error');

    // Exhaust the automatic budget (1s + 2s + 4s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
      await flushMicrotasks();
    });
    expect(initMock).toHaveBeenCalledTimes(4);

    // Now let a manual retry succeed (task 6.6.1: "si OpenCV se recupera en
    // un reintento posterior, permitir warp" — recovery is just INIT
    // succeeding again).
    initMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      result.current.retryManualInit();
      await flushMicrotasks();
    });

    expect(useScannerStore.getState().opencv.status).toBe('ready');
    expect(initMock).toHaveBeenCalledTimes(5);
  });
});

/**
 * Group 6 / Slice F (task 6.7.1; design section 8): the live loop must route
 * DETECT through `detectImageData` (extracting pixels on the main thread via
 * `bitmapToImageData`) instead of transferring the bitmap when
 * `CameraSlice.offscreenSupported` is false, so the worker's own
 * `OffscreenCanvas`-based extraction is never required.
 */
describe('useDocumentDetection no-OffscreenCanvas fallback (task 6.7.1)', () => {
  let closeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    detectQueue = [];
    isBusyValue = false;
    vi.clearAllMocks();
    useScannerStore.setState({ ...scannerStoreInitialState });

    closeSpy = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 640, height: 480, close: closeSpy }) as unknown as ImageBitmap),
    );

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) })),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    // Restore after this describe block via a closure captured in afterEach.
    (globalThis as { __originalGetContext?: typeof HTMLCanvasElement.prototype.getContext }).__originalGetContext =
      originalGetContext;
  });

  afterEach(() => {
    const originalGetContext = (
      globalThis as { __originalGetContext?: typeof HTMLCanvasElement.prototype.getContext }
    ).__originalGetContext;
    if (originalGetContext) {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls detectImageData (not detect) and closes the bitmap when offscreenSupported is false', async () => {
    useScannerStore.setState({ offscreenSupported: false });
    const video = createFakeVideo();
    detectQueue.push(detectResult(null));

    const { result } = renderHook(() => useDocumentDetection());
    await act(async () => {
      result.current.start(video.el);
      await Promise.resolve();
      await Promise.resolve();
    });

    await runFrame(video);

    expect(fakeWorkerClient.detectImageData).toHaveBeenCalledTimes(1);
    expect(fakeWorkerClient.detect).not.toHaveBeenCalled();
    // bitmapToImageData closes the bitmap itself; runOneFrame must not
    // double-close an already-nulled-out reference.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('calls detect (not detectImageData) when offscreenSupported is true', async () => {
    useScannerStore.setState({ offscreenSupported: true });
    const video = createFakeVideo();
    detectQueue.push(detectResult(null));

    const { result } = renderHook(() => useDocumentDetection());
    await act(async () => {
      result.current.start(video.el);
      await Promise.resolve();
      await Promise.resolve();
    });

    await runFrame(video);

    expect(fakeWorkerClient.detect).toHaveBeenCalledTimes(1);
    expect(fakeWorkerClient.detectImageData).not.toHaveBeenCalled();
  });
});

/**
 * Slice F review fix HIGH-2 / test coverage MEDIUM-2: the "init HANGS" failure
 * mode. Distinct from the "init REJECTS" case already covered above — here
 * `workerClient.init()` returns a promise that NEVER settles (the real
 * reported failure: the OpenCV `import()` inside the worker never resolves).
 *
 * Against the OLD hook (no hard init timeout) these tests FAIL: `initStatusRef`
 * stays 'loading' forever, `runAttemptWithAutoRetry`'s `.catch` never fires,
 * the store status never flips to 'error', and the degraded banner never
 * becomes available — a semi-dead screen. The `INIT_TIMEOUT_MS` (18s) ceiling
 * added in the hook makes a hung init reject with OPENCV_LOAD_FAILED so the
 * SAME backoff -> degraded -> banner path fires uniformly.
 *
 * `INIT_TIMEOUT_MS` is an internal constant (18_000); referenced here as a
 * literal since the hook does not export it.
 */
const INIT_TIMEOUT_MS = 18_000;

describe('useDocumentDetection OpenCV init hang timeout (HIGH-2 / MEDIUM-2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    detectQueue = [];
    isBusyValue = false;
    vi.clearAllMocks();
    useScannerStore.setState({ ...scannerStoreInitialState });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a HANGING init (never resolves) still flips opencv.status to error after INIT_TIMEOUT_MS (degraded banner available; loop is not left semi-dead)', async () => {
    const initMock = fakeWorkerClient.init as unknown as ReturnType<typeof vi.fn>;
    // The real hung-worker failure mode: init() never resolves NOR rejects.
    initMock.mockImplementation(() => new Promise<void>(() => {}));

    const video = createFakeVideo();
    const { result } = renderHook(() => useDocumentDetection());

    await act(async () => {
      result.current.start(video.el);
      await flushMicrotasks();
    });

    // While within the timeout window, status is still 'loading' — but crucially
    // it must NOT stay there forever (that is the bug this test proves).
    expect(useScannerStore.getState().opencv.status).toBe('loading');

    // Advance PAST the hard init ceiling: the timeout must reject the attempt,
    // driving the SAME error path a real OPENCV_LOAD_FAILED rejection would.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS + 1);
      await flushMicrotasks();
    });

    expect(useScannerStore.getState().opencv.status).toBe('error');
    expect(useScannerStore.getState().opencv.lastError).toContain('hung');
    // ScannerScreen renders the degraded banner off `opencv.status === 'error'`,
    // so reaching 'error' is exactly the "banner available + editor
    // frame-completo reachable" state the review required (never semi-dead).
  });

  it('a HANGING init then triggers the SAME bounded backoff retries as a rejecting init', async () => {
    const initMock = fakeWorkerClient.init as unknown as ReturnType<typeof vi.fn>;
    initMock.mockImplementation(() => new Promise<void>(() => {}));

    const video = createFakeVideo();
    const { result } = renderHook(() => useDocumentDetection());

    await act(async () => {
      result.current.start(video.el);
      await flushMicrotasks();
    });

    // First attempt hangs -> times out at INIT_TIMEOUT_MS -> error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS + 1);
      await flushMicrotasks();
    });
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().opencv.status).toBe('error');

    // First auto-retry fires 1s after the timeout-induced failure; it too hangs
    // and times out, proving the hung path feeds the identical backoff chain.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });
    expect(initMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS + 1);
      await flushMicrotasks();
    });
    expect(useScannerStore.getState().opencv.status).toBe('error');
  });

  it('a SLOW-but-successful init that resolves BEFORE the timeout does NOT spuriously error (timer cleared on success)', async () => {
    const initMock = fakeWorkerClient.init as unknown as ReturnType<typeof vi.fn>;
    // Resolves well within the timeout window.
    initMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, INIT_TIMEOUT_MS - 1000);
        }),
    );

    const video = createFakeVideo();
    const { result } = renderHook(() => useDocumentDetection());

    await act(async () => {
      result.current.start(video.el);
      await flushMicrotasks();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS - 1000 + 1);
      await flushMicrotasks();
    });
    expect(useScannerStore.getState().opencv.status).toBe('ready');

    // Advancing well past when the timeout WOULD have fired must not flip it
    // back to error — the success path cleared the timer (no leak / no
    // spurious rejection).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS);
      await flushMicrotasks();
    });
    expect(useScannerStore.getState().opencv.status).toBe('ready');
  });
});
