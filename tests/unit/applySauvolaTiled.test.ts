import { describe, expect, it, vi } from 'vitest';
import {
  applySauvolaTiled,
  estimateSauvolaOwnedBytes,
  sauvolaWindowSize,
  writeBinaryMatToRgba,
} from '@/features/scanner/worker/applySauvolaTiled';
import { shouldApplyUnsharpSharpening } from '@/features/scanner/worker/filterRenderPolicy';
import type { CvBindings, CvMat } from '@/features/scanner/worker/cvBindings';

function pixel(value: number): readonly [number, number, number, number] {
  return [value, value, value, 255];
}

function image(values: readonly number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((value, index) => data.set(pixel(value), index * 4));
  return data;
}

function cvRound(value: number): number {
  const floor = Math.floor(value);
  return floor + (value - floor > 0.5 || (value - floor === 0.5 && floor % 2 !== 0) ? 1 : 0);
}

// Independent scalar oracle: mutating the production tiling, border clamp, or
// threshold formula must make these expected pixels differ.
function scalar(width: number, height: number, rgba: Uint8ClampedArray, brightness = 0, contrast = 0): number[] {
  const window = Math.max(31, Math.min(255, Math.round(Math.min(width, height) / 16) | 1));
  const halo = (window - 1) / 2;
  const at = (x: number, y: number) => {
    const offset = (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
    const gray = (9798 * (rgba[offset] ?? 0) + 19235 * (rgba[offset + 1] ?? 0) + 3735 * (rgba[offset + 2] ?? 0) + 16384) >> 15;
    return Math.min(255, cvRound(Math.abs(gray * (1 + contrast / 100) + brightness * 0.5)));
  };
  return Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    let sum = 0;
    let square = 0;
    for (let dy = -halo; dy <= halo; dy += 1) for (let dx = -halo; dx <= halo; dx += 1) {
      const value = at(x + dx, y + dy);
      sum += value;
      square += value * value;
    }
    const n = window * window;
    const mean = sum / n;
    const threshold = mean * (1 + 0.2 * (Math.sqrt(Math.max(0, square / n - mean * mean)) / 128 - 1));
    return at(x, y) <= threshold ? 0 : 255;
  });
}

interface MatAllocation {
  readonly rows: number;
  readonly cols: number;
  readonly type: number;
}

function fakeCv(onAllocate?: () => void, allocations?: MatAllocation[]): CvBindings {
  return {
    Mat: class implements CvMat {
      readonly rows: number;
      readonly cols: number;
      readonly data: Uint8Array;
      readonly data32F = new Float32Array();
      readonly data32S = new Int32Array();
      readonly data64F = new Float64Array();
      private deleted = false;
      constructor(rows = 0, cols = 0, type = 0) {
        onAllocate?.();
        allocations?.push({ rows, cols, type });
        this.rows = rows;
        this.cols = cols;
        this.data = new Uint8Array(rows * cols);
      }
      delete(): void { this.deleted = true; }
      isDeleted(): boolean { return this.deleted; }
    },
    CV_8UC1: 1,
  } as unknown as CvBindings;
}

describe('applySauvolaTiled', () => {
  it('catches a replicated-border or Sauvola-formula mutation with an independent scalar oracle', () => {
    const rgba = image([0, 40, 255, 20, 120, 240, 10, 180, 250]);
    const result = applySauvolaTiled(fakeCv(), { width: 3, height: 3, data: rgba }, 0, 0);
    expect([...result.data]).toEqual(scalar(3, 3, rgba));
  });

  it('catches a tile-coordinate horizontal seam mutation at the 512-pixel boundary', () => {
    const width = 514;
    const rgba = image(Array.from({ length: width * 2 }, (_, index) => (index * 37 + Math.floor(index / width) * 11) % 256));
    const result = applySauvolaTiled(fakeCv(), { width, height: 2, data: rgba }, 0, 0);
    expect([...result.data]).toEqual(scalar(width, 2, rgba));
  });

  it('catches a tile-coordinate vertical seam mutation at the 512-pixel boundary', () => {
    const height = 514;
    const rgba = image(Array.from({ length: height * 2 }, (_, index) => (index * 29 + Math.floor(index / 2) * 17) % 256));
    const result = applySauvolaTiled(fakeCv(), { width: 2, height, data: rgba }, 0, 0);
    expect([...result.data]).toEqual(scalar(2, height, rgba));
  });

  it('matches OpenCV classification for the documented pre-gain rounding and RGB edge fixtures', () => {
    const center = 480;
    const dark = image(Array.from({ length: 31 * 31 }, (_, index) => index === center ? 9 : 0));
    expect(applySauvolaTiled(fakeCv(), { width: 31, height: 31, data: dark }, -99, 0).data[center]).toBe(0);

    const color = image(Array.from({ length: 31 * 31 }, () => 197));
    color.set([174, 169, 55, 255], center * 4);
    expect(applySauvolaTiled(fakeCv(), { width: 31, height: 31, data: color }, 0, 0).data[center]).toBe(255);
  });

  it('matches OpenCV absolute pre-gain for a negative half-step and weighted grayscale', () => {
    const halfStep = image(Array.from({ length: 31 * 31 }, (_, index) => index === 480 ? 0 : 52));
    expect(applySauvolaTiled(fakeCv(), { width: 31, height: 31, data: halfStep }, -47, 0).data[480]).toBe(255); // abs(-23.5) rounds to 24.
    const rgba = new Uint8ClampedArray([10, 20, 30, 255]);
    const result = applySauvolaTiled(fakeCv(), { width: 1, height: 1, data: rgba }, -40, 0);
    expect([...result.data]).toEqual([255]);

    const exactGray = applySauvolaTiled(fakeCv(), { width: 1, height: 1, data: rgba }, -36, 0);
    expect([...exactGray.data]).toEqual([0]);
  });

  it('reuses the supplied RGBA transport buffer with binary RGB and opaque alpha', () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = writeBinaryMatToRgba(new Uint8Array([0, 255]), rgba);
    expect(result).toBe(rgba);
    expect([...rgba]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it('catches a non-binary output mutation after brightness and contrast pre-gain', () => {
    const rgba = image([0, 50, 100, 255]);
    const result = applySauvolaTiled(fakeCv(), { width: 4, height: 1, data: rgba }, 15, -10);
    expect([...result.data].every((value) => value === 0 || value === 255)).toBe(true);
  });

  it('catches an unbounded-allocation estimator mutation at 16MP', () => {
    const estimate = estimateSauvolaOwnedBytes(4000, 4000);
    expect(estimate.liveBytes).toBe(89_895_348);
    expect(estimate.fullPageFloatBytes).toBe(0);
    expect(sauvolaWindowSize(4000, 4000)).toBe(251);
  });

  it('catches leaked output ownership and wrong single-channel output allocation', () => {
    const allocations: MatAllocation[] = [];
    const cv = fakeCv(undefined, allocations);
    const success = applySauvolaTiled(cv, { width: 2, height: 1, data: image([20, 80]) }, 0, 0);
    expect(success.isDeleted()).toBe(false);
    expect(success.rows).toBe(1);
    expect(success.cols).toBe(2);
    expect(allocations).toEqual([{ rows: 1, cols: 2, type: 1 }]);

    const failure = new Error('allocation failed');
    const allocatingCv = fakeCv(() => { throw failure; });
    expect(() => applySauvolaTiled(allocatingCv, { width: 1, height: 1, data: image([20]) }, 0, 0)).toThrow(failure);

    const processingFailure = new Error('write failed');
    const deleted = vi.fn();
    const processingCv = {
      Mat: class {
        readonly rows = 1; readonly cols = 1;
        get data(): Uint8Array { throw processingFailure; }
        readonly data32F = new Float32Array(); readonly data32S = new Int32Array(); readonly data64F = new Float64Array();
        delete = deleted; isDeleted = () => false;
      }, CV_8UC1: 1,
    } as unknown as CvBindings;
    expect(() => applySauvolaTiled(processingCv, { width: 1, height: 1, data: image([20]) }, 0, 0)).toThrow(processingFailure);
    expect(deleted).toHaveBeenCalledOnce();
  });

  it('catches worker-policy regression that sharpens the adopted B&W path', () => {
    expect(shouldApplyUnsharpSharpening({ preset: 'bw', brightness: 0, contrast: 0, sharpness: 100 })).toBe(false);
  });
});
