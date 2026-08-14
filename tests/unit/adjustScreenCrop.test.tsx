import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Work Unit 2 (inline auto-crop) — `AdjustScreen`'s inline crop sub-mode.
 * Covers: entering crop (activatePage + CropOverlay render, with the async
 * decode-gap loading state), Cancelar (deactivateActivePage, pure discard,
 * back to filter), Listo (warp -> rewarpActivePage -> deactivateActivePage,
 * back to filter), and dragging a corner non-convex disables Listo.
 *
 * Mocking strategy (deliberately DIFFERENT from a hand-rolled
 * `useActivePage` mock): this suite uses the REAL `useActivePage` hook +
 * REAL `documentSlice` store actions, mocking only the LOW-LEVEL bitmap I/O
 * (`pageResources`) and the worker client (`workerClient`) — the same two
 * modules `adjustScreen.test.tsx`/`filterPanel.test.tsx` already mock. This
 * exercises activatePage/deactivateActivePage/rewarpActivePage's ACTUAL
 * orchestration against the real store (observable via
 * `useScannerStore.getState()`), which is more faithful than asserting call
 * counts on a hand-mocked hook, and avoids `vi.mock` factory/hoisting
 * fragility from trying to reference `useScannerStore` inside a
 * `useActivePage` mock factory.
 *
 * happy-dom limits (honest note, mirrors cropOverlay.test.tsx /
 * cornerEditorWarp.test.tsx): the drag test below reuses cropOverlay's own
 * `getBoundingClientRect` stub technique (no real layout engine under
 * happy-dom); no real OpenCV worker runs anywhere in this file
 * (`getSharedWorkerClient().warp` is fully mocked); the page-change safety
 * net (never stay in crop across a page switch) is NOT separately exercised
 * here since triggering it needs a real swipe via IntersectionObserver,
 * which happy-dom's `IntersectionObserver.observe()` stub never invokes
 * (same documented limitation `adjustScreen.test.tsx` already carries for
 * swipe-driven active-index sync).
 */

const decodeBlobToBitmapMock = vi.fn();
const makeThumbnailMock = vi.fn();
const compressBitmapToJpegMock = vi.fn();

vi.mock('@/features/scanner/lib/pageResources', () => ({
  decodeBlobToBitmap: (...args: unknown[]) => decodeBlobToBitmapMock(...args),
  makeThumbnail: (...args: unknown[]) => makeThumbnailMock(...args),
  compressBitmapToJpeg: (...args: unknown[]) => compressBitmapToJpegMock(...args),
}));

const warpMock = vi.fn();
vi.mock('@/features/scanner/lib/workerClient', () => ({
  getSharedWorkerClient: () => ({ warp: (...args: unknown[]) => warpMock(...args) }),
}));

import { AdjustScreen } from '@/features/scanner/components/AdjustScreen';
import { ToastHost } from '@/shared/ui';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';
import { createInitialRecipe } from '@/features/scanner/lib/editRecipe';
import { paperSelection } from '@/features/scanner/lib/paperFormats';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { Quad } from '@/shared/types/geometry';
import type { WarpResponse } from '@/features/scanner/worker/messages';

function fakeBitmap(width = 800, height = 1200): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function fakeWarpResult(bitmap: ImageBitmap): WarpResponse {
  return { id: 1, type: 'WARP_RESULT', bitmap, outWidth: bitmap.width, outHeight: bitmap.height };
}

function installCanvasShims(): void {
  const fakeCtx = {
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
}

const PAGE_CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

const A_SERIES_CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 210, y: 0 },
  { x: 210, y: 297 },
  { x: 0, y: 297 },
];

/** Corners for the drag test — matches cropOverlay.test.tsx's own 300x400 convention for a 1:1 (scale=1, no offset) letterbox mapping. */
const DRAG_TEST_CORNERS: Quad = [
  { x: 10, y: 10 },
  { x: 290, y: 10 },
  { x: 290, y: 390 },
  { x: 10, y: 390 },
];

function fakePage(overrides: Partial<DocumentPage> = {}): DocumentPage {
  return {
    id: overrides.id ?? 'page-1',
    order: overrides.order ?? 0,
    recipe: overrides.recipe ?? createInitialRecipe(PAGE_CORNERS, 'a4'),
    thumbnail: overrides.thumbnail ?? fakeBitmap(150, 200),
    originalBlob: overrides.originalBlob ?? ({} as Blob),
    warpedBlob: overrides.warpedBlob ?? ({} as Blob),
    originalWidth: overrides.originalWidth ?? 1000,
    originalHeight: overrides.originalHeight ?? 1400,
    warpedWidth: overrides.warpedWidth ?? 800,
    warpedHeight: overrides.warpedHeight ?? 1200,
  };
}

function renderAdjustScreen() {
  return render(
    <ToastHost>
      <AdjustScreen
        initialPageId={null}
        onPageChange={vi.fn()}
        onCrop={vi.fn()}
        onNext={vi.fn()}
        onAddMore={vi.fn()}
        onBack={vi.fn()}
      />
    </ToastHost>,
  );
}

describe('AdjustScreen inline crop mode (Work Unit 2)', () => {
  beforeEach(() => {
    decodeBlobToBitmapMock.mockReset();
    makeThumbnailMock.mockReset();
    compressBitmapToJpegMock.mockReset();
    warpMock.mockReset();
    decodeBlobToBitmapMock.mockImplementation(async () => fakeBitmap());
    makeThumbnailMock.mockImplementation(async () => fakeBitmap(150, 200));
    compressBitmapToJpegMock.mockImplementation(async () => new Blob());
    installCanvasShims();
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('entering crop mode (toolbar "Recortar") activates the page and renders CropOverlay once activeWorking resolves', async () => {
    useScannerStore.setState({ pages: [fakePage({ id: 'p1' })] });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    // Hold activatePage's decode open so the async gap between tapping
    // "Recortar" and `activeWorking` actually landing is observable.
    let resolveDecodes!: () => void;
    const decodeGate = new Promise<void>((resolve) => {
      resolveDecodes = resolve;
    });
    decodeBlobToBitmapMock.mockImplementation(async () => {
      await decodeGate;
      return fakeBitmap();
    });

    fireEvent.click(screen.getByTestId('adjust-crop'));

    // Crop toolbar is already up (Cancelar must work during this gap too —
    // see the Cancelar test), but the slide shows the loading state, not
    // CropOverlay, until activatePage's decode actually resolves.
    expect(screen.getByTestId('adjust-crop-toolbar')).toBeTruthy();
    expect(screen.getByTestId('adjust-crop-loading')).toBeTruthy();
    expect(screen.queryByTestId('corner-editor-canvas')).toBeNull();

    resolveDecodes();
    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());
    expect(screen.queryByTestId('adjust-crop-loading')).toBeNull();
    expect(useScannerStore.getState().activeWorking?.pageId).toBe('p1');
  });

  it('the crop chip overlaid on the active slide (filter mode) is a second entry point into the same crop mode', async () => {
    useScannerStore.setState({ pages: [fakePage({ id: 'p1' })] });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    expect(screen.getByTestId('adjust-crop-chip')).toBeTruthy();
    fireEvent.click(screen.getByTestId('adjust-crop-chip'));

    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());
    expect(useScannerStore.getState().activeWorking?.pageId).toBe('p1');
    // The chip only shows in filter mode.
    expect(screen.queryByTestId('adjust-crop-chip')).toBeNull();
  });

  it('Cancelar deactivates the active page (pure discard — nothing dirty) and returns to filter mode', async () => {
    useScannerStore.setState({ pages: [fakePage({ id: 'p1' })] });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    fireEvent.click(screen.getByTestId('adjust-crop'));
    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());
    expect(useScannerStore.getState().activeWorking?.pageId).toBe('p1');

    fireEvent.click(screen.getByTestId('adjust-crop-cancel'));

    await waitFor(() => expect(useScannerStore.getState().activeWorking).toBeNull());
    // Pure discard: nothing was ever marked dirty, so deactivate's dirty
    // path (the ONLY caller of compressBitmapToJpeg in this flow) must not
    // run. `makeThumbnail` is deliberately NOT asserted here — the real
    // (unstubbed) `FilterPanel` legitimately calls it for its own preset
    // preview tiles whenever `base` is available, unrelated to activePage
    // dirty/clean bookkeeping.
    expect(compressBitmapToJpegMock).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByTestId('adjust-toolbar')).toBeTruthy());
    expect(screen.queryByTestId('adjust-crop-toolbar')).toBeNull();
    expect(screen.queryByTestId('corner-editor-canvas')).toBeNull();
    // The filter-view base (released on crop entry) gets re-decoded on return.
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());
  });

  it('Listo warps, persists via rewarpActivePage + deactivateActivePage, and returns to filter mode', async () => {
    useScannerStore.setState({ pages: [fakePage({ id: 'p1' })] });
    const freshWarped = fakeBitmap(700, 1000);
    warpMock.mockResolvedValue(fakeWarpResult(freshWarped));

    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    fireEvent.click(screen.getByTestId('adjust-crop'));
    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());

    fireEvent.click(screen.getByTestId('adjust-crop-done'));

    await waitFor(() => expect(warpMock).toHaveBeenCalledTimes(1));
    const [, corners, geometry] = warpMock.mock.calls[0] as [unknown, Quad, unknown];
    expect(corners).toEqual(PAGE_CORNERS); // seeded from the page's existing recipe corners
    expect(geometry).toEqual({ mode: 'fixed', portraitRatio: 210 / 297 });

    // Dirty deactivate recompresses the fresh warped base into blob+thumbnail.
    await waitFor(() => expect(compressBitmapToJpegMock).toHaveBeenCalled());
    await waitFor(() => expect(useScannerStore.getState().activeWorking).toBeNull());
    expect(useScannerStore.getState().pages[0]?.recipe.corners).toEqual(PAGE_CORNERS);
    expect(useScannerStore.getState().pages[0]?.recipe.paper).toMatchObject({
      id: 'a4',
      source: 'auto',
      confidence: 'low',
    });
    // Ownership of the fresh warped bitmap transferred into the store, which
    // closes it once its pixels are compressed into the persisted blob.
    expect(freshWarped.close).toHaveBeenCalled();

    await waitFor(() => expect(screen.getByTestId('adjust-toolbar')).toBeTruthy());
    expect(screen.queryByTestId('adjust-crop-toolbar')).toBeNull();
    expect(screen.queryByTestId('corner-editor-canvas')).toBeNull();
  });

  it('keeps automatic paper evidence unchanged when confirmed corners are re-warped', async () => {
    const original = paperSelection('original', 'auto', 'none', 1);
    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', recipe: createInitialRecipe(A_SERIES_CORNERS, 'unknown', original) })],
    });
    warpMock.mockResolvedValue(fakeWarpResult(fakeBitmap(700, 1000)));

    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());
    fireEvent.click(screen.getByTestId('adjust-crop'));
    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());
    fireEvent.click(screen.getByTestId('adjust-crop-done'));

    await waitFor(() => expect(warpMock).toHaveBeenCalledTimes(1));
    expect(warpMock.mock.calls[0]?.[2]).toEqual({ mode: 'measured' });
    await waitFor(() => expect(useScannerStore.getState().activeWorking).toBeNull());
    expect(useScannerStore.getState().pages[0]?.recipe.paper).toMatchObject({
      id: 'original',
      source: 'auto',
      confidence: 'none',
    });
  });

  it('preserves a manual paper choice when later corners are confirmed', async () => {
    const manual = paperSelection('oficio', 'manual', 'none', 216 / 356);
    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', recipe: createInitialRecipe(A_SERIES_CORNERS, 'unknown', manual) })],
    });
    warpMock.mockResolvedValue(fakeWarpResult(fakeBitmap(700, 1000)));

    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('filter-preset-row')).toBeTruthy());
    expect(screen.queryByTestId('paper-selection-controls')).toBeNull();
    expect(screen.queryByTestId('paper-clear-auto')).toBeNull();
    fireEvent.click(screen.getByTestId('adjust-crop'));
    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());
    fireEvent.click(screen.getByTestId('adjust-crop-done'));

    await waitFor(() => expect(warpMock).toHaveBeenCalledTimes(1));
    expect(warpMock.mock.calls[0]?.[2]).toEqual({ mode: 'fixed', portraitRatio: 216 / 356 });
    await waitFor(() => expect(useScannerStore.getState().activeWorking).toBeNull());
    expect(useScannerStore.getState().pages[0]?.recipe.paper).toEqual(manual);
  });

  it('dragging a corner into a non-convex position disables Listo (CropOverlay -> AdjustScreen draft-corner wiring)', async () => {
    decodeBlobToBitmapMock.mockImplementation(async () => fakeBitmap(300, 400));
    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', recipe: createInitialRecipe(DRAG_TEST_CORNERS, 'a4') })],
    });

    // happy-dom has no real layout engine — stub the crop container's box to
    // exactly match the bitmap (scale 1, zero offset), same technique as
    // cropOverlay.test.tsx, so client coordinates map 1:1 to source points.
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

    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    fireEvent.click(screen.getByTestId('adjust-crop'));
    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());

    expect((screen.getByTestId('adjust-crop-done') as HTMLButtonElement).disabled).toBe(false);

    const handle = screen.getByTestId('corner-handle-0');
    // happy-dom's pointer capture is a no-op on a detached-ish element; guard
    // so the handlers under test still run (mirrors cropOverlay.test.tsx).
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};

    // Drag the top-left handle across the diagonal, past the opposite
    // corner's neighborhood — turns the quad self-intersecting (verified via
    // isConvex's cross-product signs: [+,+,+,-], not all equal).
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 280, clientY: 380 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 280, clientY: 380 });

    expect((screen.getByTestId('adjust-crop-done') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('corner-handle-0')).toHaveClass('border-danger');
  });

  it('finding H1: a warp still in flight from a CANCELLED session does not persist after re-entering crop on the same page', async () => {
    useScannerStore.setState({ pages: [fakePage({ id: 'p1' })] });

    // Hold session 1's warp open so we can Cancel + re-enter before it resolves.
    let resolveWarp1!: (r: WarpResponse) => void;
    const freshWarped1 = fakeBitmap(700, 1000);
    warpMock.mockImplementationOnce(
      () =>
        new Promise<WarpResponse>((resolve) => {
          resolveWarp1 = resolve;
        }),
    );

    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    // Session 1: enter crop, tap Listo → warp1 goes in flight (unresolved).
    fireEvent.click(screen.getByTestId('adjust-crop'));
    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());
    fireEvent.click(screen.getByTestId('adjust-crop-done'));
    await waitFor(() => expect(warpMock).toHaveBeenCalledTimes(1));

    // Cancel (explicit discard), then re-enter crop on the SAME page (session 2).
    fireEvent.click(screen.getByTestId('adjust-crop-cancel'));
    await waitFor(() => expect(useScannerStore.getState().activeWorking).toBeNull());
    fireEvent.click(screen.getByTestId('adjust-crop'));
    await waitFor(() => expect(screen.getByTestId('corner-editor-canvas')).toBeTruthy());
    expect(useScannerStore.getState().activeWorking?.pageId).toBe('p1');

    // Now the stale session-1 warp resolves — the crop-session token must make
    // it DISCARD itself (close the bitmap, no persist), NOT hijack session 2.
    resolveWarp1(fakeWarpResult(freshWarped1));

    await waitFor(() => expect(freshWarped1.close).toHaveBeenCalled());
    expect(compressBitmapToJpegMock).not.toHaveBeenCalled(); // never persisted the cancelled crop
    // The user stays in the re-entered (session 2) crop — not bounced to filter.
    expect(screen.getByTestId('adjust-crop-toolbar')).toBeTruthy();
    expect(screen.queryByTestId('adjust-toolbar')).toBeNull();
    expect(useScannerStore.getState().activeWorking?.pageId).toBe('p1');
  });
});
