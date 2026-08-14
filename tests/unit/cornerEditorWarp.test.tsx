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
 * (finding L2), rewritten in Group 1d (PR4) against the active-page model
 * (design section 5.4, ADR-010): CornerEditor is now a CONTROLLED component
 * over `originalBitmap`/`initialRecipe` props and reports its confirmed
 * result via `onConfirm` instead of writing to F1's legacy single-page
 * capture state (`warpedImage`/`recipe`) in the store — there is no store to read from
 * anymore, so these tests assert via `onConfirm`'s call args and via
 * `bitmap.close()` spy counts, exactly preserving the original bugs' intent.
 *
 * These bugs had NO coverage before the original (F1) version of this file.
 * The race test in particular is written to FAIL against pre-fix code (which
 * had no warp sequencing and no stale-bitmap close), proving it is not
 * decorative — see the assertions on `close` being called on the superseded
 * result and on only the LATEST warp reaching `onConfirm`.
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
import { createInitialRecipe } from '@/features/scanner/lib/editRecipe';
import { paperSelection } from '@/features/scanner/lib/paperFormats';

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

const FRAME_WIDTH = 3000;
const FRAME_HEIGHT = 4000;

const CONVEX_CORNERS: Quad = [
  { x: 100, y: 100 },
  { x: 2900, y: 100 },
  { x: 2900, y: 3900 },
  { x: 100, y: 3900 },
];

const A_SERIES_CORNERS: Quad = [
  { x: 450, y: 500 },
  { x: 2550, y: 500 },
  { x: 2550, y: 3470 },
  { x: 450, y: 3470 },
];

function warpResult(bitmap: ImageBitmap): WarpResponse {
  return { id: 1, type: 'WARP_RESULT', bitmap, outWidth: 700, outHeight: 990 };
}

/**
 * CornerEditor now runs ONE warp on mount so the corrected preview shows
 * immediately (and Confirm enables) without the user first nudging a handle.
 * These tests measure only INTERACTION-triggered warps, so we let that initial
 * mount warp fire, resolve it, and clear the mock before the interaction
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
}

/**
 * The filter/rotate review step is reached via "Next" from 'corners'.
 * "Next" is only enabled once a warp has already landed (mirrors the OLD
 * single-step "Confirm" gate), which `flushInitialMountWarp` above already
 * guarantees before this is called.
 */
function goToAdjustStep(): void {
  fireEvent.click(screen.getByTestId('corner-editor-next'));
}

function dragCorner(pointerId: number, clientX: number, clientY: number): void {
  const handle = screen.getByTestId('corner-handle-0');
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  fireEvent.pointerDown(handle, { pointerId, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(handle, { pointerId, clientX, clientY });
  fireEvent.pointerUp(handle, { pointerId, clientX, clientY });
}

describe('CornerEditor warp concurrency + bitmap hygiene (C1/C2)', () => {
  let onConfirmMock: ReturnType<typeof vi.fn>;
  let onCancelMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warpDeferreds.length = 0;
    installCanvasShims();
    onConfirmMock = vi.fn();
    onCancelMock = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('drops a stale warp (A) when a newer warp (B) is dispatched first, closing A\'s bitmap and keeping only B', async () => {
    render(
      <CornerEditor
        pageId="draft-1"
        originalBitmap={makeBitmap()}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        initialCorners={CONVEX_CORNERS}
        initialRecipe={null}
        onConfirm={onConfirmMock}
        onCancel={onCancelMock}
      />,
    );

    await flushInitialMountWarp();

    // Fire two corner re-warps before either returns. Geometry editing must
    // retain the same race protections after preset controls are removed.
    dragCorner(1, 20, 20);
    dragCorner(2, 30, 30);

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

    // A's bitmap was CLOSED (fix C2 — a discarded stale result never leaks).
    await waitFor(() => {
      expect((bitmapA as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    });
    // B's bitmap is live in the component, NOT closed.
    expect((bitmapB as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();

    goToAdjustStep();
    // Confirming now hands B (the winner) to the caller — proof that only B
    // reached the component's live state, not A.
    fireEvent.click(screen.getByTestId('corner-editor-confirm'));
    expect(onConfirmMock).toHaveBeenCalledTimes(1);
    expect(onConfirmMock).toHaveBeenCalledWith(expect.objectContaining({ warpedBase: bitmapB }));
  });

  it('a warp resolving after unmount closes its bitmap and never reaches onConfirm', async () => {
    const { unmount } = render(
      <CornerEditor
        pageId="draft-1"
        originalBitmap={makeBitmap()}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        initialCorners={CONVEX_CORNERS}
        initialRecipe={null}
        onConfirm={onConfirmMock}
        onCancel={onCancelMock}
      />,
    );

    await flushInitialMountWarp();

    dragCorner(1, 20, 20);
    await waitFor(() => expect(warpDeferreds.length).toBe(1));

    // Unmount (simulates the user hitting Back / the screen navigating away)
    // with a warp still in flight.
    unmount();

    const orphan = makeBitmap();
    const inFlight = warpDeferreds[0];
    if (!inFlight) throw new Error('expected one warp deferred');
    await act(async () => {
      inFlight.resolve(warpResult(orphan));
      await Promise.resolve();
    });

    // The orphan bitmap was closed and onConfirm was never (and can never be,
    // post-unmount) invoked with it.
    expect((orphan as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(onConfirmMock).not.toHaveBeenCalled();
  });

  it('preserves a manual Oficio selection and exposes no post-capture aspect presets', async () => {
    const oficio = paperSelection('oficio', 'manual');
    const initialRecipe = createInitialRecipe(CONVEX_CORNERS, 'unknown', oficio);

    render(
      <CornerEditor
        pageId="oficio-page"
        originalBitmap={makeBitmap()}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        initialCorners={CONVEX_CORNERS}
        initialRecipe={initialRecipe}
        onConfirm={onConfirmMock}
        onCancel={onCancelMock}
      />,
    );

    await waitFor(() => expect(warpMock).toHaveBeenCalledTimes(1));
    const firstWarpArgs = warpMock.mock.calls[0] as unknown as [unknown, Quad, unknown];
    expect(firstWarpArgs[2]).toEqual({ mode: 'fixed', portraitRatio: 216 / 356 });

    const initial = warpDeferreds[0];
    if (!initial) throw new Error('expected initial Oficio warp');
    await act(async () => {
      initial.resolve(warpResult(makeBitmap()));
      await Promise.resolve();
    });

    goToAdjustStep();
    expect(screen.queryByTestId('aspect-ratio-selector')).toBeNull();
    // The measured quad is 2800 x 3800, deliberately not 216/356. The preview
    // must match the captured fixed Legal geometry sent to the worker.
    expect(screen.getByTestId('warped-preview-box').style.aspectRatio).toBe('2306 / 3800');
    fireEvent.click(screen.getByTestId('corner-editor-confirm'));
    expect(onConfirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipe: expect.objectContaining({ paper: oficio }) }),
    );
  });

  it('keeps automatic paper evidence unchanged through a corner re-warp', async () => {
    const initialRecipe = createInitialRecipe(
      A_SERIES_CORNERS,
      'unknown',
      paperSelection('original', 'auto', 'none', 1),
    );
    render(
      <CornerEditor
        pageId="a-series-page"
        originalBitmap={makeBitmap()}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        initialCorners={A_SERIES_CORNERS}
        initialRecipe={initialRecipe}
        onConfirm={onConfirmMock}
        onCancel={onCancelMock}
      />,
    );

    await waitFor(() => expect(warpMock).toHaveBeenCalledTimes(1));
    const firstWarpArgs = warpMock.mock.calls[0] as unknown as [unknown, Quad, unknown];
    expect(firstWarpArgs[2]).toEqual({ mode: 'measured' });
    const initial = warpDeferreds[0];
    if (!initial) throw new Error('expected initial A-series warp');
    await act(async () => {
      initial.resolve(warpResult(makeBitmap()));
      await Promise.resolve();
    });

    goToAdjustStep();
    fireEvent.click(screen.getByTestId('corner-editor-confirm'));
    expect(onConfirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe: expect.objectContaining({
          paper: initialRecipe.paper,
        }),
      }),
    );
  });
});

describe('CornerEditor redundant-tap guard (L2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warpDeferreds.length = 0;
    installCanvasShims();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a pointerdown + pointerup with NO pointermove does not dispatch a warp', async () => {
    render(
      <CornerEditor
        pageId="draft-1"
        originalBitmap={makeBitmap()}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        initialCorners={CONVEX_CORNERS}
        initialRecipe={null}
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
        pageId="draft-1"
        originalBitmap={makeBitmap()}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        initialCorners={CONVEX_CORNERS}
        initialRecipe={null}
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
