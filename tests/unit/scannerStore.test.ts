import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';
import type { CapturedFrame } from '@/shared/types/scanner';

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
