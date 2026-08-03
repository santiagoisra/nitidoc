import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

/**
 * Combined-store WIRING tests (Group 1c / PR3, ADR-010). `DocumentSlice`'s
 * own state/action CONTRACT (close-before-overwrite, cap-30, delete/undo,
 * reorder, etc.) is exhaustively covered against an ISOLATED store in
 * `documentSlice.test.ts` — this file only proves that `scannerStore.ts`'s
 * `createDocumentActions(set, get)` adapter wires those SAME actions
 * correctly into the real combined `useScannerStore`, plus the
 * combined-store-only `OpenCvSlice` behavior (`setOpenCvStatus`).
 *
 * F1's legacy single-page capture slice (`originalFrame`/`warpedImage`/
 * `recipe`/`setPhase` owned by `CapturePhase`) is REMOVED (ADR-010) —
 * `DocumentSlice.phase` is now the sole `phase` owner. There is no
 * `setOriginalFrame`/`setWarpedImage`/`setRecipe`/legacy reset action left
 * anywhere in the store.
 */

function fakeBitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

describe('scannerStore <- DocumentSlice wiring (Group 1c)', () => {
  beforeEach(() => {
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with the DocumentSlice initial shape (pages/activeWorking/phase)', () => {
    expect(useScannerStore.getState().pages).toEqual([]);
    expect(useScannerStore.getState().activePageId).toBeNull();
    expect(useScannerStore.getState().activeWorking).toBeNull();
    expect(useScannerStore.getState().phase).toBe('welcome');
  });

  it('setPhase writes DocumentPhase values through the combined store (no legacy phase adapter left)', () => {
    useScannerStore.getState().setPhase('processing');
    expect(useScannerStore.getState().phase).toBe('processing');
    useScannerStore.getState().setPhase('grid');
    expect(useScannerStore.getState().phase).toBe('grid');
  });

  it('setActiveWorking close-before-overwrite works through the real combined store (design section 1.5)', () => {
    const first = { pageId: 'p1', originalBitmap: fakeBitmap(), warpedBase: fakeBitmap() };
    const second = { pageId: 'p1', originalBitmap: fakeBitmap(), warpedBase: fakeBitmap() };

    useScannerStore.getState().setActiveWorking(first);
    expect(useScannerStore.getState().activeWorking).toBe(first);
    expect(first.originalBitmap.close).not.toHaveBeenCalled();

    useScannerStore.getState().setActiveWorking(second);
    expect(first.originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(first.warpedBase.close).toHaveBeenCalledTimes(1);
    expect(second.originalBitmap.close).not.toHaveBeenCalled();
    expect(useScannerStore.getState().activeWorking).toBe(second);
  });
});

/**
 * Group 6 / Slice F addition: setOpenCvStatus merges a partial patch onto the
 * existing OpenCvState (task 6.6.1) so callers (`useOpenCvInit`) don't need
 * to re-read+spread the whole state to update just `status` or just
 * `progress`.
 */
describe('scannerStore.setOpenCvStatus (task 6.6.1)', () => {
  beforeEach(() => {
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  it('merges a partial patch onto the existing OpenCvState without clobbering other fields', () => {
    useScannerStore.getState().setOpenCvStatus({ status: 'loading', progress: 0.4 });
    expect(useScannerStore.getState().opencv).toMatchObject({
      status: 'loading',
      progress: 0.4,
      retryCount: 0,
      lastError: null,
    });

    useScannerStore.getState().setOpenCvStatus({ status: 'error', lastError: 'boom' });
    expect(useScannerStore.getState().opencv).toMatchObject({
      status: 'error',
      // progress from the PREVIOUS patch must survive this merge.
      progress: 0.4,
      lastError: 'boom',
    });
  });

  it('starts at the idle initial state', () => {
    expect(useScannerStore.getState().opencv).toEqual({
      status: 'idle',
      progress: 0,
      progressIndeterminate: false,
      retryCount: 0,
      lastError: null,
    });
  });
});
