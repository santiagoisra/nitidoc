import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AspectRatioName, Quad } from '@/shared/types/geometry';
import type {
  WarpResponse,
  WarpResponseImageData,
} from '@/features/scanner/worker/messages';

/**
 * Slice E adversarial-review regression tests for CornerEditor's warp
 * concurrency + bitmap hygiene (findings C1/C2) and the redundant-tap warp
 * (finding L2).
 *
 * These bugs had NO coverage before this file. The race test in particular is
 * written to FAIL against the pre-fix code (which had no warp sequencing and
 * no stale-bitmap close), proving it is not decorative — see the assertions on
 * `close` being called on the superseded result and on only the LATEST warp
 * reaching the store.
 */

// ── Controllable worker-client mock ─────────────────────────────────────────
// Each warp() call returns a promise whose resolver we capture, so the test
// decides exactly WHEN (and in what order) warps resolve — the essence of the
// race.
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const warpDeferreds: Array<Deferred<WarpResponse | WarpResponseImageData>> = [];
const warpMock = vi.fn(() => {
  const d = deferred<WarpResponse | WarpResponseImageData>();
  warpDeferreds.push(d);
  return d.promise;
});

vi.mock('@/features/scanner/lib/workerClient', () => ({
  getSharedWorkerClient: () => ({
    init: vi.fn(async () => {}),
    detect: vi.fn(),
    warp: warpMock,
    isBusy: () => false,
    terminate: vi.fn(),
  }),
}));

import { CornerEditor } from '@/features/scanner/components/CornerEditor';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

// ── Canvas / ImageBitmap shims (happy-dom lacks a 2d canvas + createImageBitmap) ──
function installCanvasShims(): void {
  const fakeCtx = {
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    putImageData: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    'ImageData',
    class {
      width: number;
      height: number;
      data: Uint8ClampedArray;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
  vi.stubGlobal('createImageBitmap', vi.fn(async () => makeBitmap()));
  // happy-dom returns an all-zero rect; give the editor container a real box so
  // toSourcePoint maps pointer coordinates into source space (needed for the
  // pointermove-triggered warp path in the L2 tests).
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 300,
    bottom: 400,
    width: 300,
    height: 400,
    toJSON: () => ({}),
  } as DOMRect);
}

function makeBitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return {
    width: 700,
    height: 990,
    close: vi.fn(),
  } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function makeFrame(): {
  source: ImageBitmap;
  width: number;
  height: number;
  capturedAt: number;
} {
  return {
    source: makeBitmap(),
    width: 3000,
    height: 4000,
    capturedAt: 1_000,
  };
}

const CONVEX_CORNERS: Quad = [
  { x: 100, y: 100 },
  { x: 2900, y: 100 },
  { x: 2900, y: 3900 },
  { x: 100, y: 3900 },
];

function warpResult(bitmap: ImageBitmap): WarpResponse {
  return { id: 1, type: 'WARP_RESULT', bitmap, outWidth: 700, outHeight: 990 };
}

/**
 * CornerEditor now runs ONE warp on mount so the corrected preview shows
 * immediately (and Confirm enables) without the user first nudging a handle.
 * These tests measure only INTERACTION-triggered warps, so we let that initial
 * mount warp fire, resolve it, and reset the mock/store before the interaction
 * under test.
 */
async function flushInitialMountWarp(): Promise<void> {
  await waitFor(() => expect(warpDeferreds.length).toBeGreaterThanOrEqual(1));
  const initial = warpDeferreds[0];
  if (initial) {
    await act(async () => {
      initial.resolve(warpResult(makeBitmap()));
      await Promise.resolve();
    });
  }
  warpMock.mockClear();
  warpDeferreds.length = 0;
  act(() => {
    useScannerStore.setState({ warpedImage: null, recipe: null });
  });
}

describe('CornerEditor warp concurrency + bitmap hygiene (C1/C2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warpDeferreds.length = 0;
    installCanvasShims();
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('drops a stale warp (A) when a newer warp (B) is dispatched first, closing A\'s bitmap and keeping only B', async () => {
    render(
      <CornerEditor
        frame={makeFrame() as never}
        initialCorners={CONVEX_CORNERS}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await flushInitialMountWarp();

    // Fire warp A (choose "letter"), then warp B (choose "ticket") BEFORE A
    // resolves. handleAspectChange runs runWarp because the seeded quad is
    // convex.
    fireEvent.click(screen.getByTestId('aspect-ratio-letter'));
    fireEvent.click(screen.getByTestId('aspect-ratio-ticket'));

    await waitFor(() => expect(warpDeferreds.length).toBe(2));

    const bitmapA = makeBitmap();
    const bitmapB = makeBitmap();
    const deferredA = warpDeferreds[0];
    const deferredB = warpDeferreds[1];
    if (!deferredA || !deferredB) throw new Error('expected two warp deferreds');

    // Resolve the NEWER warp (B) first, then the stale one (A). B wins; A must
    // be discarded and its bitmap closed.
    await act(async () => {
      deferredB.resolve(warpResult(bitmapB));
      await Promise.resolve();
    });
    await act(async () => {
      deferredA.resolve(warpResult(bitmapA));
      await Promise.resolve();
    });

    await waitFor(() => {
      // Only B reached the store.
      expect(useScannerStore.getState().warpedImage).toBe(bitmapB);
    });

    // A's bitmap was CLOSED (fix C2 — a discarded stale result never leaks).
    expect((bitmapA as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    // B's bitmap is live in the store, NOT closed.
    expect((bitmapB as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });

  it('a warp resolving after unmount closes its bitmap and never touches the store', async () => {
    const { unmount } = render(
      <CornerEditor
        frame={makeFrame() as never}
        initialCorners={CONVEX_CORNERS}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await flushInitialMountWarp();

    fireEvent.click(screen.getByTestId('aspect-ratio-letter'));
    await waitFor(() => expect(warpDeferreds.length).toBe(1));

    // Unmount (simulates the user hitting Back / resetCaptureSlice) with a warp
    // still in flight.
    unmount();

    const orphan = makeBitmap();
    const inFlight = warpDeferreds[0];
    if (!inFlight) throw new Error('expected one warp deferred');
    await act(async () => {
      inFlight.resolve(warpResult(orphan));
      await Promise.resolve();
    });

    // The store was never written and the orphan bitmap was closed.
    expect(useScannerStore.getState().warpedImage).toBeNull();
    expect((orphan as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
  });
});

describe('CornerEditor redundant-tap guard (L2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warpDeferreds.length = 0;
    installCanvasShims();
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a pointerdown + pointerup with NO pointermove does not dispatch a warp', async () => {
    render(
      <CornerEditor
        frame={makeFrame() as never}
        initialCorners={CONVEX_CORNERS}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await flushInitialMountWarp();

    const handle = screen.getByTestId('corner-handle-0');
    // happy-dom's pointer capture is a no-op on a detached-ish element; guard
    // so the handler under test still runs its warp-decision logic.
    (handle as HTMLElement).setPointerCapture = () => {};
    (handle as HTMLElement).releasePointerCapture = () => {};

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 10 });

    // No move happened, so no warp was requested.
    await Promise.resolve();
    expect(warpMock).not.toHaveBeenCalled();
  });

  it('a pointerdown + pointermove + pointerup DOES dispatch a warp', async () => {
    render(
      <CornerEditor
        frame={makeFrame() as never}
        initialCorners={CONVEX_CORNERS}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await flushInitialMountWarp();

    const handle = screen.getByTestId('corner-handle-0');
    (handle as HTMLElement).setPointerCapture = () => {};
    (handle as HTMLElement).releasePointerCapture = () => {};

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40, clientY: 60 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 40, clientY: 60 });

    await waitFor(() => expect(warpMock).toHaveBeenCalledTimes(1));
  });
});

// Guard against an unused-import lint failure for the AspectRatioName type,
// which documents the aspect values the buttons above map to.
const _aspectNames: readonly AspectRatioName[] = ['a4', 'letter', 'ticket', 'unknown'];
void _aspectNames;
