import { describe, expect, it } from 'vitest';
import {
  inferAspectRatio,
  isConvex,
  layoutSizeForRotation,
  orderCorners,
  outputSize,
} from '@/features/scanner/lib/geometry';
import type { Point, Quad } from '@/shared/types/geometry';

function quad(points: readonly [Point, Point, Point, Point]): Quad {
  return points;
}

/** Rotates a point around a center by `angleDeg` degrees (clockwise in screen/image coordinates). */
function rotatePointDeg(p: Point, center: Point, angleDeg: number): Point {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

function centroidOf(points: readonly Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function expectPointClose(actual: Point, expected: Point, epsilon = 0.01): void {
  expect(actual.x).toBeCloseTo(expected.x, 1);
  expect(actual.y).toBeCloseTo(expected.y, 1);
  void epsilon;
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

  /**
   * Regression fixtures for bug C1 (post-review): the previous
   * implementation de-rotated by the RAW dominant-edge angle (the longest
   * side), which for a PORTRAIT rectangle is one of the VERTICAL sides —
   * de-rotating by that angle swings the whole quad ~90 degrees and
   * `min(x+y)` then picks the WRONG vertex as top-left. Verified against
   * the old algorithm: a portrait 10x20 rect with TL(0,0) TR(10,0)
   * BR(10,20) BL(0,20), fed in as [TL,TR,BR,BL], came back as
   * [TR,BR,BL,TL] — a one-position rotation, mislabeling every corner.
   * These tests assert the EXACT identity of each corner (not just
   * isConvex + length), so they fail loudly against that old behavior and
   * pass against the fixed de-rotation (normalized modulo 90 degrees).
   */
  describe('portrait/landscape identity at 0/30/45 degrees (bug C1 regression)', () => {
    it('labels a PORTRAIT axis-aligned rectangle correctly (was the exact C1 failure case)', () => {
      // 10 wide x 20 tall: the longest side (20) is VERTICAL. This is the
      // exact shape that reproduced the bug.
      const tl = { x: 0, y: 0 };
      const tr = { x: 10, y: 0 };
      const br = { x: 10, y: 20 };
      const bl = { x: 0, y: 20 };
      const ordered = orderCorners([tl, tr, br, bl]);
      expectPointClose(ordered[0], tl);
      expectPointClose(ordered[1], tr);
      expectPointClose(ordered[2], br);
      expectPointClose(ordered[3], bl);
    });

    it('labels a LANDSCAPE axis-aligned rectangle correctly', () => {
      // 20 wide x 10 tall: the longest side (20) is HORIZONTAL.
      const tl = { x: 0, y: 0 };
      const tr = { x: 20, y: 0 };
      const br = { x: 20, y: 10 };
      const bl = { x: 0, y: 10 };
      const ordered = orderCorners([tl, tr, br, bl]);
      expectPointClose(ordered[0], tl);
      expectPointClose(ordered[1], tr);
      expectPointClose(ordered[2], br);
      expectPointClose(ordered[3], bl);
    });

    it('labels a shuffled-input PORTRAIT rectangle correctly regardless of input order', () => {
      const tl = { x: 0, y: 0 };
      const tr = { x: 10, y: 0 };
      const br = { x: 10, y: 20 };
      const bl = { x: 0, y: 20 };
      // Deliberately fed out of order, starting from BR.
      const ordered = orderCorners([br, bl, tl, tr]);
      expectPointClose(ordered[0], tl);
      expectPointClose(ordered[1], tr);
      expectPointClose(ordered[2], br);
      expectPointClose(ordered[3], bl);
    });

    for (const deg of [30, 45]) {
      it(`labels a PORTRAIT rectangle rotated ${deg} degrees correctly`, () => {
        const base: readonly Point[] = [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 20 },
          { x: 0, y: 20 },
        ];
        const c = centroidOf(base);
        const [tl, tr, br, bl] = base.map((p) => rotatePointDeg(p, c, deg));
        const ordered = orderCorners([tl as Point, tr as Point, br as Point, bl as Point]);
        expectPointClose(ordered[0], tl as Point);
        expectPointClose(ordered[1], tr as Point);
        expectPointClose(ordered[2], br as Point);
        expectPointClose(ordered[3], bl as Point);
      });

      it(`labels a LANDSCAPE rectangle rotated ${deg} degrees correctly`, () => {
        const base: readonly Point[] = [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 10 },
          { x: 0, y: 10 },
        ];
        const c = centroidOf(base);
        const [tl, tr, br, bl] = base.map((p) => rotatePointDeg(p, c, deg));
        const ordered = orderCorners([tl as Point, tr as Point, br as Point, bl as Point]);
        expectPointClose(ordered[0], tl as Point);
        expectPointClose(ordered[1], tr as Point);
        expectPointClose(ordered[2], br as Point);
        expectPointClose(ordered[3], bl as Point);
      });
    }
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

describe('outputSize (bug M1 review)', () => {
  /**
   * Design section 6.4's table ratio is width/height in PORTRAIT
   * (`ratio <= 1`). These tests assert that a landscape-oriented quad
   * yields the INVERTED proportion (outW/outH ~= 1/ratio), while a
   * portrait-oriented quad yields the table ratio directly
   * (outW/outH ~= ratio) — for both 'a4' and 'letter'.
   */
  const A4_RATIO = 210 / 297;
  const LETTER_RATIO = 8.5 / 11;

  it('produces PORTRAIT proportions for an A4 quad measured in portrait', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 210, y: 0 },
      { x: 210, y: 297 },
      { x: 0, y: 297 },
    ]);
    const { outW, outH } = outputSize(q, 'a4');
    expect(outW).toBeLessThan(outH);
    expect(outW / outH).toBeCloseTo(A4_RATIO, 2);
  });

  it('produces LANDSCAPE proportions for an A4 quad measured in landscape', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 297, y: 0 },
      { x: 297, y: 210 },
      { x: 0, y: 210 },
    ]);
    const { outW, outH } = outputSize(q, 'a4');
    expect(outW).toBeGreaterThan(outH);
    expect(outW / outH).toBeCloseTo(1 / A4_RATIO, 2);
  });

  it('produces PORTRAIT proportions for a letter quad measured in portrait', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 85, y: 0 },
      { x: 85, y: 110 },
      { x: 0, y: 110 },
    ]);
    const { outW, outH } = outputSize(q, 'letter');
    expect(outW).toBeLessThan(outH);
    expect(outW / outH).toBeCloseTo(LETTER_RATIO, 2);
  });

  it('produces LANDSCAPE proportions for a letter quad measured in landscape', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 110, y: 85 },
      { x: 0, y: 85 },
    ]);
    const { outW, outH } = outputSize(q, 'letter');
    expect(outW).toBeGreaterThan(outH);
    expect(outW / outH).toBeCloseTo(1 / LETTER_RATIO, 2);
  });

  it('preserves measured proportions as-is for "unknown" aspect', () => {
    const q = quad([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 150 },
      { x: 0, y: 150 },
    ]);
    const { outW, outH } = outputSize(q, 'unknown');
    expect(outW).toBe(100);
    expect(outH).toBe(150);
  });
});

describe('layoutSizeForRotation (Slice E review fix H3 — rotation-aware preview box)', () => {
  it('keeps the box unchanged at 0 degrees', () => {
    expect(layoutSizeForRotation(700, 990, 0)).toEqual({ outW: 700, outH: 990 });
  });

  it('swaps width and height at 90 degrees', () => {
    expect(layoutSizeForRotation(700, 990, 90)).toEqual({ outW: 990, outH: 700 });
  });

  it('keeps the box unchanged at 180 degrees', () => {
    expect(layoutSizeForRotation(700, 990, 180)).toEqual({ outW: 700, outH: 990 });
  });

  it('swaps width and height at 270 degrees', () => {
    expect(layoutSizeForRotation(700, 990, 270)).toEqual({ outW: 990, outH: 700 });
  });

  it('is an involution on width/height across a full 0->90->180->270->0 cycle', () => {
    // Two swaps (90 then another 90 == 180) cancel out; the identity dims are
    // recovered at 0 and 180.
    const base = { w: 700, h: 990 };
    expect(layoutSizeForRotation(base.w, base.h, 0)).toEqual({ outW: 700, outH: 990 });
    expect(layoutSizeForRotation(base.w, base.h, 180)).toEqual({ outW: 700, outH: 990 });
    // 90 and 270 both produce the swapped box.
    expect(layoutSizeForRotation(base.w, base.h, 90)).toEqual(
      layoutSizeForRotation(base.w, base.h, 270),
    );
  });
});
