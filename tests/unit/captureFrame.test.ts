import * as captureFrame from '@/features/scanner/lib/captureFrame';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('captureFrame source ownership', () => {
  it('does not expose a preview-destructive crop API', () => {
    expect('cropToVisibleRect' in captureFrame).toBe(false);
  });

  it('uses decoded video dimensions when a manual guide needs preview-space pixels', async () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    const track = { getSettings: () => ({ width: 4000, height: 3000 }) } as MediaStreamTrack;
    const createImageBitmapMock = vi.fn(async (source: CanvasImageSource) => ({
      width: (source as HTMLVideoElement).videoWidth,
      height: (source as HTMLVideoElement).videoHeight,
      close: vi.fn(),
    } as unknown as ImageBitmap));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const result = await captureFrame.captureFullResFrame(video, track, false, true);

    expect(result).toMatchObject({ width: 1920, height: 1080 });
    expect(createImageBitmapMock).toHaveBeenCalledWith(video);
  });

  it('falls back to track dimensions when Safari has painted the preview before publishing intrinsic dimensions', async () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 0 },
      videoHeight: { configurable: true, value: 0 },
    });
    const track = { getSettings: () => ({ width: 4000, height: 3000 }) } as MediaStreamTrack;
    const createImageBitmapMock = vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() } as unknown as ImageBitmap));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const result = await captureFrame.captureFullResFrame(video, track, false, true);

    expect(result).toMatchObject({ width: 4000, height: 3000 });
    expect(createImageBitmapMock).toHaveBeenCalledWith(video);
  });
});
