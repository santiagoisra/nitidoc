/// <reference lib="webworker" />

/**
 * `opencv.worker.ts` — 100% DOM-free. Owns every `cv.Mat`/`cv.MatVector`
 * it creates. Never imports React or touches `document`/`window` (design
 * section 0).
 *
 * Handlers:
 * - INIT: lazy-loads OpenCV.js (opencvLoader), forwards PROGRESS, replies
 *   INIT_DONE or ERROR{OPENCV_LOAD_FAILED}.
 * - DETECT: bitmap -> internal OffscreenCanvas -> getImageData ->
 *   cv.matFromImageData -> cvtColor(GRAY) -> GaussianBlur -> Canny ->
 *   findContours -> largest-area contour -> approxPolyDP(4 sides) ->
 *   orderCorners + isConvex -> optional QualityMetrics.
 * - DETECT_IMAGEDATA (task 6.7.1; design section 8): same pipeline as
 *   DETECT (via the shared `runDetectPipeline`), but skips the internal
 *   OffscreenCanvas draw step entirely — used when NEITHER the main thread
 *   NOR this worker's own global scope has `OffscreenCanvas` (historically
 *   Safari < 16.4). The main thread extracts `ImageData` itself instead.
 * - WARP: ImageDataLike -> cv.matFromImageData -> outputSize ->
 *   getPerspectiveTransform + warpPerspective -> ImageData ->
 *   OffscreenCanvas.putImageData -> transferToImageBitmap (ADR-003), or
 *   WARP_RESULT_IMAGEDATA when the caller has no OffscreenCanvas support
 *   (design section 8).
 */

import { isConvex, orderCorners, outputSize } from '@/features/scanner/lib/geometry';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { loadOpenCv } from '@/features/scanner/lib/opencvLoader';
import type { CvBindings, CvMat, CvMatVector } from './cvBindings';
import type {
  ApplyFilterRequest,
  ApplyFilterResponse,
  DetectRequest,
  DetectRequestImageData,
  DetectResponse,
  FilteredResult,
  FilterVariant,
  ImageDataLike,
  InitRequest,
  Point,
  ProgressEvent as WorkerProgressEvent,
  Quad,
  QualityMetrics,
  WarpRequest,
  WarpResponse,
  WarpResponseImageData,
  WorkerErrorCode,
  WorkerRequest,
  WorkerResponse,
} from './messages';

/** Minimum contour area (in the downscaled detection frame) to be considered a candidate document. */
const MIN_CONTOUR_AREA_RATIO = 0.1;

let cv: CvBindings | null = null;

// A single reusable OffscreenCanvas per operation kind, per design section 7
// ("reutilizar un unico OffscreenCanvas... no crear uno por frame").
let detectCanvas: OffscreenCanvas | null = null;
let detectCtx: OffscreenCanvasRenderingContext2D | null = null;
let warpCanvas: OffscreenCanvas | null = null;
let warpCtx: OffscreenCanvasRenderingContext2D | null = null;
let filterCanvas: OffscreenCanvas | null = null;
let filterCtx: OffscreenCanvasRenderingContext2D | null = null;

function getDetectContext(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!detectCanvas) {
    detectCanvas = new OffscreenCanvas(width, height);
    detectCtx = detectCanvas.getContext('2d');
  }
  if (detectCanvas.width !== width || detectCanvas.height !== height) {
    detectCanvas.width = width;
    detectCanvas.height = height;
  }
  if (!detectCtx) {
    throw new Error('Failed to acquire 2D context on the internal detection OffscreenCanvas.');
  }
  return detectCtx;
}

function getWarpContext(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!warpCanvas) {
    warpCanvas = new OffscreenCanvas(width, height);
    warpCtx = warpCanvas.getContext('2d');
  }
  if (warpCanvas.width !== width || warpCanvas.height !== height) {
    warpCanvas.width = width;
    warpCanvas.height = height;
  }
  if (!warpCtx) {
    throw new Error('Failed to acquire 2D context on the internal warp OffscreenCanvas.');
  }
  return warpCtx;
}

function getFilterContext(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!filterCanvas) {
    filterCanvas = new OffscreenCanvas(width, height);
    filterCtx = filterCanvas.getContext('2d');
  }
  if (filterCanvas.width !== width || filterCanvas.height !== height) {
    filterCanvas.width = width;
    filterCanvas.height = height;
  }
  if (!filterCtx) {
    throw new Error('Failed to acquire 2D context on the internal filter OffscreenCanvas.');
  }
  return filterCtx;
}

function postResponse(response: WorkerResponse, transfer: readonly Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(response, transfer as Transferable[]);
}

function replyError(id: number, code: WorkerErrorCode, message: string): void {
  postResponse({ id, type: 'ERROR', code, message });
}

/**
 * Converts an `approxPolyDP` result contour into plain Points.
 *
 * `approxPolyDP`'s output Mat is always `CV_32SC2` (a flat list of
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

async function handleInit(request: InitRequest): Promise<void> {
  try {
    const { cv: loaded } = await loadOpenCv((progress, indeterminate) => {
      const event: WorkerProgressEvent = { id: request.id, type: 'PROGRESS', progress: indeterminate ? 0 : progress };
      postResponse(event);
    }, request.assetUrl);
    cv = loaded as unknown as CvBindings;
    postResponse({ id: request.id, type: 'INIT_DONE' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown OpenCV.js load failure.';
    replyError(request.id, 'OPENCV_LOAD_FAILED', message);
  }
}

/**
 * `cv.meanStdDev` writes its mean/stddev outputs as 1x1 `CV_64F` Mats
 * (double precision), regardless of the input Mat's own type — so these
 * are always read via `.data64F`, never `.data32F`.
 */
function readScalar(mat: CvMat): number {
  return mat.data64F.length > 0 ? (mat.data64F[0] as number) : 0;
}

function computeQuality(grayMat: CvMat): QualityMetrics {
  if (!cv) throw new Error('OpenCV not initialized.');
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
      isBlurry: laplacianVariance < DETECTION.BLUR_THRESHOLD,
      isDark: meanIntensity < DETECTION.DARK_THRESHOLD,
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
 * contour -> approxPolyDP(4 sides) -> orderCorners + isConvex -> optional
 * QualityMetrics. Single source of truth for the OpenCV pipeline itself.
 */
function runDetectPipeline(
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
    if (largestContour && largestArea >= frameArea * MIN_CONTOUR_AREA_RATIO) {
      const perimeter = cvBindings.arcLength(largestContour, true);
      cvBindings.approxPolyDP(largestContour, approx, 0.02 * perimeter, true);
      const points = contourToPoints(approx);

      if (points.length === 4) {
        const withinFrame = points.every(
          (p) => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height,
        );
        const candidate = orderCorners(points);
        if (withinFrame && isConvex(candidate)) {
          corners = candidate;
        }
      }
    }

    const quality = withQuality ? computeQuality(grayMat) : null;
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

async function handleDetect(request: DetectRequest): Promise<void> {
  if (!cv) {
    replyError(request.id, 'NOT_INITIALIZED', 'DETECT received before INIT_DONE.');
    request.bitmap.close();
    return;
  }

  const { bitmap, withQuality } = request;
  const width = bitmap.width;
  const height = bitmap.height;

  try {
    const ctx = getDetectContext(width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);

    const { corners, quality } = runDetectPipeline(cv, imageData, withQuality);
    const response: DetectResponse = { id: request.id, type: 'DETECT_RESULT', corners, quality };
    postResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown DETECT failure.';
    replyError(request.id, 'DETECT_FAILED', message);
  } finally {
    bitmap.close();
  }
}

/**
 * Fallback DETECT entry point (task 6.7.1; design section 8): used when
 * NEITHER the main thread NOR the worker's own global scope has
 * `OffscreenCanvas` available. The main thread has already extracted
 * `ImageData` itself (via a regular `<canvas>`), so this skips the
 * `getDetectContext`/`drawImage`/`getImageData` step entirely and feeds the
 * SAME `runDetectPipeline` directly — single source of truth for the OpenCV
 * algorithm regardless of which path produced the `ImageData`.
 */
async function handleDetectImageData(request: DetectRequestImageData): Promise<void> {
  if (!cv) {
    replyError(request.id, 'NOT_INITIALIZED', 'DETECT received before INIT_DONE.');
    return;
  }

  try {
    const imageData = imageDataLikeToImageData(request.image);
    const { corners, quality } = runDetectPipeline(cv, imageData, request.withQuality);
    const response: DetectResponse = { id: request.id, type: 'DETECT_RESULT', corners, quality };
    postResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown DETECT failure.';
    replyError(request.id, 'DETECT_FAILED', message);
  }
}

function buildTransformMats(cvBindings: CvBindings, corners: Quad, outW: number, outH: number) {
  const srcData = corners.flatMap((p) => [p.x, p.y]);
  const dstData = [0, 0, outW, 0, outW, outH, 0, outH];
  const srcMat = cvBindings.matFromArray(4, 1, cvBindings.CV_32FC2, srcData);
  const dstMat = cvBindings.matFromArray(4, 1, cvBindings.CV_32FC2, dstData);
  return { srcMat, dstMat };
}

/**
 * Builds a `Uint8ClampedArray` guaranteed to be backed by a plain
 * `ArrayBuffer` (never `SharedArrayBuffer`), which is what the DOM lib's
 * `ImageData` constructor type requires. Transferred/received buffers in
 * this pipeline are always plain `ArrayBuffer`s in practice; this copy
 * satisfies the type without a cast.
 */
function toPlainClampedArray(source: Uint8Array | Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const copy = new ArrayBuffer(source.byteLength);
  new Uint8Array(copy).set(source);
  return new Uint8ClampedArray(copy);
}

function imageDataLikeToImageData(image: ImageDataLike): ImageData {
  return new ImageData(toPlainClampedArray(image.data), image.width, image.height);
}

async function handleWarp(request: WarpRequest, offscreenSupported: boolean): Promise<void> {
  if (!cv) {
    replyError(request.id, 'NOT_INITIALIZED', 'WARP received before INIT_DONE.');
    return;
  }

  const { image, corners, aspectRatio } = request;

  let srcMat: CvMat | null = null;
  let dstMat: CvMat | null = null;
  let srcPointsMat: CvMat | null = null;
  let dstPointsMat: CvMat | null = null;
  let transformMat: CvMat | null = null;

  try {
    const imageData = imageDataLikeToImageData(image);
    srcMat = cv.matFromImageData(imageData);

    const { outW, outH } = outputSize(corners, aspectRatio);
    // inferAspectRatio is not re-invoked here: the caller (main thread)
    // already resolved the final aspectRatio (auto-inferred or manual
    // override) before sending WARP, per design section 2.2 / perspective
    // spec "Usuario sobrescribe el aspect ratio inferido".
    const built = buildTransformMats(cv, corners, outW, outH);
    srcPointsMat = built.srcMat;
    dstPointsMat = built.dstMat;

    transformMat = cv.getPerspectiveTransform(srcPointsMat, dstPointsMat);
    dstMat = new cv.Mat();
    cv.warpPerspective(srcMat, dstMat, transformMat, new cv.Size(outW, outH));

    const outImageData = new ImageData(toPlainClampedArray(dstMat.data), outW, outH);

    if (offscreenSupported) {
      const ctx = getWarpContext(outW, outH);
      ctx.putImageData(outImageData, 0, 0);
      const resultBitmap = (warpCanvas as OffscreenCanvas).transferToImageBitmap();
      const response: WarpResponse = {
        id: request.id,
        type: 'WARP_RESULT',
        bitmap: resultBitmap,
        outWidth: outW,
        outHeight: outH,
      };
      postResponse(response, [resultBitmap]);
    } else {
      // Fallback path (design section 8): no OffscreenCanvas available on
      // the caller's side. Return plain pixel data instead of a bitmap.
      const clonedData = new Uint8ClampedArray(outImageData.data);
      const response: WarpResponseImageData = {
        id: request.id,
        type: 'WARP_RESULT_IMAGEDATA',
        image: { width: outW, height: outH, data: clonedData },
        outWidth: outW,
        outHeight: outH,
      };
      postResponse(response, [clonedData.buffer]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown WARP failure.';
    replyError(request.id, 'WARP_FAILED', message);
  } finally {
    if (srcMat && !srcMat.isDeleted()) srcMat.delete();
    if (dstMat && !dstMat.isDeleted()) dstMat.delete();
    if (srcPointsMat && !srcPointsMat.isDeleted()) srcPointsMat.delete();
    if (dstPointsMat && !dstPointsMat.isDeleted()) dstPointsMat.delete();
    if (transformMat && !transformMat.isDeleted()) transformMat.delete();
  }
}

/** 3x3 identity kernel — the "no sharpen" endpoint of the unsharp blend (design section 4.4). */
const IDENTITY_KERNEL_3X3: readonly number[] = [0, 0, 0, 0, 1, 0, 0, 0, 0];
/** 3x3 unsharp kernel — the "full sharpen" endpoint of the unsharp blend (design section 4.4). */
const SHARPEN_KERNEL_3X3: readonly number[] = [0, -1, 0, -1, 5, -1, 0, -1, 0];

const ADAPTIVE_PRESETS: ReadonlySet<FilterVariant['preset']> = new Set(['bw', 'bw-high-contrast', 'eco']);

/**
 * Renders one `FilterVariant` over the shared, per-request `srcMat`
 * (RGBA)/`grayMat` (single-channel), owning and releasing every Mat it
 * allocates EXCEPT the one it returns (design section 4.4 pipeline;
 * F1 section 7 Mat hygiene). The caller owns (and must `.delete()`) the
 * returned Mat.
 *
 * `srcMat`/`grayMat` are NEVER mutated in place: every branch below writes
 * into a freshly-allocated Mat (`convertScaleAbs`/`adaptiveThreshold` with a
 * distinct `dst`), so the shared base is safe to reuse across every variant
 * in a batched request (design section 4.3).
 */
function applyVariant(cvBindings: CvBindings, srcMat: CvMat, grayMat: CvMat, variant: FilterVariant): CvMat {
  let work: CvMat | null = null;
  let stage1: CvMat | null = null;
  let kernel: CvMat | null = null;
  let sharpenKernel: CvMat | null = null;
  let result: CvMat | null = null;

  try {
    const isAdaptive = ADAPTIVE_PRESETS.has(variant.preset);

    if (isAdaptive) {
      // Brightness/contrast pre-gain folded in via convertScaleAbs BEFORE
      // adaptiveThreshold (design section 3.3/4.4) — writes into a fresh
      // `work` Mat, never mutating the shared `grayMat`.
      work = new cvBindings.Mat();
      const alpha = 1 + variant.contrast / 100;
      const beta = variant.brightness * FILTER.BETA_SCALE;
      cvBindings.convertScaleAbs(grayMat, work, alpha, beta);

      stage1 = new cvBindings.Mat();
      switch (variant.preset) {
        case 'bw':
          cvBindings.adaptiveThreshold(
            work,
            stage1,
            255,
            cvBindings.ADAPTIVE_THRESH_GAUSSIAN_C,
            cvBindings.THRESH_BINARY,
            FILTER.BW_BLOCK_SIZE,
            FILTER.BW_C,
          );
          break;
        case 'bw-high-contrast':
          cvBindings.adaptiveThreshold(
            work,
            stage1,
            255,
            cvBindings.ADAPTIVE_THRESH_GAUSSIAN_C,
            cvBindings.THRESH_BINARY,
            FILTER.BW_HC_BLOCK_SIZE,
            FILTER.BW_HC_C,
          );
          // Denoise speckle (design section 4.4) — kernel is worker-owned, deleted in `finally`.
          kernel = cvBindings.getStructuringElement(
            cvBindings.MORPH_RECT,
            new cvBindings.Size(FILTER.MORPH_KERNEL, FILTER.MORPH_KERNEL),
          );
          cvBindings.morphologyEx(stage1, stage1, cvBindings.MORPH_OPEN, kernel);
          break;
        case 'eco':
          cvBindings.adaptiveThreshold(
            work,
            stage1,
            255,
            cvBindings.ADAPTIVE_THRESH_MEAN_C,
            cvBindings.THRESH_BINARY,
            FILTER.ECO_BLOCK_SIZE,
            FILTER.ECO_C,
          );
          break;
        default:
          // Unreachable at runtime: `isAdaptive` (via `ADAPTIVE_PRESETS.has`)
          // already narrows to these 3 presets before this switch runs. TS
          // cannot express that narrowing across a `Set.has()` check, so this
          // is a defensive throw rather than an exhaustive-`never` check.
          throw new Error(`Unhandled adaptive preset: ${String(variant.preset)}`);
      }
    } else {
      // original | enhanced | grayscale — the worker is only reached here
      // when sharpness > 0 (routing: design section 3.1/`filterPipeline.needsWorker`).
      // convertScaleAbs(src, dst, 1, 0) is used as a plain copy into a
      // DEDICATED Mat so the subsequent in-place `filter2D` sharpen never
      // mutates the shared `srcMat`/`grayMat`.
      const source = variant.preset === 'grayscale' ? grayMat : srcMat;
      stage1 = new cvBindings.Mat();
      cvBindings.convertScaleAbs(source, stage1, 1, 0);
    }

    // Sharpness (any preset, design section 3.3/4.4): 3x3 unsharp kernel blended by alpha.
    if (variant.sharpness > 0) {
      const alpha = variant.sharpness / 100;
      const kernelData = SHARPEN_KERNEL_3X3.map((sharpenValue, index) => {
        const identityValue = IDENTITY_KERNEL_3X3[index] as number;
        return (1 - alpha) * identityValue + alpha * sharpenValue;
      });
      sharpenKernel = cvBindings.matFromArray(3, 3, cvBindings.CV_32F, kernelData);
      cvBindings.filter2D(stage1, stage1, -1, sharpenKernel);
    }

    // Single-channel results (bw/bw-hc/eco/grayscale) -> back to RGBA for ImageData.
    const isSingleChannel = isAdaptive || variant.preset === 'grayscale';
    if (isSingleChannel) {
      result = new cvBindings.Mat();
      cvBindings.cvtColor(stage1, result, cvBindings.COLOR_GRAY2RGBA);
    } else {
      result = stage1;
      stage1 = null; // ownership transferred to `result` — skip deletion below.
    }

    return result;
  } finally {
    if (work && !work.isDeleted()) work.delete();
    if (stage1 && !stage1.isDeleted()) stage1.delete();
    if (kernel && !kernel.isDeleted()) kernel.delete();
    if (sharpenKernel && !sharpenKernel.isDeleted()) sharpenKernel.delete();
  }
}

/**
 * `APPLY_FILTER` handler (design section 4.1-4.4). Decodes `srcMat`
 * (RGBA)/`grayMat` ONCE from the base `image`, then renders every
 * `request.variants` entry over the same pair — batches up to 3 adaptive
 * previews in one round-trip (design section 4.3) without re-decoding.
 * Every per-variant Mat is `.delete()`'d in `applyVariant`'s own `finally`;
 * this handler owns and releases only the shared `srcMat`/`grayMat`.
 */
async function handleApplyFilter(request: ApplyFilterRequest): Promise<void> {
  if (!cv) {
    replyError(request.id, 'NOT_INITIALIZED', 'APPLY_FILTER received before INIT_DONE.');
    return;
  }

  const cvBindings = cv;
  let srcMat: CvMat | null = null;
  let grayMat: CvMat | null = null;

  try {
    const imageData = imageDataLikeToImageData(request.image);
    srcMat = cvBindings.matFromImageData(imageData);
    grayMat = new cvBindings.Mat();
    cvBindings.cvtColor(srcMat, grayMat, cvBindings.COLOR_RGBA2GRAY);

    const results: FilteredResult[] = [];
    const transfer: Transferable[] = [];

    for (const variant of request.variants) {
      let variantMat: CvMat | null = null;
      try {
        variantMat = applyVariant(cvBindings, srcMat, grayMat, variant);
        const outWidth = variantMat.cols;
        const outHeight = variantMat.rows;
        const outImageData = new ImageData(toPlainClampedArray(variantMat.data), outWidth, outHeight);

        if (request.outputBitmap) {
          const ctx = getFilterContext(outWidth, outHeight);
          ctx.putImageData(outImageData, 0, 0);
          const bitmap = (filterCanvas as OffscreenCanvas).transferToImageBitmap();
          results.push({ kind: 'bitmap', bitmap });
          transfer.push(bitmap);
        } else {
          const clonedData = new Uint8ClampedArray(outImageData.data);
          results.push({ kind: 'imagedata', image: { width: outWidth, height: outHeight, data: clonedData } });
          transfer.push(clonedData.buffer);
        }
      } finally {
        if (variantMat && !variantMat.isDeleted()) variantMat.delete();
      }
    }

    const response: ApplyFilterResponse = { id: request.id, type: 'APPLY_FILTER_RESULT', results };
    postResponse(response, transfer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown APPLY_FILTER failure.';
    replyError(request.id, 'FILTER_FAILED', message);
  } finally {
    if (srcMat && !srcMat.isDeleted()) srcMat.delete();
    if (grayMat && !grayMat.isDeleted()) grayMat.delete();
  }
}

/**
 * Whether this worker can rely on an internal `OffscreenCanvas` for the
 * WARP output path. When `false` (design section 8 fallback), the caller
 * is expected to have sent DETECT/WARP payloads as `ImageDataLike`
 * produced on the main thread instead, and WARP replies with
 * `WARP_RESULT_IMAGEDATA`.
 */
const offscreenSupported = typeof OffscreenCanvas !== 'undefined';

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  switch (request.type) {
    case 'INIT':
      void handleInit(request);
      break;
    case 'DETECT':
      void handleDetect(request);
      break;
    case 'DETECT_IMAGEDATA':
      void handleDetectImageData(request);
      break;
    case 'WARP':
      void handleWarp(request, offscreenSupported);
      break;
    case 'APPLY_FILTER':
      void handleApplyFilter(request);
      break;
    default: {
      const exhaustiveCheck: never = request;
      throw new Error(`Unhandled worker request type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
});
