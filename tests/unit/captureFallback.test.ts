import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeImportedFile, IMPORT_FALLBACK_ACCEPT } from '@/features/scanner/lib/captureFallback';

/**
 * Group 6 / Slice F unit tests for the import-fallback decode pipeline (task
 * 6.3.1). `createImageBitmap`/`OffscreenCanvas` are not implemented by
 * happy-dom, so both are faked at the smallest useful surface: enough to
 * observe (a) the 16MP cap is actually applied before the final bitmap is
 * produced, (b) the raw (pre-cap) bitmap is always closed, and (c) an
 * already-under-budget image is returned via the fast path without ever
 * touching a resize canvas.
 */

interface FakeBitmap {
  readonly width: number;
  readonly height: number;
  readonly close: ReturnType<typeof vi.fn>;
}

function fakeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

describe('decodeImportedFile (task 6.3.1)', () => {
  let createImageBitmapMock: ReturnType<typeof vi.fn>;
  let putImageDataMock: ReturnType<typeof vi.fn>;
  let drawImageMock: ReturnType<typeof vi.fn>;
  let transferToImageBitmapMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    drawImageMock = vi.fn();
    putImageDataMock = vi.fn();
    transferToImageBitmapMock = vi.fn(() => fakeBitmap(1, 1));

    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          drawImage: drawImageMock,
          putImageData: putImageDataMock,
        };
      }
      transferToImageBitmap() {
        return transferToImageBitmapMock(this.width, this.height);
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the decoded bitmap unchanged when already within the 16MP budget (fast path)', async () => {
    const raw = fakeBitmap(1920, 1080);
    createImageBitmapMock = vi.fn(async () => raw as unknown as ImageBitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const file = new File(['fake'], 'doc.png', { type: 'image/png' });
    const result = await decodeImportedFile(file);

    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.bitmap).toBe(raw);
    // Fast path returns the SAME bitmap it decoded — must not close it.
    expect(raw.close).not.toHaveBeenCalled();
    // No resize canvas should have been touched.
    expect(drawImageMock).not.toHaveBeenCalled();
  });

  it('downscales via OffscreenCanvas and closes the raw decoded bitmap when over the 16MP cap', async () => {
    // 6000x4000 = 24,000,000px > 16,777,216px cap.
    const raw = fakeBitmap(6000, 4000);
    createImageBitmapMock = vi.fn(async () => raw as unknown as ImageBitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const file = new File(['fake'], 'doc.png', { type: 'image/png' });
    const result = await decodeImportedFile(file);

    expect(result.width * result.height).toBeLessThanOrEqual(16_777_216);
    // Aspect ratio preserved.
    expect(result.width / result.height).toBeCloseTo(6000 / 4000, 2);
    // The oversized raw bitmap must be released once the capped copy exists.
    expect(raw.close).toHaveBeenCalledTimes(1);
    expect(drawImageMock).toHaveBeenCalledWith(raw, 0, 0, result.width, result.height);
  });

  it('rejects when the file cannot be decoded as an image', async () => {
    createImageBitmapMock = vi.fn(async () => {
      throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
    });
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const file = new File(['not-an-image'], 'notes.txt', { type: 'text/plain' });
    await expect(decodeImportedFile(file)).rejects.toThrow();
  });

  it('exposes a single-file, image-only accept filter (no drag&drop/multiple contract lives in the component)', () => {
    expect(IMPORT_FALLBACK_ACCEPT).toBe('image/*');
  });
});
