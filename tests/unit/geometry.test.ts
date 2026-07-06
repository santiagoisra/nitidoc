import { describe, expect, it } from 'vitest';
import { inferAspectRatio, isConvex, orderCorners } from '@/features/scanner/lib/geometry';
import type { Point, Quad } from '@/shared/types/geometry';

function quad(points: readonly [Point, Point, Point, Point]): Quad {
  return points;
}

describe('isConvex (task 7.1.1)', () => {
  it('returns true for a convex quad (axis-aligned rectangle)', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(isConvex(q)).toBe(true);
  });

  it('returns true for a convex quad rotated arbitrarily', () => {
    const q = quad([
      { x: 5, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 5 },
    ]);
    expect(isConvex(q)).toBe(true);
  });

  it('returns false for a self-intersecting (bowtie) quad', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]);
    expect(isConvex(q)).toBe(false);
  });

  it('returns false for a degenerate quad with three collinear points', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ]);
    expect(isConvex(q)).toBe(false);
  });
});

describe('orderCorners (task 7.1.2)', () => {
  /**
   * Per design section 6.1 / design section 11 (R5): these tests validate
   * the CONTRACT (consistent [TL, TR, BR, BL] output order across
   * orientations), NOT any calibration threshold. The tie-break heuristic
   * and dominant-edge-angle detection are starting values pending
   * empirical verification on real rotated-document fixtures.
   */

  it('orders an axis-aligned (0deg) quad as [TL, TR, BR, BL] regardless of input order', () => {
    const shuffled: readonly Point[] = [
      { x: 10, y: 10 }, // BR
      { x: 0, y: 0 }, // TL
      { x: 0, y: 10 }, // BL
      { x: 10, y: 0 }, // TR
    ];
    const ordered = orderCorners(shuffled);
    expect(ordered[0]).toEqual({ x: 0, y: 0 });
    expect(ordered[1]).toEqual({ x: 10, y: 0 });
    expect(ordered[2]).toEqual({ x: 10, y: 10 });
    expect(ordered[3]).toEqual({ x: 0, y: 10 });
  });

  it('produces a convex, consistently-ordered quad for a 45-degree rotated square', () => {
    // A square rotated 45 degrees around its center (10,10), "radius" ~7.07.
    const points: readonly Point[] = [
      { x: 10, y: 2.93 }, // top vertex
      { x: 17.07, y: 10 }, // right vertex
      { x: 10, y: 17.07 }, // bottom vertex
      { x: 2.93, y: 10 }, // left vertex
    ];
    const ordered = orderCorners(points);
    expect(isConvex(ordered)).toBe(true);
    // Contract: whichever vertex is picked as TL, walking the returned
    // order must remain a valid cyclic (CW) traversal of the same 4 points.
    const orderedSet = new Set(ordered.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    const inputSet = new Set(points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    expect(orderedSet).toEqual(inputSet);
  });

  it('produces a convex, consistently-ordered quad for a 90-degree rotated rectangle', () => {
    // A 10x20 rectangle rotated so its long side is now horizontal.
    const points: readonly Point[] = [
      { x: 0, y: 5 },
      { x: 0, y: -5 },
      { x: 20, y: -5 },
      { x: 20, y: 5 },
    ];
    const ordered = orderCorners(points);
    expect(isConvex(ordered)).toBe(true);
    expect(ordered).toHaveLength(4);
  });

  it('is idempotent: re-ordering an already-ordered quad returns the same order', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    const reordered = orderCorners(q);
    expect(reordered).toEqual(q);
  });
});

describe('inferAspectRatio (task 7.1.3)', () => {
  it('classifies an A4-proportioned quad as "a4"', () => {
    // A4: 210mm x 297mm -> ratio ~0.7071. Use a portrait quad with that ratio.
    const width = 210;
    const height = 297;
    const q = quad([
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ]);
    const result = inferAspectRatio(q);
    expect(result.name).toBe('a4');
  });

  it('classifies a US-letter-proportioned quad as "letter"', () => {
    // Letter: 8.5in x 11in -> ratio ~0.7727.
    const width = 85;
    const height = 110;
    const q = quad([
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ]);
    const result = inferAspectRatio(q);
    expect(result.name).toBe('letter');
  });

  it('classifies a strongly elongated quad as "ticket"', () => {
    // A narrow receipt-like shape: width much smaller than height.
    const width = 50;
    const height = 300; // ratio 1:6, well past the 2.4 elongation threshold
    const q = quad([
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ]);
    const result = inferAspectRatio(q);
    expect(result.name).toBe('ticket');
  });

  it('classifies a quad outside all known tolerances as "unknown"', () => {
    // A near-square shape (ratio ~0.91) that doesn't match a4 (~0.71) or
    // letter (~0.77) within the 0.06 tolerance, and isn't elongated enough
    // to be a ticket.
    const width = 100;
    const height = 110;
    const q = quad([
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ]);
    const result = inferAspectRatio(q);
    expect(result.name).toBe('unknown');
  });
});
