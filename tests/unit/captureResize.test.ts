import { describe, expect, it } from 'vitest';
import { capCaptureDimensions } from '@/features/scanner/lib/captureResize';

const MAX_PIXELS = 16_777_216; // 16MP, design section 6.4 / 7.

describe('capCaptureDimensions (task 3.6.3)', () => {
  it('returns the input unchanged when already within the 16MP budget', () => {
    const result = capCaptureDimensions(1920, 1080);
    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('downscales a 4K-ish frame that is still under the cap unchanged', () => {
    const result = capCaptureDimensions(3840, 2160); // 8,294,400 px < 16,777,216
    expect(result).toEqual({ width: 3840, height: 2160 });
  });

  it('downscales proportionally when the frame exceeds 16MP', () => {
    // A hypothetical 6000x4000 sensor: 24,000,000 px > 16,777,216.
    const width = 6000;
    const height = 4000;
    const result = capCaptureDimensions(width, height, MAX_PIXELS);

    expect(result.width * result.height).toBeLessThanOrEqual(MAX_PIXELS);
    // Aspect ratio preserved within rounding tolerance.
    const originalRatio = width / height;
    const resultRatio = result.width / result.height;
    expect(resultRatio).toBeCloseTo(originalRatio, 2);
  });

  it('produces dimensions exactly at or under the pixel budget for a square frame over the cap', () => {
    const result = capCaptureDimensions(5000, 5000, MAX_PIXELS);
    expect(result.width).toBe(result.height);
    expect(result.width * result.height).toBeLessThanOrEqual(MAX_PIXELS);
    // Should be close to sqrt(16_777_216) = 4096.
    expect(result.width).toBeCloseTo(4096, -1);
  });

  it('handles a landscape frame with a wide aspect ratio', () => {
    const width = 10000;
    const height = 2000; // ratio 5:1, 20,000,000 px total
    const result = capCaptureDimensions(width, height, MAX_PIXELS);

    expect(result.width * result.height).toBeLessThanOrEqual(MAX_PIXELS);
    expect(result.width / result.height).toBeCloseTo(width / height, 1);
  });

  it('never returns a dimension below 1px even for extreme aspect ratios', () => {
    const result = capCaptureDimensions(100_000, 1, MAX_PIXELS);
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it('respects a custom maxPixels budget', () => {
    const customMax = 1_000_000;
    const result = capCaptureDimensions(2000, 2000, customMax);
    expect(result.width * result.height).toBeLessThanOrEqual(customMax);
  });

  it('throws for non-positive or non-finite dimensions', () => {
    expect(() => capCaptureDimensions(0, 100)).toThrow(RangeError);
    expect(() => capCaptureDimensions(100, -1)).toThrow(RangeError);
    expect(() => capCaptureDimensions(Number.NaN, 100)).toThrow(RangeError);
    expect(() => capCaptureDimensions(100, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
