import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmapToImageData } from '@/features/scanner/lib/mainThreadImageData';

/**
 * Group 6 / Slice F unit tests for the no-OffscreenCanvas main-thread
 * extraction helper (task 6.7.1). happy-dom doesn't implement 2D canvas
 * pixel APIs, so `HTMLCanvasElement.getContext` is faked at the smallest
 * useful surface: enough to observe drawImage/getImageData being called
 * with the right arguments and the input bitmap being closed exactly once.
 */

interface FakeBitmap {
  readonly width: number;
  readonly height: number;
  readonly close: ReturnType<typeof vi.fn>;
}

function fakeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

describe('bitmapToImageData (task 6.7.1)', () => {
  let drawImageMock: ReturnType<typeof vi.fn>;
  let getImageDataMock: ReturnType<typeof vi.fn>;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    drawImageMock = vi.fn();
    const pixelData = new Uint8ClampedArray(4 * 4 * 4);
    getImageDataMock = vi.fn(() => ({ width: 4, height: 4, data: pixelData }));

    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: drawImageMock,
      getImageData: getImageDataMock,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
  });

  it('draws the bitmap, extracts ImageData at its dimensions, and closes the input bitmap', () => {
    const bitmap = fakeBitmap(4, 4);

    const result = bitmapToImageData(bitmap as unknown as ImageBitmap);

    expect(drawImageMock).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(getImageDataMock).toHaveBeenCalledWith(0, 0, 4, 4);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('closes the bitmap even when acquiring a 2d context fails', () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const bitmap = fakeBitmap(2, 2);

    expect(() => bitmapToImageData(bitmap as unknown as ImageBitmap)).toThrow();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});
