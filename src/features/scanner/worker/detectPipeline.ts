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
import type { CvBindings, CvMat, CvMatVector } from './cvBindings';
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

/**
 * Shared DETECT pipeline (design section 8 / task 6.7.1): both the normal
 * `ImageBitmap`-transferring path (`handleDetect`, extracts pixels via the
 * worker's internal OffscreenCanvas) and the no-OffscreenCanvas fallback
 * (`handleDetectImageData`, receives already-extracted `ImageData` from the
 * main thread) converge here once they have a plain `ImageData` in hand —
 * cvtColor(GRAY) -> GaussianBlur -> Canny -> findContours -> largest-area
 * contour -> approxPolyDP (4-8 points, reduced to a quad via
 * `reduceToQuad` when > 4) -> orderCorners + isConvex -> optional
 * QualityMetrics. Single source of truth for the OpenCV pipeline itself.
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
  let edgesMat: CvMat | null = null;
  let contours: CvMatVector | null = null;
  let hierarchy: CvMat | null = null;
  let approx: CvMat | null = null;
  // Declared outside the try block (not just inside the loop) so the
  // `finally` below can also release it — it is a Mat owned by this
  // function like every other one here (design section 7).
  let largestContour: CvMat | null = null;

  try {
    srcMat = cvBindings.matFromImageData(imageData);
    grayMat = new cvBindings.Mat();
    blurredMat = new cvBindings.Mat();
    edgesMat = new cvBindings.Mat();
    contours = new cvBindings.MatVector();
    hierarchy = new cvBindings.Mat();
    approx = new cvBindings.Mat();

    cvBindings.cvtColor(srcMat, grayMat, cvBindings.COLOR_RGBA2GRAY);
    cvBindings.GaussianBlur(grayMat, blurredMat, new cvBindings.Size(5, 5), 0);
    cvBindings.Canny(blurredMat, edgesMat, 75, 200);
    cvBindings.findContours(edgesMat, contours, hierarchy, cvBindings.RETR_LIST, cvBindings.CHAIN_APPROX_SIMPLE);

    const frameArea = width * height;
    let largestArea = 0;
    const contourCount = contours.size();
    for (let i = 0; i < contourCount; i += 1) {
      // `MatVector.get(i)` allocates a NEW Mat on the WASM heap that the
      // CALLER owns (design section 7: "cada cv.Mat se libera con
      // .delete() en finally"). The loop must delete every losing contour
      // immediately and keep only the current winner alive; the winner
      // itself is deleted in the outer `finally` below.
      const contour = contours.get(i);
      const area = cvBindings.contourArea(contour);
      if (area > largestArea) {
        if (largestContour && !largestContour.isDeleted()) largestContour.delete();
        largestArea = area;
        largestContour = contour;
      } else {
        contour.delete();
      }
    }

    let corners: Quad | null = null;
    if (largestContour && largestArea >= frameArea * DETECTION.MIN_CONTOUR_AREA_RATIO) {
      const perimeter = cvBindings.arcLength(largestContour, true);
      cvBindings.approxPolyDP(largestContour, approx, DETECTION.POLY_APPROX_EPSILON_RATIO * perimeter, true);
      const points = contourToPoints(approx);

      // Fix (Fase 2.2 punch-list item 1, root cause B): the exact-4-points
      // fast path is preserved, but real document edges (shadows, texture, a
      // slight curl) commonly approximate to 5-`MAX_APPROX_POINTS` points
      // instead of a clean 4 — those used to be silently discarded here,
      // which is why detection "never worked" against real documents.
      // `reduceToQuad` (geometry.ts) derives the 4 most likely true corners
      // from the larger point set via the extreme-points method.
      let candidate: Quad | null = null;
      if (points.length === 4) {
        candidate = orderCorners(points);
      } else if (points.length > 4 && points.length <= DETECTION.MAX_APPROX_POINTS) {
        candidate = reduceToQuad(points);
      }

      if (candidate) {
        const withinFrame = candidate.every(
          (p) => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height,
        );
        if (withinFrame && isConvex(candidate)) {
          corners = candidate;
        }
      }
    }

    const quality = withQuality ? computeQuality(cvBindings, grayMat) : null;
    return { corners, quality };
  } finally {
    if (srcMat && !srcMat.isDeleted()) srcMat.delete();
    if (grayMat && !grayMat.isDeleted()) grayMat.delete();
    if (blurredMat && !blurredMat.isDeleted()) blurredMat.delete();
    if (edgesMat && !edgesMat.isDeleted()) edgesMat.delete();
    if (hierarchy && !hierarchy.isDeleted()) hierarchy.delete();
    if (approx && !approx.isDeleted()) approx.delete();
    if (largestContour && !largestContour.isDeleted()) largestContour.delete();
    if (contours && !contours.isDeleted()) contours.delete();
  }
}
