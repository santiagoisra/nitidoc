import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';
import type { CapturedFrame } from '@/shared/types/scanner';
import { NEUTRAL_FILTER } from '@/shared/types/scanner';

/**
 * Slice D adversarial review regression test for the store (H1).
 *
 * setOriginalFrame must close the previously retained full-res ImageBitmap
 * before overwriting it, so a second capture (auto + manual racing) cannot leak
 * the first frame's bitmap (design section 7 memory hygiene).
 */

interface FakeBitmap {
  readonly close: ReturnType<typeof vi.fn>;
}

function createFakeFrame(): { frame: CapturedFrame; bitmap: FakeBitmap } {
  const bitmap: FakeBitmap = { close: vi.fn() };
  const frame: CapturedFrame = {
    source: bitmap as unknown as ImageBitmap,
    width: 3000,
    height: 4000,
    capturedAt: Date.now(),
  };
  return { frame, bitmap };
}

describe('scannerStore.setOriginalFrame (H1)', () => {
  beforeEach(() => {
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the previously retained bitmap before overwriting it', () => {
    const first = createFakeFrame();
    const second = createFakeFrame();

    useScannerStore.getState().setOriginalFrame(first.frame);
    expect(useScannerStore.getState().originalFrame).toBe(first.frame);
    expect(useScannerStore.getState().phase).toBe('editing-corners');
    expect(first.bitmap.close).not.toHaveBeenCalled();

    // Second capture overwrites: the first bitmap MUST be closed.
    useScannerStore.getState().setOriginalFrame(second.frame);
    expect(first.bitmap.close).toHaveBeenCalledTimes(1);
    expect(second.bitmap.close).not.toHaveBeenCalled();
    expect(useScannerStore.getState().originalFrame).toBe(second.frame);
  });

  it('does not close when the same frame (same source) is set again (idempotent)', () => {
    const { frame, bitmap } = createFakeFrame();

    useScannerStore.getState().setOriginalFrame(frame);
    useScannerStore.getState().setOriginalFrame(frame);

    // Same underlying source — closing it would invalidate the live frame.
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('does not throw when there is no previous frame', () => {
    const { frame } = createFakeFrame();
    expect(() => useScannerStore.getState().setOriginalFrame(frame)).not.toThrow();
  });
});

/**
 * Slice E (Group 5) additions: setWarpedImage follows the same
 * close-before-overwrite hygiene as setOriginalFrame (design section 7), and
 * resetCaptureSlice must release BOTH retained bitmaps before resetting the
 * slice back to its initial state.
 */
describe('scannerStore.setWarpedImage', () => {
  beforeEach(() => {
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the previously retained warped bitmap before overwriting it', () => {
    const firstBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const secondBitmap = { close: vi.fn() } as unknown as ImageBitmap;

    useScannerStore.getState().setWarpedImage(firstBitmap);
    expect(useScannerStore.getState().warpedImage).toBe(firstBitmap);
    expect((firstBitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();

    useScannerStore.getState().setWarpedImage(secondBitmap);
    expect((firstBitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect((secondBitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
    expect(useScannerStore.getState().warpedImage).toBe(secondBitmap);
  });

  it('does not close when the same bitmap is set again (idempotent)', () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    useScannerStore.getState().setWarpedImage(bitmap);
    useScannerStore.getState().setWarpedImage(bitmap);
    expect((bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });

  it('does not throw when setting null (clearing the warped image)', () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    useScannerStore.getState().setWarpedImage(bitmap);
    expect(() => useScannerStore.getState().setWarpedImage(null)).not.toThrow();
    expect((bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().warpedImage).toBeNull();
  });
});

describe('scannerStore.resetCaptureSlice (design section 7 — release retained bitmaps on reset)', () => {
  beforeEach(() => {
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes both originalFrame.source and warpedImage before resetting the slice', () => {
    const { frame, bitmap: originalBitmap } = createFakeFrame();
    const warpedBitmap = { close: vi.fn() } as unknown as ImageBitmap;

    useScannerStore.getState().setOriginalFrame(frame);
    useScannerStore.getState().setWarpedImage(warpedBitmap);
    useScannerStore.getState().setRecipe({
      corners: frame.source as unknown as never,
      aspectRatio: 'a4',
      rotation: 0,
      flipH: false,
      flipV: false,
      filter: NEUTRAL_FILTER,
    });

    useScannerStore.getState().resetCaptureSlice();

    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect((warpedBitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().originalFrame).toBeNull();
    expect(useScannerStore.getState().warpedImage).toBeNull();
    expect(useScannerStore.getState().recipe).toBeNull();
    expect(useScannerStore.getState().phase).toBe('idle');
  });

  it('does not throw when resetting with nothing retained', () => {
    expect(() => useScannerStore.getState().resetCaptureSlice()).not.toThrow();
  });
});

/**
 * Group 6 / Slice F addition: setOpenCvStatus merges a partial patch onto the
 * existing OpenCvState (task 6.6.1) so callers (useDocumentDetection) don't
 * need to re-read+spread the whole state to update just `status` or just
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
