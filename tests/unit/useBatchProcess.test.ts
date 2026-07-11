import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerClient } from '@/features/scanner/lib/workerClient';
import { frameCorners } from '@/features/scanner/lib/editRecipe';
import type { RawCapture } from '@/features/scanner/store/documentSlice';
import type { DetectResponse, WarpResponse } from '@/features/scanner/worker/messages';

/**
 * Fase 2.3 (capture-ux-redesign.md, Unit 4) unit tests for `useBatchProcess`:
 * the deferred detect->warp->thumbnail batch that converts `rawCaptures`
 * into `DocumentPage`s on entering `'processing'`.
 *
 * `pageResources.ts`'s async helpers are mocked (same pattern as
 * `useActivePage.test.ts`) so this suite exercises ONLY the orchestration
 * contract: sequencing, hygiene, fallback routing, run-once idempotency, and
 * end-of-run cleanup. `createImageBitmap`/`HTMLCanvasElement.getContext` are
 * stubbed (same pattern as `pageResources.test.ts`/`captureFrame.test.ts`)
 * since happy-dom implements neither for real.
 */

const decodeBlobToBitmapMock = vi.fn();
const makeThumbnailMock = vi.fn();
const compressBitmapToJpegMock = vi.fn();

vi.mock('@/features/scanner/lib/pageResources', () => ({
  decodeBlobToBitmap: (...args: unknown[]) => decodeBlobToBitmapMock(...args),
  makeThumbnail: (...args: unknown[]) => makeThumbnailMock(...args),
  compressBitmapToJpeg: (...args: unknown[]) => compressBitmapToJpegMock(...args),
}));

import { useBatchProcess } from '@/features/scanner/hooks/useBatchProcess';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

function fakeBitmap(width = 100, height = 100): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

let rawCounter = 0;
function fakeRawCapture(overrides: Partial<RawCapture> = {}): RawCapture {
  rawCounter += 1;
  return {
    id: overrides.id ?? `raw-${rawCounter}`,
    order: overrides.order ?? 0,
    originalBlob: overrides.originalBlob ?? new Blob([`raw-${rawCounter}`], { type: 'image/jpeg' }),
    thumbnail: overrides.thumbnail ?? fakeBitmap(100, 100),
    originalWidth: overrides.originalWidth ?? 1000,
    originalHeight: overrides.originalHeight ?? 1400,
  };
}

/** A valid convex quad well inside a 640-wide detection frame, scales to a valid convex quad in full-res space too (uniform scaling preserves convexity). */
const DETECTION_FRAME_CORNERS = [
  { x: 50, y: 50 },
  { x: 590, y: 50 },
  { x: 590, y: 600 },
  { x: 50, y: 600 },
] as const;

function makeWorkerClient(overrides: Partial<WorkerClient> = {}): WorkerClient {
  const detectResult: DetectResponse = { id: 0, type: 'DETECT_RESULT', corners: null, quality: null };
  const warpResult: WarpResponse = {
    id: 0,
    type: 'WARP_RESULT',
    bitmap: fakeBitmap(500, 700),
    outWidth: 500,
    outHeight: 700,
  };
  return {
    init: vi.fn(async () => {}),
    detect: vi.fn(async () => detectResult),
    detectImageData: vi.fn(async () => detectResult),
    warp: vi.fn(async () => warpResult),
    applyFilter: vi.fn(),
    isBusy: vi.fn(() => false),
    terminate: vi.fn(),
    ...overrides,
  } as unknown as WorkerClient;
}

let createImageBitmapMock: ReturnType<typeof vi.fn>;
let fakeCtx: { drawImage: ReturnType<typeof vi.fn>; getImageData: ReturnType<typeof vi.fn>; putImageData: ReturnType<typeof vi.fn> };
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  rawCounter = 0;
  useScannerStore.setState({ ...scannerStoreInitialState, offscreenSupported: true });

  decodeBlobToBitmapMock.mockReset().mockImplementation(async () => fakeBitmap(2000, 3000));
  makeThumbnailMock.mockReset().mockImplementation(async () => fakeBitmap(150, 150));
  compressBitmapToJpegMock.mockReset().mockImplementation(async () => new Blob(['warped'], { type: 'image/jpeg' }));

  createImageBitmapMock = vi.fn(
    async (source: unknown, opts?: { resizeWidth?: number }): Promise<ImageBitmap> => {
      if (opts && typeof opts.resizeWidth === 'number') {
        return fakeBitmap(opts.resizeWidth, Math.round(opts.resizeWidth * 1.4));
      }
      const canvasLike = source as { width?: number; height?: number };
      return fakeBitmap(canvasLike.width ?? 100, canvasLike.height ?? 100);
    },
  );
  vi.stubGlobal('createImageBitmap', createImageBitmapMock);

  fakeCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(4),
    })),
    putImageData: vi.fn(),
  };
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => fakeCtx,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useBatchProcess — sequential order (design "Memory": never Promise.all over pages)', () => {
  it('processes rawCaptures strictly one at a time, in `order`, never starting raw N+1 before raw N committed its page', async () => {
    const raws = [fakeRawCapture({ order: 0 }), fakeRawCapture({ order: 1 }), fakeRawCapture({ order: 2 })];
    // Store in a SHUFFLED order — the hook must sort by `order`, not array position.
    useScannerStore.setState({ rawCaptures: [raws[2] as RawCapture, raws[0] as RawCapture, raws[1] as RawCapture] });

    const pagesLengthAtDecodeStart: number[] = [];
    decodeBlobToBitmapMock.mockImplementation(async () => {
      pagesLengthAtDecodeStart.push(useScannerStore.getState().pages.length);
      return fakeBitmap(2000, 3000);
    });

    const ensureOpenCvInit = vi.fn(async () => {});
    const workerClient = makeWorkerClient();
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      await result.current.run();
    });

    // Each subsequent raw's decode only started once the PREVIOUS raw's page
    // already existed — proves sequential (not concurrent) processing.
    expect(pagesLengthAtDecodeStart).toEqual([0, 1, 2]);

    // Committed in `order`, not array-insertion order.
    expect(useScannerStore.getState().pages.map((p) => p.id)).toEqual([raws[0]?.id, raws[1]?.id, raws[2]?.id]);
    expect(decodeBlobToBitmapMock.mock.calls.map((call) => call[0])).toEqual([
      raws[0]?.originalBlob,
      raws[1]?.originalBlob,
      raws[2]?.originalBlob,
    ]);
  });
});

describe('useBatchProcess — one-live-page hygiene', () => {
  it('closes originalBitmap + detectionBitmap + warpedBase, and never closes the thumbnail handed to the page', async () => {
    const raw = fakeRawCapture();
    useScannerStore.setState({ rawCaptures: [raw] });

    const originalBitmap = fakeBitmap(2000, 3000);
    decodeBlobToBitmapMock.mockResolvedValueOnce(originalBitmap);

    const detectionBitmap = fakeBitmap(640, 896);
    createImageBitmapMock.mockImplementationOnce(async () => detectionBitmap);

    const warpedBitmap = fakeBitmap(500, 700);
    const detectResult: DetectResponse = { id: 0, type: 'DETECT_RESULT', corners: null, quality: null };
    const warpResult: WarpResponse = { id: 0, type: 'WARP_RESULT', bitmap: warpedBitmap, outWidth: 500, outHeight: 700 };
    const workerClient = makeWorkerClient({
      detect: vi.fn(async () => detectResult),
      warp: vi.fn(async () => warpResult),
    });

    const thumbnail = fakeBitmap(150, 150);
    makeThumbnailMock.mockResolvedValueOnce(thumbnail);

    const ensureOpenCvInit = vi.fn(async () => {});
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      await result.current.run();
    });

    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(detectionBitmap.close).toHaveBeenCalledTimes(1);
    expect(warpedBitmap.close).toHaveBeenCalledTimes(1);
    // The page's cached thumbnail must survive — closing it would corrupt the grid tile.
    expect(thumbnail.close).not.toHaveBeenCalled();
    expect(useScannerStore.getState().pages[0]?.thumbnail).toBe(thumbnail);
  });
});

describe('useBatchProcess — frameCorners fallback on missing/non-convex detection', () => {
  it('falls back to frameCorners and sets needsReview when DETECT returns no corners', async () => {
    const raw = fakeRawCapture({ originalWidth: 1000, originalHeight: 1400 });
    useScannerStore.setState({ rawCaptures: [raw] });
    decodeBlobToBitmapMock.mockResolvedValueOnce(fakeBitmap(1000, 1400));

    const detectResult: DetectResponse = { id: 0, type: 'DETECT_RESULT', corners: null, quality: null };
    const workerClient = makeWorkerClient({ detect: vi.fn(async () => detectResult) });

    const ensureOpenCvInit = vi.fn(async () => {});
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      await result.current.run();
    });

    const page = useScannerStore.getState().pages[0];
    expect(page?.needsReview).toBe(true);
    expect(page?.recipe.corners).toEqual(frameCorners(1000, 1400));
  });
});

describe('useBatchProcess — per-page WARP failure -> degraded page (NEVER dropped)', () => {
  it('builds an identity-warp page with frameCorners + needsReview when workerClient.warp throws, even though DETECT succeeded', async () => {
    const raw = fakeRawCapture({ originalWidth: 1000, originalHeight: 1400 });
    useScannerStore.setState({ rawCaptures: [raw] });
    decodeBlobToBitmapMock.mockResolvedValueOnce(fakeBitmap(1000, 1400));
    createImageBitmapMock.mockImplementationOnce(async () => fakeBitmap(640, 896));

    const detectResult: DetectResponse = {
      id: 0,
      type: 'DETECT_RESULT',
      corners: DETECTION_FRAME_CORNERS as unknown as DetectResponse['corners'],
      quality: null,
    };
    const workerClient = makeWorkerClient({
      detect: vi.fn(async () => detectResult),
      warp: vi.fn(async () => {
        throw new Error('WARP_FAILED');
      }),
    });

    const ensureOpenCvInit = vi.fn(async () => {});
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      const outcome = await result.current.run();
      expect(outcome).toEqual({ addedCount: 1, cancelled: false, total: 1 });
    });

    expect(useScannerStore.getState().pages).toHaveLength(1);
    const page = useScannerStore.getState().pages[0];
    expect(page?.needsReview).toBe(true);
    // Degraded fallback forces frameCorners — the successfully-DETECTed quad
    // is discarded since no real warp ran against it.
    expect(page?.recipe.corners).toEqual(frameCorners(1000, 1400));
    // The raw capture must be gone from rawCaptures (converted, not dropped).
    expect(useScannerStore.getState().rawCaptures).toHaveLength(0);
  });
});

describe('useBatchProcess — partial thumbnail/compress failure does not leak the resolved thumbnail (review fix)', () => {
  it('closes the resolved thumbnail bitmap when compressBitmapToJpeg rejects, and still releases originalBitmap/warpedBase via the outer hygiene finally', async () => {
    const raw = fakeRawCapture({ originalWidth: 1000, originalHeight: 1400 });
    useScannerStore.setState({ rawCaptures: [raw] });

    const originalBitmap = fakeBitmap(1000, 1400);
    decodeBlobToBitmapMock.mockResolvedValueOnce(originalBitmap);

    const warpedBitmap = fakeBitmap(500, 700);
    const detectResult: DetectResponse = { id: 0, type: 'DETECT_RESULT', corners: null, quality: null };
    const warpResult: WarpResponse = { id: 0, type: 'WARP_RESULT', bitmap: warpedBitmap, outWidth: 500, outHeight: 700 };
    const workerClient = makeWorkerClient({
      detect: vi.fn(async () => detectResult),
      warp: vi.fn(async () => warpResult),
    });

    const thumbnail = fakeBitmap(150, 150);
    makeThumbnailMock.mockResolvedValueOnce(thumbnail);
    compressBitmapToJpegMock.mockRejectedValueOnce(new Error('compress failed'));

    const ensureOpenCvInit = vi.fn(async () => {});
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      await result.current.run();
    });

    // The raw failed to convert — skipped (never silently dropped as a
    // committed page), and swept up by the end-of-run clearRawCaptures().
    expect(useScannerStore.getState().pages).toHaveLength(0);
    expect(useScannerStore.getState().rawCaptures).toHaveLength(0);
    // The resolved thumbnail must never leak, even though the page was never committed.
    expect(thumbnail.close).toHaveBeenCalledTimes(1);
    // The outer per-page hygiene `finally` still released originalBitmap/warpedBase.
    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(warpedBitmap.close).toHaveBeenCalledTimes(1);
  });
});

describe('useBatchProcess — degraded mode when ensureOpenCvInit itself rejects', () => {
  it('skips DETECT/WARP entirely and still produces a page for every raw capture', async () => {
    const raw = fakeRawCapture({ originalWidth: 800, originalHeight: 1200 });
    useScannerStore.setState({ rawCaptures: [raw] });
    decodeBlobToBitmapMock.mockResolvedValueOnce(fakeBitmap(800, 1200));

    const detectMock = vi.fn();
    const warpMock = vi.fn();
    const workerClient = makeWorkerClient({ detect: detectMock, warp: warpMock });
    const ensureOpenCvInit = vi.fn(async () => {
      throw new Error('OPENCV_LOAD_FAILED');
    });

    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      await result.current.run();
    });

    expect(detectMock).not.toHaveBeenCalled();
    expect(warpMock).not.toHaveBeenCalled();
    const page = useScannerStore.getState().pages[0];
    expect(page?.needsReview).toBe(true);
    expect(page?.recipe.corners).toEqual(frameCorners(800, 1200));
  });
});

describe('useBatchProcess — run-once guard', () => {
  it('a second concurrent run() call is a no-op — no duplicate pages', async () => {
    const raw = fakeRawCapture();
    useScannerStore.setState({ rawCaptures: [raw] });

    const ensureOpenCvInit = vi.fn(async () => {});
    const workerClient = makeWorkerClient();
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      const [first, second] = await Promise.all([result.current.run(), result.current.run()]);
      expect(first).toEqual({ addedCount: 1, cancelled: false, total: 1 });
      expect(second).toEqual({ addedCount: 0, cancelled: false, total: 0 });
    });

    expect(useScannerStore.getState().pages).toHaveLength(1);
    expect(decodeBlobToBitmapMock).toHaveBeenCalledTimes(1);
  });
});

describe('useBatchProcess — StrictMode deadlock regression (review fix)', () => {
  it('a cleanup-then-reinvoke (mirroring StrictMode\'s simulated mount->cleanup->remount) still lets the ORIGINAL, still-pending run complete to "grid" instead of stranding "processing" forever', async () => {
    const raw = fakeRawCapture();
    useScannerStore.setState({ rawCaptures: [raw] });

    let resolveInit: (() => void) | undefined;
    const ensureOpenCvInit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );
    const workerClient = makeWorkerClient();
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    // Call #1: the mount effect's original invocation. Pauses at `await
    // ensureOpenCvInit()` inside `run()` — it never resolves until we call
    // `resolveInit()` further below.
    let firstRunPromise!: ReturnType<typeof result.current.run>;
    act(() => {
      firstRunPromise = result.current.run();
    });

    // Simulates the StrictMode SIMULATED-UNMOUNT cleanup that fires BETWEEN
    // call #1 (still pending above) and call #2 (the surviving remount's
    // re-invocation): `cancel()` sets the SAME shared `cancelledRef` this
    // hook's own unmount-cleanup effect sets, without needing a real
    // unmount/remount render cycle.
    act(() => {
      result.current.cancel();
    });

    // Call #2: the "remount" re-invocation. The run-once guard makes this a
    // same-tick no-op (`ranRef` is already `true` from call #1) — but the fix
    // under test requires it to ALSO un-cancel the shared flag first, so
    // call #1 can still complete once its own `await` resolves.
    let secondRunPromise!: ReturnType<typeof result.current.run>;
    act(() => {
      secondRunPromise = result.current.run();
    });

    resolveInit?.();

    await act(async () => {
      const [firstOutcome, secondOutcome] = await Promise.all([firstRunPromise, secondRunPromise]);
      expect(secondOutcome).toEqual({ addedCount: 0, cancelled: false, total: 0 });
      expect(firstOutcome).toEqual({ addedCount: 1, cancelled: false, total: 1 });
    });

    // The ORIGINAL call ran the full batch to completion — phase is NOT
    // stranded at 'processing' (the bug this regression test guards against).
    expect(useScannerStore.getState().phase).toBe('adjust');
    expect(useScannerStore.getState().pages).toHaveLength(1);
    expect(useScannerStore.getState().rawCaptures).toHaveLength(0);
  });
});

describe('useBatchProcess — clearRawCaptures + setPhase("adjust") after a successful run', () => {
  it('empties rawCaptures and routes to adjust once every page is committed', async () => {
    const raws = [fakeRawCapture({ order: 0 }), fakeRawCapture({ order: 1 })];
    useScannerStore.setState({ rawCaptures: raws });

    const ensureOpenCvInit = vi.fn(async () => {});
    const workerClient = makeWorkerClient();
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      await result.current.run();
    });

    expect(useScannerStore.getState().rawCaptures).toHaveLength(0);
    expect(useScannerStore.getState().pages).toHaveLength(2);
    expect(useScannerStore.getState().phase).toBe('adjust');
  });

  it('routes to "capturing" instead of an empty grid when zero pages were created', async () => {
    // No rawCaptures at all — the defensive "0 pages created" branch.
    useScannerStore.setState({ rawCaptures: [] });

    const ensureOpenCvInit = vi.fn(async () => {});
    const workerClient = makeWorkerClient();
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    await act(async () => {
      const outcome = await result.current.run();
      expect(outcome).toEqual({ addedCount: 0, cancelled: false, total: 0 });
    });

    expect(useScannerStore.getState().phase).toBe('capturing');
  });
});

describe('useBatchProcess — cancel()', () => {
  it('cancelling while ensureOpenCvInit is still in flight leaves rawCaptures intact and returns to "capturing"', async () => {
    const raws = [fakeRawCapture({ order: 0 }), fakeRawCapture({ order: 1 })];
    useScannerStore.setState({ rawCaptures: raws });

    let resolveInit: (() => void) | undefined;
    const ensureOpenCvInit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );
    const workerClient = makeWorkerClient();
    const { result } = renderHook(() => useBatchProcess({ ensureOpenCvInit, workerClient }));

    let runPromise!: ReturnType<typeof result.current.run>;
    act(() => {
      runPromise = result.current.run();
    });

    act(() => {
      result.current.cancel();
    });

    expect(useScannerStore.getState().phase).toBe('capturing');
    expect(useScannerStore.getState().rawCaptures).toHaveLength(2);

    resolveInit?.();
    await act(async () => {
      const outcome = await runPromise;
      expect(outcome.cancelled).toBe(true);
    });

    // Still untouched — nothing was ever processed.
    expect(useScannerStore.getState().rawCaptures).toHaveLength(2);
    expect(decodeBlobToBitmapMock).not.toHaveBeenCalled();
  });
});
