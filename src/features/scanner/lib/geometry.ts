/**
 * Pure, DOM-free geometry primitives (design section 6). No dependency on
 * OpenCV or the DOM, so this module is testable in Node with Vitest. The
 * worker and the corner editor both reuse these exact implementations
 * (design ADR-004: single source of truth for corner ordering/convexity).
 */

import type { AspectRatio, AspectRatioName, Point, Quad } from '@/shared/types/geometry';
import type { WarpGeometry } from '@/shared/types/paper';
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
 * FIX (post-review C1) — the previous implementation de-rotated the quad by
 * the RAW dominant-edge angle (the angle of whichever edge was longest). For
 * a PORTRAIT rectangle the longest edge is one of the VERTICAL sides, so
 * de-rotating by that raw angle swings the whole quad ~90 degrees into a
 * landscape-like orientation in the de-rotated space — and `min(x+y)` then
 * picks the wrong vertex as top-left (verified: a portrait 10x20 rect with
 * TL(0,0) TR(10,0) BR(10,20) BL(0,20) came back as [TR,BR,BL,TL]). Square
 * and landscape quads happened to survive because their dominant edge is
 * already close to horizontal.
 *
 * FIX: normalize the de-rotation angle modulo 90 degrees into the range
 * `(-45deg, 45deg]` BEFORE de-rotating. Rotating a rectangle's dominant-edge
 * angle by a multiple of 90 degrees does not change which pairs of edges are
 * "the axis-aligned sides" — it only changes which one was picked as
 * longest. Restricting to the smallest-magnitude equivalent angle guarantees
 * the de-rotated quad is axis-aligned (both long AND short sides aligned to
 * the x/y axes) regardless of whether the long or the short edge was
 * dominant, so `min(x+y)` in that space reliably identifies the true
 * top-left corner for portrait, landscape, and square quads alike, at 0,
 * 30, and 45 degrees of rotation (verified numerically; see
 * tests/unit/geometry.test.ts).
 *
 * The sum/difference heuristic (TL=min(x+y)) is applied directly in the
 * de-rotated space; no separate axis-aligned fast path is needed since the
 * de-rotation is a no-op (angle ~0) for already-axis-aligned input.
 */
export function orderCorners(points: readonly Point[]): Quad {
  const c = centroid(points);

  // 1. Sort by polar angle around the centroid — yields a consistent
  //    angular cycle around the quadrilateral.
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x),
  );

  // 2. Find the dominant edge angle, then normalize it modulo 90 degrees to
  //    the smallest-magnitude equivalent in (-45deg, 45deg]. This is the
  //    core fix: it de-rotates by an angle that aligns the rectangle's axes
  //    without regard to which edge (long or short) happened to be
  //    dominant, so the derotated quad is always axis-aligned.
  const rawAngle = dominantEdgeAngle(sorted);
  const halfPi = Math.PI / 2;
  let angle = rawAngle;
  while (angle > Math.PI / 4) angle -= halfPi;
  while (angle <= -Math.PI / 4) angle += halfPi;

  const rotated = sorted.map((p) => rotatePoint(p, c, -angle));

  // 3. In the de-rotated (axis-aligned) space, TL = min(x+y) — the standard
  //    sum heuristic is now reliable because the quad's sides are aligned
  //    to the axes, independent of portrait/landscape orientation.
  let tlIndex = 0;
  let tlScore = Infinity;
  rotated.forEach((p, i) => {
    const score = p.x + p.y;
    if (score < tlScore) {
      tlScore = score;
      tlIndex = i;
    }
  });

  // 4. Rotate the angular cycle to start at tlIndex.
  const ordered = [
    sorted[tlIndex % sorted.length],
    sorted[(tlIndex + 1) % sorted.length],
    sorted[(tlIndex + 2) % sorted.length],
    sorted[(tlIndex + 3) % sorted.length],
  ] as [Point, Point, Point, Point];

  // 5. Force the winding that yields [TL, TR, BR, BL] in image coordinates
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
 * Reduces an arbitrary set of >= 4 points (typically an `approxPolyDP`
 * result with more than 4 vertices — shadows, texture, or a slight curl on
 * a real document commonly yield 5-8 points instead of a clean 4) down to
 * the 4 points most likely to be the document's true corners (Fase 2.2
 * punch-list item 1, root cause B).
 *
 * Method: the "extreme points" heuristic (the same sum/difference
 * projections `pyimagesearch`'s classic four-point-transform `order_points`
 * uses to LABEL 4 already-known corners, applied here to SELECT 4 corners
 * out of a larger point set):
 *  - min(x + y)  -> top-left-most extreme
 *  - max(x + y)  -> bottom-right-most extreme
 *  - min(x - y)  -> bottom-left-most extreme
 *  - max(x - y)  -> top-right-most extreme
 *
 * For a (possibly rotated) near-rectangular contour, the true 4 corners are
 * exactly the points that maximize/minimize these two projections — any
 * extra vertices introduced by noise sit strictly BETWEEN two true corners
 * along an edge, so they never win an extreme. This avoids needing an
 * explicit convex-hull step: the 4 extreme points of any point set already
 * lie on its convex hull.
 *
 * Returns `null` if fewer than 4 DISTINCT points are selected (a degenerate
 * shape where two extremes coincide — e.g. a triangle-like blob), which the
 * caller treats the same as "no valid contour this frame". The 4 selected
 * points are handed to `orderCorners` for the final canonical
 * [TL, TR, BR, BL] ordering — `orderCorners` already knows how to correctly
 * order 4 arbitrary corners regardless of rotation (ADR-004: single source
 * of truth for corner ordering), so this function does not duplicate that
 * logic.
 */
export function reduceToQuad(points: readonly Point[]): Quad | null {
  if (points.length < 4) {
    return null;
  }

  let minSum = points[0] as Point;
  let maxSum = points[0] as Point;
  let minDiff = points[0] as Point;
  let maxDiff = points[0] as Point;

  for (const p of points) {
    const sum = p.x + p.y;
    const diff = p.x - p.y;
    if (sum < minSum.x + minSum.y) minSum = p;
    if (sum > maxSum.x + maxSum.y) maxSum = p;
    if (diff < minDiff.x - minDiff.y) minDiff = p;
    if (diff > maxDiff.x - maxDiff.y) maxDiff = p;
  }

  const key = (p: Point): string => `${p.x},${p.y}`;
  const distinct = new Set([minSum, maxSum, minDiff, maxDiff].map(key));
  if (distinct.size < 4) {
    return null;
  }

  return orderCorners([minSum, maxDiff, maxSum, minDiff]);
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

/** Returns the orientation-neutral crop ratio used by the paper classifier. */
export function measuredQuadRatio(quad: Quad): number {
  const [tl, tr, br, bl] = quad;
  const w = (distance(tl, tr) + distance(bl, br)) / 2;
  const h = (distance(tl, bl) + distance(tr, br)) / 2;
  return Math.min(w, h) / (Math.max(w, h) || Number.EPSILON);
}

/**
 * Computes the output dimensions of the warp for a given quad and chosen
 * aspect ratio (design section 6.4). The longer measured side is kept as
 * the anchor and the other side is derived from the known ratio; 'unknown'
 * and 'ticket' preserve the measured proportions.
 */
export function outputSize(
  corners: Quad,
  geometry: WarpGeometry | AspectRatioName,
): { readonly outW: number; readonly outH: number } {
  const [tl, tr, br, bl] = corners;
  const wMeasured = (distance(tl, tr) + distance(bl, br)) / 2;
  const hMeasured = (distance(tl, bl) + distance(tr, br)) / 2;
  const portrait = hMeasured >= wMeasured;

  if (typeof geometry !== 'string' && geometry.mode === 'measured') {
    return { outW: Math.round(wMeasured), outH: Math.round(hMeasured) };
  }

  if (geometry === 'unknown') {
    return { outW: Math.round(wMeasured), outH: Math.round(hMeasured) };
  }

  let ratio: number;
  if (typeof geometry !== 'string') {
    ratio = geometry.portraitRatio;
  } else if (geometry === 'a4') {
    ratio = 210 / 297;
  } else if (geometry === 'letter') {
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

/**
 * Letterbox ("contain") mapping between a source frame (`sourceWidth` x
 * `sourceHeight`) and the CSS box it is drawn into (`containerWidth` x
 * `containerHeight`) via `object-fit: contain` / SVG `preserveAspectRatio="xMidYMid meet"`
 * (Fase 2.2 punch-list item 2, root cause fix). The source is scaled down
 * uniformly (never cropped) and centered, leaving letterbox bars on the
 * shorter axis.
 *
 * Returns `{ scale: 1, offsetX: 0, offsetY: 0 }` for any non-positive input —
 * a safe no-op mapping for the brief window before the container has been
 * measured, rather than dividing by zero.
 */
export interface LetterboxMapping {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function computeLetterboxMapping(
  sourceWidth: number,
  sourceHeight: number,
  containerWidth: number,
  containerHeight: number,
): LetterboxMapping {
  if (sourceWidth <= 0 || sourceHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.min(containerWidth / sourceWidth, containerHeight / sourceHeight);
  const offsetX = (containerWidth - sourceWidth * scale) / 2;
  const offsetY = (containerHeight - sourceHeight * scale) / 2;
  return { scale, offsetX, offsetY };
}

/** Maps a point in SOURCE (full-res frame) space to DISPLAY (letterboxed container) space. */
export function sourceToDisplay(point: Point, mapping: LetterboxMapping): Point {
  return {
    x: mapping.offsetX + point.x * mapping.scale,
    y: mapping.offsetY + point.y * mapping.scale,
  };
}

/**
 * Maps a point in DISPLAY (letterboxed container) space back to SOURCE (full-res
 * frame) space, clamped to `[0, sourceWidth] x [0, sourceHeight]` — a pointer
 * dragged into the letterbox bars still resolves to the nearest valid source
 * pixel instead of an out-of-frame coordinate.
 */
export function displayToSource(
  point: Point,
  mapping: LetterboxMapping,
  sourceWidth: number,
  sourceHeight: number,
): Point {
  const x = mapping.scale > 0 ? (point.x - mapping.offsetX) / mapping.scale : 0;
  const y = mapping.scale > 0 ? (point.y - mapping.offsetY) / mapping.scale : 0;
  return {
    x: Math.min(Math.max(x, 0), sourceWidth),
    y: Math.min(Math.max(y, 0), sourceHeight),
  };
}

/**
 * Layout (bounding-box) dimensions for a warped canvas that is rotated
 * NON-DESTRUCTIVELY via a CSS `transform: rotate()` (ADR-005; Slice E review
 * fix H3).
 *
 * The warped bitmap keeps its intrinsic `outW x outH` size. When the recipe's
 * rotation is 90 or 270 degrees the visible image occupies a box with WIDTH
 * and HEIGHT SWAPPED, so the layout container must reserve `outH x outW` for
 * the rotated image to fit at the correct aspect ratio instead of being
 * clipped or squashed (a 700x990 A4 rotated 90deg needs a 990x700 box). At 0
 * and 180 degrees the box is unchanged.
 */
export function layoutSizeForRotation(
  outW: number,
  outH: number,
  rotation: 0 | 90 | 180 | 270,
): { readonly outW: number; readonly outH: number } {
  if (rotation === 90 || rotation === 270) {
    return { outW: outH, outH: outW };
  }
  return { outW, outH };
}
