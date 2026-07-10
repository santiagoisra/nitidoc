import { describe, expect, it } from 'vitest';
import { lerp, lerpPoint, scaleCornersToFullRes } from '@/features/scanner/lib/detectionMath';
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
