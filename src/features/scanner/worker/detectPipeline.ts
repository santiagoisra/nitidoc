/**
 * `detectPipeline.ts` — the OpenCV document-detection pipeline itself,
 * extracted verbatim from `opencv.worker.ts` so it can be exercised
 * directly by tests against a REAL OpenCV build.
 *
 * Why this module exists: `opencv.worker.ts` registers a
 * `self.addEventListener('message', ...)` side effect at import time and
 * exports nothing, so the pipeline could only ever be reached through the
 * worker message protocol. Every existing test therefore verified the
 * WIRING (does a DETECT round-trip reply?) and never the BEHAVIOR (does it
 * actually find a document?) — which is precisely how a pipeline that never
 * detected a real document stayed green across the whole suite.
 *
 * This module is 100% DOM-free and side-effect-free: it takes an injected
 * `CvBindings` and a plain `ImageData`, and owns/frees every `cv.Mat` it
 * allocates (design section 7). `opencv.worker.ts` remains the single
 * caller in production, for both DETECT and DETECT_IMAGEDATA.
 */

import { isConvex, orderCorners, reduceToQuad } from '@/features/scanner/lib/geometry';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import type { CvBindings, CvMat } from './cvBindings';
import type { Point, Quad, QualityMetrics } from './messages';

/**
 * `approxPolyDP` writes its output as a `CV_32SC2` Mat (contour points as
 * 32-bit-signed-int x/y pairs), never `CV_32FC2` — `contour.data32F` is
 * empty for it. Points are read from `contour.data32S` (fix H1): manually
 * reinterpreting `contour.data.buffer` with `contour.data.byteOffset` threw
 * `RangeError` whenever that byte offset wasn't a multiple of 4 (the WASM
 * heap offset of a given Mat is not guaranteed to be 4-byte aligned).
 * `data32S` is the Embind-provided view, already correctly aligned.
 */
function contourToPoints(contour: CvMat): Point[] {
  const points: Point[] = [];
  const int32 = contour.data32S;
  for (let i = 0; i + 1 < int32.length; i += 2) {
    points.push({ x: int32[i] as number, y: int32[i + 1] as number });
  }
  return points;
}

/**
 * `cv.meanStdDev` writes its mean/stddev outputs as 1x1 `CV_64F` Mats
 * (double precision), regardless of the input Mat's own type — so these
 * are always read via `.data64F`, never `.data32F`.
 */
function readScalar(mat: CvMat): number {
  return mat.data64F.length > 0 ? (mat.data64F[0] as number) : 0;
}

/**
 * Laplacian-variance/mean-intensity thresholds for `computeQuality` (design
 * section 4.5). Fase 2.3 (capture-ux-redesign.md, Unit 6): these used to
 * live in `detectionConstants.ts` (`DETECTION.BLUR_THRESHOLD`/
 * `DETECTION.DARK_THRESHOLD`), consumed by the live-detection loop's
 * `QualityHints` UI. Both were removed along with that UI, so `computeQuality`
 * — kept since it is harmless and still part of the unchanged DETECT/
 * DETECT_IMAGEDATA worker contract (`withQuality`/`QualityMetrics` in
 * `messages.ts`) — now sources its own two threshold constants locally
 * instead of importing dead ones. Values unchanged from the originals.
 */
const QUALITY_BLUR_THRESHOLD = 20;
const QUALITY_DARK_THRESHOLD = 60;

function computeQuality(cv: CvBindings, grayMat: CvMat): QualityMetrics {
  const laplacian = new cv.Mat();
  const laplacianMean = new cv.Mat();
  const laplacianStddev = new cv.Mat();
  const grayMean = new cv.Mat();
  const grayStddev = new cv.Mat();
  try {
    cv.Laplacian(grayMat, laplacian, cv.CV_64F);
    cv.meanStdDev(laplacian, laplacianMean, laplacianStddev);
    const laplacianStdDev = readScalar(laplacianStddev);
    const laplacianVariance = laplacianStdDev * laplacianStdDev;

    cv.meanStdDev(grayMat, grayMean, grayStddev);
    const meanIntensity = readScalar(grayMean);

    return {
      laplacianVariance,
      meanIntensity,
      isBlurry: laplacianVariance < QUALITY_BLUR_THRESHOLD,
      isDark: meanIntensity < QUALITY_DARK_THRESHOLD,
    };
  } finally {
    if (!laplacian.isDeleted()) laplacian.delete();
    if (!laplacianMean.isDeleted()) laplacianMean.delete();
    if (!laplacianStddev.isDeleted()) laplacianStddev.delete();
    if (!grayMean.isDeleted()) grayMean.delete();
    if (!grayStddev.isDeleted()) grayStddev.delete();
  }
}

/** Shoelace area of a quad, in square pixels. */
function quadArea(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i] as { x: number; y: number };
    const b = quad[(i + 1) % 4] as { x: number; y: number };
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Turns one contour into a validated quad, or null.
 *
 * The exact-4-point fast path is kept; 5..`MAX_APPROX_POINTS` points are
 * reduced via `reduceToQuad` (real paper edges soften into extra vertices
 * under shadow, texture or a slight curl).
 */
function contourToQuad(
  cv: CvBindings,
  contour: CvMat,
  approx: CvMat,
  width: number,
  height: number,
): Quad | null {
  const perimeter = cv.arcLength(contour, true);
  cv.approxPolyDP(contour, approx, DETECTION.POLY_APPROX_EPSILON_RATIO * perimeter, true);
  const points = contourToPoints(approx);

  let candidate: Quad | null = null;
  if (points.length === 4) {
    candidate = orderCorners(points);
  } else if (points.length > 4 && points.length <= DETECTION.MAX_APPROX_POINTS) {
    candidate = reduceToQuad(points);
  }
  if (!candidate) return null;

  const withinFrame = candidate.every((p) => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height);
  if (!withinFrame || !isConvex(candidate)) return null;

  return candidate;
}

/**
 * Builds the binary images the contour search runs over.
 *
 * WHY MORE THAN ONE, and why not the raw Canny map alone — this is the whole
 * bug this pipeline used to have:
 *
 * `findContours` on a RAW CANNY EDGE MAP returns 1px-wide OPEN polylines. A
 * border traced out-and-back encloses no area, so `contourArea` of the page
 * outline COLLAPSES to ~0 while its bounding box still spans a third of the
 * frame. Ranking by contour area therefore always picked a small CLOSED
 * shape — a glyph, a logo — over the page. Measured on a real camera capture
 * (tests/unit/fixtures/camera-capture-lorem.jpg):
 *
 *   page outline : bbox 365x610 (30.6% of frame) -> contourArea   6.0 px²
 *   winner       : bbox 104x19  (a word)         -> contourArea 442.0 px²
 *
 * Otsu thresholding yields CLOSED REGIONS instead of edges, so the page is a
 * filled blob whose area is real (34% of that same frame). It is tried first
 * because it is what actually recovers real-world captures. The
 * morphologically-closed Canny map is kept as a second opinion: Otsu is a
 * single global threshold and degrades under uneven lighting, where an edge
 * map still holds up.
 */
function buildDetectionMasks(cv: CvBindings, blurred: CvMat): { readonly name: string; readonly mask: CvMat }[] {
  const masks: { name: string; mask: CvMat }[] = [];

  const otsu = new cv.Mat();
  cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  masks.push({ name: 'otsu', mask: otsu });

  const edges = new cv.Mat();
  cv.Canny(blurred, edges, 75, 200);
  const closed = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  try {
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
  } finally {
    if (!kernel.isDeleted()) kernel.delete();
    if (!edges.isDeleted()) edges.delete();
  }
  masks.push({ name: 'canny-closed', mask: closed });

  return masks;
}

/**
 * Shared DETECT pipeline (design section 8 / task 6.7.1): both the normal
 * `ImageBitmap`-transferring path (`handleDetect`, extracts pixels via the
 * worker's internal OffscreenCanvas) and the no-OffscreenCanvas fallback
 * (`handleDetectImageData`, receives already-extracted `ImageData` from the
 * main thread) converge here once they have a plain `ImageData` in hand.
 *
 * cvtColor(GRAY) -> GaussianBlur -> {Otsu, closed-Canny} masks ->
 * findContours(RETR_EXTERNAL) -> top-N contours per mask -> approxPolyDP
 * (4-8 points, `reduceToQuad` above 4) -> orderCorners + isConvex ->
 * best quad BY QUAD AREA -> optional QualityMetrics.
 *
 * Candidates are scored by the area of the resulting QUAD, never by
 * `contourArea` of the raw contour: a quad is a closed polygon, so its area
 * is meaningful no matter how the mask that produced it was built.
 */
export function runDetectPipeline(
  cvBindings: CvBindings,
  imageData: ImageData,
  withQuality: boolean,
): { readonly corners: Quad | null; readonly quality: QualityMetrics | null } {
  const width = imageData.width;
  const height = imageData.height;

  let srcMat: CvMat | null = null;
  let grayMat: CvMat | null = null;
  let blurredMat: CvMat | null = null;
  let approx: CvMat | null = null;
  const masks: { readonly name: string; readonly mask: CvMat }[] = [];

  try {
    srcMat = cvBindings.matFromImageData(imageData);
    grayMat = new cvBindings.Mat();
    blurredMat = new cvBindings.Mat();
    approx = new cvBindings.Mat();

    cvBindings.cvtColor(srcMat, grayMat, cvBindings.COLOR_RGBA2GRAY);
    cvBindings.GaussianBlur(grayMat, blurredMat, new cvBindings.Size(5, 5), 0);

    masks.push(...buildDetectionMasks(cvBindings, blurredMat));

    const frameArea = width * height;
    const minArea = frameArea * DETECTION.MIN_CONTOUR_AREA_RATIO;
    const maxArea = frameArea * DETECTION.MAX_CONTOUR_AREA_RATIO;

    let corners: Quad | null = null;
    let bestArea = 0;

    for (const { mask } of masks) {
      const contours = new cvBindings.MatVector();
      const hierarchy = new cvBindings.Mat();
      try {
        cvBindings.findContours(
          mask,
          contours,
          hierarchy,
          cvBindings.RETR_EXTERNAL,
          cvBindings.CHAIN_APPROX_SIMPLE,
        );

        // Pass 1 — rank by contour area to pick which contours are worth a
        // polygon approximation. These masks are CLOSED regions, so contour
        // area is a meaningful ordering here (it is not on a raw edge map).
        // `MatVector.get(i)` allocates a NEW Mat the CALLER owns (design
        // section 7), so every one fetched is released before moving on.
        const ranked: { index: number; area: number }[] = [];
        const contourCount = contours.size();
        for (let i = 0; i < contourCount; i += 1) {
          const contour = contours.get(i);
          try {
            ranked.push({ index: i, area: cvBindings.contourArea(contour) });
          } finally {
            if (!contour.isDeleted()) contour.delete();
          }
        }
        ranked.sort((a, b) => b.area - a.area);

        // Pass 2 — approximate only the strongest few, and score the
        // resulting QUADS. The page is not always the single biggest region
        // (a shadow or a desk edge can outrank it), which is why this looks
        // past the winner instead of stopping at it.
        for (const { index } of ranked.slice(0, DETECTION.TOP_CONTOURS_PER_STRATEGY)) {
          const contour = contours.get(index);
          try {
            const candidate = contourToQuad(cvBindings, contour, approx, width, height);
            if (!candidate) continue;
            const area = quadArea(candidate);
            if (area < minArea || area > maxArea) continue;
            if (area > bestArea) {
              bestArea = area;
              corners = candidate;
            }
          } finally {
            if (!contour.isDeleted()) contour.delete();
          }
        }
      } finally {
        if (!hierarchy.isDeleted()) hierarchy.delete();
        if (!contours.isDeleted()) contours.delete();
      }
    }

    const quality = withQuality ? computeQuality(cvBindings, grayMat) : null;
    return { corners, quality };
  } finally {
    for (const { mask } of masks) {
      if (!mask.isDeleted()) mask.delete();
    }
    if (srcMat && !srcMat.isDeleted()) srcMat.delete();
    if (grayMat && !grayMat.isDeleted()) grayMat.delete();
    if (blurredMat && !blurredMat.isDeleted()) blurredMat.delete();
    if (approx && !approx.isDeleted()) approx.delete();
  }
}
