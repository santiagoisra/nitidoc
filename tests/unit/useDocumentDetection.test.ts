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
  warp: vi.fn(),
  isBusy: vi.fn(() => isBusyValue),
  terminate: vi.fn(),
};

vi.mock('@/features/scanner/lib/workerClient', () => ({
  getSharedWorkerClient: () => fakeWorkerClient,
  terminateSharedWorkerClient: vi.fn(),
}));

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
    useScannerStore.setState({ ...scannerStoreInitialState, autoCaptureEnabled: true });

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
