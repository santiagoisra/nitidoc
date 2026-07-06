/**
 * Pure, DOM-free geometry primitives (design section 6). No dependency on
 * OpenCV or the DOM, so this module is testable in Node with Vitest. The
 * worker and the corner editor both reuse these exact implementations
 * (design ADR-004: single source of truth for corner ordering/convexity).
 */

import type { AspectRatio, AspectRatioName, Point, Quad } from '@/shared/types/geometry';
import { DETECTION } from './detectionConstants';

/**
 * Aspect ratio reference table for exact-name matching. 'ticket' is
 * detected separately by an elongation threshold, not by matching against
 * this table (design section 6.3).
 */
const ASPECT_RATIOS: ReadonlyArray<{ readonly name: 'a4' | 'letter'; readonly ratio: number }> = [
  { name: 'a4', ratio: 210 / 297 },
  { name: 'letter', ratio: 8.5 / 11 },
];

/** Elongation threshold (max/min side ratio) above which a quad is classified as a ticket. */
const TICKET_ELONGATION_THRESHOLD = 2.4;

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function centroid(points: readonly Point[]): Point {
  const sum = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Shoelace formula. Sign indicates winding order (positive = CCW in standard math axes). */
function signedArea(quad: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    if (!a || !b) continue;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Angle (radians) of the longest edge of the quad, used to find the document's "up" even when rotated. */
function dominantEdgeAngle(quad: readonly Point[]): number {
  let maxLen = -Infinity;
  let angle = 0;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    if (!a || !b) continue;
    const len = distance(a, b);
    if (len > maxLen) {
      maxLen = len;
      angle = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return angle;
}

function rotatePoint(p: Point, center: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * Test of convexity via consecutive cross products (design section 6.2).
 * The quad is convex iff all 4 consecutive cross products share the same
 * sign (all positive or all negative). A zero cross product means three
 * consecutive points are collinear, which is treated as a degenerate
 * (non-convex) quad.
 */
export function isConvex(quad: Quad): boolean {
  const points: readonly [Point, Point, Point, Point] = quad;
  const signs: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const a = points[i % 4] as Point;
    const b = points[(i + 1) % 4] as Point;
    const c = points[(i + 2) % 4] as Point;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return false;
    signs.push(Math.sign(cross));
  }
  return signs.every((s) => s === signs[0]);
}

/**
 * Orders 4 arbitrary corners into [topLeft, topRight, bottomRight,
 * bottomLeft] (design section 6.1).
 *
 * STARTING VALUE / R5 — the normalize-by-centroid-and-dominant-edge-angle
 * strategy below is a starting point that must be empirically verified
 * against rotated document fixtures (0/30/45/90 degrees and
 * near-vertical-inverted) per design section 11. The sum/difference
 * heuristic (TL=min(x+y), BR=max(x+y)) is used ONLY as a tie-breaker for
 * near-perfect squares where the dominant edge angle is ambiguous, exactly
 * as design section 6.1 specifies.
 */
export function orderCorners(points: readonly Point[]): Quad {
  const c = centroid(points);

  // 1. Sort by polar angle around the centroid — yields a consistent
  //    angular cycle around the quadrilateral.
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x),
  );

  // 2. Find the dominant edge angle and de-rotate the sorted points around
  //    the centroid so the longest edge aligns with the horizontal axis.
  //    In that de-rotated space, the classic sum heuristic is reliable.
  const angle = dominantEdgeAngle(sorted);
  const rotated = sorted.map((p) => rotatePoint(p, c, -angle));

  let tlIndex = 0;
  let tlScore = Infinity;
  let ambiguous = false;
  const scores: number[] = [];
  rotated.forEach((p, i) => {
    const score = p.x + p.y;
    scores.push(score);
    if (score < tlScore) {
      tlScore = score;
      tlIndex = i;
    }
  });

  // Tie-break for near-perfect squares: if two candidates are within a
  // small epsilon of the minimum score, dominant-edge-angle discrimination
  // is ambiguous; fall back to the plain sum heuristic on the ORIGINAL
  // (non-derotated) points, per design section 6.1's explicit fallback.
  const epsilon = 1e-6;
  const tiedCount = scores.filter((s) => Math.abs(s - tlScore) < epsilon).length;
  if (tiedCount > 1) {
    ambiguous = true;
  }

  if (ambiguous) {
    let fallbackIndex = 0;
    let fallbackScore = Infinity;
    sorted.forEach((p, i) => {
      const score = p.x + p.y;
      if (score < fallbackScore) {
        fallbackScore = score;
        fallbackIndex = i;
      }
    });
    tlIndex = fallbackIndex;
  }

  // 3. Rotate the angular cycle to start at tlIndex.
  const ordered = [
    sorted[tlIndex % sorted.length],
    sorted[(tlIndex + 1) % sorted.length],
    sorted[(tlIndex + 2) % sorted.length],
    sorted[(tlIndex + 3) % sorted.length],
  ] as [Point, Point, Point, Point];

  // 4. Force the winding that yields [TL, TR, BR, BL] in image coordinates
  //    (y grows downward). For a rectangle laid out as
  //    TL=(0,0), TR=(w,0), BR=(w,h), BL=(0,h), the shoelace signed area of
  //    that exact cycle is POSITIVE (verified: (0*0-w*0) + (w*h-w*0) +
  //    (w*h-0*h) + (0*0-0*h) = 2wh > 0). So a positive signed area means
  //    the cycle already reads TL->TR->BR->BL; a negative one means the
  //    cycle runs the other way and must be reversed (keeping index 0
  //    fixed as TL).
  const area = signedArea(ordered);
  if (area < 0) {
    return [ordered[0], ordered[3], ordered[2], ordered[1]] as Quad;
  }
  return ordered as Quad;
}

/**
 * Infers the aspect ratio classification of a quad (design section 6.3).
 * Elongated quads (max/min side ratio >= TICKET_ELONGATION_THRESHOLD) are
 * classified as 'ticket' before attempting a table match. Otherwise the
 * closest known ratio within ASPECT_TOLERANCE wins; anything outside
 * tolerance is 'unknown', keeping the measured ratio as-is.
 */
export function inferAspectRatio(quad: Quad): AspectRatio {
  const [tl, tr, br, bl] = quad;
  const wTop = distance(tl, tr);
  const wBottom = distance(bl, br);
  const hLeft = distance(tl, bl);
  const hRight = distance(tr, br);
  const w = (wTop + wBottom) / 2;
  const h = (hLeft + hRight) / 2;

  const maxSide = Math.max(w, h);
  const minSide = Math.min(w, h) || Number.EPSILON;
  const r = minSide / maxSide;

  if (maxSide / minSide >= TICKET_ELONGATION_THRESHOLD) {
    return { name: 'ticket', ratio: r };
  }

  let best: { name: 'a4' | 'letter'; ratio: number } | null = null;
  let bestDiff = Infinity;
  for (const candidate of ASPECT_RATIOS) {
    const diff = Math.abs(candidate.ratio - r);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }

  if (best && bestDiff <= DETECTION.ASPECT_TOLERANCE) {
    return { name: best.name, ratio: best.ratio };
  }

  const unknown: AspectRatioName = 'unknown';
  return { name: unknown, ratio: r };
}

/**
 * Computes the output dimensions of the warp for a given quad and chosen
 * aspect ratio (design section 6.4). The longer measured side is kept as
 * the anchor and the other side is derived from the known ratio; 'unknown'
 * and 'ticket' preserve the measured proportions.
 */
export function outputSize(
  corners: Quad,
  aspect: AspectRatioName,
): { readonly outW: number; readonly outH: number } {
  const [tl, tr, br, bl] = corners;
  const wMeasured = (distance(tl, tr) + distance(bl, br)) / 2;
  const hMeasured = (distance(tl, bl) + distance(tr, br)) / 2;
  const portrait = hMeasured >= wMeasured;

  if (aspect === 'unknown') {
    return { outW: Math.round(wMeasured), outH: Math.round(hMeasured) };
  }

  let ratio: number;
  if (aspect === 'a4') {
    ratio = 210 / 297;
  } else if (aspect === 'letter') {
    ratio = 8.5 / 11;
  } else {
    // 'ticket': preserve the measured proportions instead of a fixed table ratio.
    ratio = wMeasured / (hMeasured || Number.EPSILON);
  }

  if (portrait) {
    const outH = Math.round(hMeasured);
    return { outW: Math.round(outH * ratio), outH };
  }
  const outW = Math.round(wMeasured);
  return { outW, outH: Math.round(outW * ratio) };
}
