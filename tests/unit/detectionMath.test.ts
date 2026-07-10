import { describe, expect, it } from 'vitest';
import {
  contourAreaRatio,
  isTooFar,
  lerp,
  lerpPoint,
  lerpQuad,
  maxCornerStdDevPx,
  scaleCornersToFullRes,
  TOO_FAR_AREA_RATIO_THRESHOLD,
} from '@/features/scanner/lib/detectionMath';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import type { Point, Quad } from '@/shared/types/geometry';

function quad(points: readonly [Point, Point, Point, Point]): Quad {
  return points;
}

const RECT: Quad = quad([
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
]);

describe('lerp (task 4.2.1)', () => {
  it('returns prev when alpha is 0', () => {
    expect(lerp(10, 20, 0)).toBe(10);
  });

  it('returns next when alpha is 1', () => {
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it('interpolates proportionally for alpha in between', () => {
    expect(lerp(0, 100, 0.35)).toBeCloseTo(35, 5);
  });

  it('handles negative deltas', () => {
    expect(lerp(100, 0, 0.5)).toBeCloseTo(50, 5);
  });
});

describe('lerpPoint (task 4.2.1)', () => {
  it('interpolates both x and y independently', () => {
    const result = lerpPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5);
    expect(result).toEqual({ x: 5, y: 10 });
  });
});

describe('lerpQuad (task 4.2.1)', () => {
  it('returns the new quad unchanged when there is no previous quad (fade-in, no jump)', () => {
    const result = lerpQuad(null, RECT, 0.35);
    expect(result).toEqual(RECT);
  });

  it('interpolates every corner toward the new quad by alpha', () => {
    const prev = quad([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    const result = lerpQuad(prev, RECT, 0.5);
    expect(result[0]).toEqual({ x: 0, y: 0 });
    expect(result[2]).toEqual({ x: 50, y: 50 });
  });

  it('with alpha=1 snaps directly to the new quad', () => {
    const prev = quad([
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ]);
    const result = lerpQuad(prev, RECT, 1);
    expect(result).toEqual(RECT);
  });
});

describe('maxCornerStdDevPx (task 4.3.1; fix M-stability)', () => {
  it('returns 0 for an empty or single-sample buffer (nothing to vary yet)', () => {
    expect(maxCornerStdDevPx([])).toBe(0);
    expect(maxCornerStdDevPx([RECT])).toBe(0);
  });

  it('returns 0 when every quad in the buffer is identical (perfectly stable)', () => {
    const buffer = [RECT, RECT, RECT, RECT];
    expect(maxCornerStdDevPx(buffer)).toBe(0);
  });

  it('returns a positive stddev, in real linear pixels, when corners jitter between samples', () => {
    const jittered = quad([
      { x: 2, y: 1 },
      { x: 101, y: -1 },
      { x: 99, y: 102 },
      { x: -1, y: 99 },
    ]);
    const buffer = [RECT, jittered, RECT, jittered];
    expect(maxCornerStdDevPx(buffer)).toBeGreaterThan(0);
  });

  it('increases with larger jitter amplitude', () => {
    const smallJitter = quad([
      { x: 1, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
    const bigJitter = quad([
      { x: 10, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
    const smallBuffer = [RECT, smallJitter];
    const bigBuffer = [RECT, bigJitter];
    expect(maxCornerStdDevPx(bigBuffer)).toBeGreaterThan(maxCornerStdDevPx(smallBuffer));
  });

  it('returns a real LINEAR pixel unit, not a squared variance (regression for the bug that made auto-capture never fire)', () => {
    // A uniform +/-4px jitter on one axis should read as ~4px stddev, NOT
    // ~16 (which is what the old squared-variance implementation produced
    // and which made it impossible to ever cross a small pixel threshold).
    const jitteredBy4 = quad([
      { x: 4, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
    const buffer = [RECT, jitteredBy4];
    expect(maxCornerStdDevPx(buffer)).toBeCloseTo(2, 1);
  });

  it('classifies a tight cluster of corners (small handheld jitter) as stable at the calibrated threshold', () => {
    // Small jitter (~2px amplitude) across a buffer -> stddev well under
    // DETECTION.STABILITY_STDDEV_PX -> "stable".
    const tightBuffer = [
      RECT,
      quad([
        { x: 1, y: 1 },
        { x: 99, y: 1 },
        { x: 99, y: 99 },
        { x: 1, y: 99 },
      ]),
      quad([
        { x: -1, y: -1 },
        { x: 101, y: -1 },
        { x: 101, y: 101 },
        { x: -1, y: 101 },
      ]),
      RECT,
    ];
    expect(maxCornerStdDevPx(tightBuffer)).toBeLessThan(DETECTION.STABILITY_STDDEV_PX);
  });

  it('classifies a loose cluster of corners (large handheld shake) as NOT stable at the calibrated threshold', () => {
    // Large jitter (~20-30px amplitude) -> stddev well over
    // DETECTION.STABILITY_STDDEV_PX -> "not stable".
    const looseBuffer = [
      RECT,
      quad([
        { x: 25, y: 20 },
        { x: 125, y: -15 },
        { x: 130, y: 120 },
        { x: -20, y: 115 },
      ]),
      quad([
        { x: -20, y: -25 },
        { x: 75, y: 30 },
        { x: 70, y: 80 },
        { x: 20, y: 85 },
      ]),
    ];
    expect(maxCornerStdDevPx(looseBuffer)).toBeGreaterThan(DETECTION.STABILITY_STDDEV_PX);
  });
});

describe('scaleCornersToFullRes (task 4.4.2)', () => {
  it('scales corners proportionally from a downscaled frame to full resolution', () => {
    const detected = quad([
      { x: 10, y: 10 },
      { x: 630, y: 10 },
      { x: 630, y: 470 },
      { x: 10, y: 470 },
    ]);
    // 640px detection frame -> 3840px full-res capture: scale factor 6.
    const result = scaleCornersToFullRes(detected, 640, 3840);
    expect(result[0]).toEqual({ x: 60, y: 60 });
    expect(result[1]).toEqual({ x: 3780, y: 60 });
  });

  it('is a no-op scale (factor 1) when detection and full-res widths match', () => {
    const result = scaleCornersToFullRes(RECT, 640, 640);
    expect(result).toEqual(RECT);
  });

  it('throws when detectionFrameWidth is not positive', () => {
    expect(() => scaleCornersToFullRes(RECT, 0, 3840)).toThrow(RangeError);
    expect(() => scaleCornersToFullRes(RECT, -640, 3840)).toThrow(RangeError);
  });
});

describe('contourAreaRatio / isTooFar (task 4.5.2)', () => {
  it('computes the ratio of contour area to frame area', () => {
    // 100x100 contour inside a 640x480 frame.
    const ratio = contourAreaRatio(RECT, 640, 480);
    expect(ratio).toBeCloseTo((100 * 100) / (640 * 480), 5);
  });

  it('returns 0 when the frame area is non-positive (defensive)', () => {
    expect(contourAreaRatio(RECT, 0, 480)).toBe(0);
  });

  it('classifies a small contour relative to the frame as too far', () => {
    const smallQuad = quad([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ]);
    expect(isTooFar(smallQuad, 640, 480)).toBe(true);
  });

  it('classifies a contour filling most of the frame as NOT too far', () => {
    const bigQuad = quad([
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 450 },
      { x: 0, y: 450 },
    ]);
    expect(isTooFar(bigQuad, 640, 480)).toBe(false);
  });

  it('the threshold constant is exported and used consistently by isTooFar', () => {
    // A contour whose ratio sits exactly at the threshold should not be
    // "too far" (strict less-than), matching isTooFar's implementation.
    const frameW = 1000;
    const frameH = 1000;
    const side = Math.sqrt(TOO_FAR_AREA_RATIO_THRESHOLD * frameW * frameH);
    const boundaryQuad = quad([
      { x: 0, y: 0 },
      { x: side, y: 0 },
      { x: side, y: side },
      { x: 0, y: side },
    ]);
    expect(isTooFar(boundaryQuad, frameW, frameH)).toBe(false);
  });
});
