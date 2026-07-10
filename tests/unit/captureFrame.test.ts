import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropToVisibleRect } from '@/features/scanner/lib/captureFrame';

/**
 * Fase 2.3 (capture-ux-redesign.md, Unit 3) unit tests for
 * `cropToVisibleRect` (D-4 "WYSIWYG"): crops a captured full-res bitmap down
 * to exactly what the full-bleed `object-cover` preview was showing.
 */

function fakeBitmap(width: number, height: number): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

describe('cropToVisibleRect (design D-4 "WYSIWYG")', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the bitmap UNCHANGED (no crop, no close) when the box has no usable measurement', async () => {
    const bitmap = fakeBitmap(3000, 4000);
    const result = await cropToVisibleRect(bitmap, 1080, 1920, { width: 0, height: 0 });

    expect(result).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('returns the bitmap UNCHANGED when nativeWidth/nativeHeight are not usable (e.g. video metadata not loaded yet)', async () => {
    const bitmap = fakeBitmap(3000, 4000);
    const result = await cropToVisibleRect(bitmap, 0, 0, { width: 390, height: 844 });

    expect(result).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('returns the bitmap UNCHANGED when the source aspect already matches the box aspect', async () => {
    const bitmap = fakeBitmap(1080, 1920); // 0.5625
    const result = await cropToVisibleRect(bitmap, 1080, 1920, { width: 405, height: 720 }); // 0.5625

    expect(result).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('crops HEIGHT when the box is relatively WIDER than the source (object-cover crops top/bottom)', async () => {
    const bitmap = fakeBitmap(1200, 1600); // 4:3 portrait-ish source (0.75)
    const createImageBitmapMock = vi.fn(async () => fakeBitmap(1200, 1200));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    // Box aspect (1) > source aspect (0.75) -> crop height.
    const result = await cropToVisibleRect(bitmap, 1200, 1600, { width: 100, height: 100 });

    // cropHeightFraction = sourceAspect / boxAspect = 0.75 / 1 = 0.75
    // cropHeight = round(1600 * 0.75) = 1200; cropWidth unchanged = 1200.
    expect(createImageBitmapMock).toHaveBeenCalledWith(bitmap, 0, 200, 1200, 1200);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(result.width).toBe(1200);
    expect(result.height).toBe(1200);
  });

  it('crops WIDTH when the box is relatively TALLER/NARROWER than the source (object-cover crops left/right)', async () => {
    const bitmap = fakeBitmap(1600, 1200); // 4:3 landscape source (1.333)
    const createImageBitmapMock = vi.fn(async () => fakeBitmap(900, 1200));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    // Box aspect (0.5625, tall phone screen) < source aspect (1.333) -> crop width.
    await cropToVisibleRect(bitmap, 1600, 1200, { width: 390, height: 693.33 });

    // cropWidthFraction = boxAspect / sourceAspect = 0.5625 / 1.333... = 0.421875
    // cropWidth = round(1600 * 0.421875) = 675; x = round((1600-675)/2) = 463
    expect(createImageBitmapMock).toHaveBeenCalledWith(bitmap, 463, 0, 675, 1200);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('crops proportionally on the ACTUAL bitmap dimensions even when they differ in scale from nativeWidth/nativeHeight (16MP cap)', async () => {
    // Native video reports 1200x1600 (0.75 aspect, portrait), but the
    // captured bitmap was downscaled by the 16MP cap to 960x1280 — same
    // ratio (0.75), different scale.
    const bitmap = fakeBitmap(960, 1280);
    const createImageBitmapMock = vi.fn(async () => fakeBitmap(960, 960));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    await cropToVisibleRect(bitmap, 1200, 1600, { width: 100, height: 100 });

    // Same crop FRACTIONS as the first "crops HEIGHT" case (0.75 height
    // fraction), applied to the bitmap's OWN (capped) dimensions: cropHeight
    // = round(1280 * 0.75) = 960, y = round((1280-960)/2) = 160.
    expect(createImageBitmapMock).toHaveBeenCalledWith(bitmap, 0, 160, 960, 960);
  });

  it('returns the bitmap UNCHANGED (skips cropping, no close) when the captured bitmap\'s own aspect does not match nativeWidth/nativeHeight (review fix: e.g. a takePhoto() full-sensor capture with a different aspect than the preview track)', async () => {
    // Native/preview reports 1200x1600 (0.75 aspect, portrait), but the
    // captured bitmap is 1600x1200 (1.333 aspect, landscape) — a differently
    // shaped source than what the crop fractions below would be computed
    // against. Skipping the crop here is the fix; cropping anyway would cut
    // the wrong region out of the page.
    const bitmap = fakeBitmap(1600, 1200);
    const createImageBitmapMock = vi.fn(async () => fakeBitmap(1, 1));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const result = await cropToVisibleRect(bitmap, 1200, 1600, { width: 390, height: 693 });

    expect(result).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });
});
