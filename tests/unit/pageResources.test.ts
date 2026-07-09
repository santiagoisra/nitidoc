import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compressBitmapToJpeg,
  computeThumbnailDimensions,
  decodeBlobToBitmap,
  makeThumbnail,
} from '@/features/scanner/lib/pageResources';
import { FILTER } from '@/features/scanner/lib/filterConstants';

/**
 * Group 2 / PR5 unit tests for the layered-memory pure helpers (design
 * section 2.3). happy-dom implements neither `OffscreenCanvas` nor
 * `createImageBitmap`, so both are faked at the smallest useful surface —
 * same pattern as `captureFallback.test.ts`/`mainThreadImageData.test.ts`.
 */

interface FakeBitmap {
  readonly width: number;
  readonly height: number;
  readonly close: ReturnType<typeof vi.fn>;
}

function fakeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

describe('computeThumbnailDimensions — aspect-preserving downscale math (design section 2.3)', () => {
  it('downscales the longest edge to maxEdge, preserving aspect ratio', () => {
    const result = computeThumbnailDimensions(3000, 1500, 150);
    expect(result.width).toBe(150);
    expect(result.height).toBe(75);
  });

  it('downscales a portrait image on its longest (height) edge', () => {
    const result = computeThumbnailDimensions(1000, 2000, 150);
    expect(result.width).toBe(75);
    expect(result.height).toBe(150);
  });

  it('returns the original (rounded) dimensions unchanged when already within maxEdge — never upscales', () => {
    const result = computeThumbnailDimensions(100, 50, 150);
    expect(result).toEqual({ width: 100, height: 50 });
  });

  it('returns exact dimensions unchanged when the longest edge equals maxEdge exactly', () => {
    const result = computeThumbnailDimensions(150, 100, 150);
    expect(result).toEqual({ width: 150, height: 100 });
  });

  it('throws on non-positive or non-finite dimensions', () => {
    expect(() => computeThumbnailDimensions(0, 100, 150)).toThrow(RangeError);
    expect(() => computeThumbnailDimensions(100, -1, 150)).toThrow(RangeError);
    expect(() => computeThumbnailDimensions(Number.NaN, 100, 150)).toThrow(RangeError);
  });

  it('throws on a non-positive maxEdge', () => {
    expect(() => computeThumbnailDimensions(100, 100, 0)).toThrow(RangeError);
  });
});

describe('compressBitmapToJpeg (design section 2.3)', () => {
  let drawImageMock: ReturnType<typeof vi.fn>;
  let convertToBlobMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses OffscreenCanvas.convertToBlob when available, at the bitmap dimensions', async () => {
    drawImageMock = vi.fn();
    const fakeBlob = new Blob(['fake'], { type: 'image/jpeg' });
    convertToBlobMock = vi.fn(async () => fakeBlob);

    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: drawImageMock };
      }
      convertToBlob(options: { type: string; quality: number }) {
        return convertToBlobMock(options);
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    const bitmap = fakeBitmap(800, 1200);
    const result = await compressBitmapToJpeg(bitmap as unknown as ImageBitmap, 0.85);

    expect(drawImageMock).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(convertToBlobMock).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.85 });
    expect(result).toBe(fakeBlob);
    // This helper never closes the input bitmap — caller-owned (design section 2.2).
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('falls back to <canvas>.toBlob when OffscreenCanvas is unavailable', async () => {
    drawImageMock = vi.fn();
    const fakeBlob = new Blob(['fake'], { type: 'image/jpeg' });
    const toBlobMock = vi.fn(
      (callback: (blob: Blob | null) => void, _type: string, _quality: number) => callback(fakeBlob),
    );

    // happy-dom DOES define a global `OffscreenCanvas` (unlike a real
    // no-OffscreenCanvas browser), so the fallback branch must be forced by
    // stubbing it away explicitly rather than merely relying on its absence.
    vi.stubGlobal('OffscreenCanvas', undefined);

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: drawImageMock,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = toBlobMock as unknown as typeof HTMLCanvasElement.prototype.toBlob;

    try {
      const bitmap = fakeBitmap(400, 600);
      const result = await compressBitmapToJpeg(bitmap as unknown as ImageBitmap, 0.7);

      expect(drawImageMock).toHaveBeenCalledWith(bitmap, 0, 0);
      expect(toBlobMock).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.7);
      expect(result).toBe(fakeBlob);
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
    }
  });

  it('defaults quality to FILTER.JPEG_QUALITY when not provided', async () => {
    drawImageMock = vi.fn();
    const fakeBlob = new Blob(['fake'], { type: 'image/jpeg' });
    convertToBlobMock = vi.fn(async () => fakeBlob);

    class FakeOffscreenCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: drawImageMock };
      }
      convertToBlob(options: { type: string; quality: number }) {
        return convertToBlobMock(options);
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    await compressBitmapToJpeg(fakeBitmap(10, 10) as unknown as ImageBitmap);

    expect(convertToBlobMock).toHaveBeenCalledWith({ type: 'image/jpeg', quality: FILTER.JPEG_QUALITY });
  });
});

describe('decodeBlobToBitmap (design section 2.2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes a Blob via createImageBitmap', async () => {
    const bitmap = fakeBitmap(500, 700);
    const createImageBitmapMock = vi.fn(async () => bitmap as unknown as ImageBitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const blob = new Blob(['fake'], { type: 'image/jpeg' });
    const result = await decodeBlobToBitmap(blob);

    expect(createImageBitmapMock).toHaveBeenCalledWith(blob);
    expect(result).toBe(bitmap);
  });

  it('propagates a decode failure', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      }),
    );

    await expect(decodeBlobToBitmap(new Blob(['bad']))).rejects.toThrow();
  });
});

describe('makeThumbnail (design section 2.3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downscales via OffscreenCanvas.transferToImageBitmap, preserving aspect ratio', async () => {
    const drawImageMock = vi.fn();
    const thumb = fakeBitmap(150, 100);
    const transferToImageBitmapMock = vi.fn(() => thumb as unknown as ImageBitmap);

    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: drawImageMock };
      }
      transferToImageBitmap() {
        return transferToImageBitmapMock();
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    const source = fakeBitmap(3000, 2000);
    const result = await makeThumbnail(source as unknown as ImageBitmap, 150);

    expect(drawImageMock).toHaveBeenCalledWith(source, 0, 0, 150, 100);
    expect(transferToImageBitmapMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(thumb);
    // This helper never closes the input bitmap — caller-owned.
    expect(source.close).not.toHaveBeenCalled();
  });

  it('falls back to createImageBitmap(<canvas>) when OffscreenCanvas is unavailable', async () => {
    const drawImageMock = vi.fn();
    const thumb = fakeBitmap(75, 150);
    const createImageBitmapMock = vi.fn(async () => thumb as unknown as ImageBitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    // Force the fallback branch — happy-dom defines a global `OffscreenCanvas`.
    vi.stubGlobal('OffscreenCanvas', undefined);

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: drawImageMock,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      const source = fakeBitmap(1000, 2000);
      const result = await makeThumbnail(source as unknown as ImageBitmap, 150);

      expect(drawImageMock).toHaveBeenCalledWith(source, 0, 0, 75, 150);
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
      expect(result).toBe(thumb);
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  it('defaults maxEdge to FILTER.THUMBNAIL_MAX_EDGE when not provided', async () => {
    const drawImageMock = vi.fn();
    const transferToImageBitmapMock = vi.fn(() => fakeBitmap(150, 150) as unknown as ImageBitmap);

    class FakeOffscreenCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: drawImageMock };
      }
      transferToImageBitmap() {
        return transferToImageBitmapMock();
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    await makeThumbnail(fakeBitmap(FILTER.THUMBNAIL_MAX_EDGE * 4, FILTER.THUMBNAIL_MAX_EDGE * 2) as unknown as ImageBitmap);

    expect(drawImageMock).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      FILTER.THUMBNAIL_MAX_EDGE,
      FILTER.THUMBNAIL_MAX_EDGE / 2,
    );
  });
});
