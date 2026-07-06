/**
 * Narrow, explicit typing of the subset of the OpenCV.js Embind API this
 * worker actually calls.
 *
 * Why a local type instead of the package's generated `.d.ts`: the
 * `@techstark/opencv-js` package itself documents that its TypeScript
 * declarations "may not be up to date with the latest OpenCV.js" and
 * defers to a runtime key dump (`doc/cvKeys.json`) for the true surface.
 * Concretely, its `Mat`/`MatVector` declarations omit `.delete()` /
 * `.isDeleted()`, which are standard Emscripten Embind instance methods
 * present on every bound C++ object at runtime but not modeled in the
 * generated types. Rather than reaching for `any` (banned by this
 * project's TS strict policy), this module pins exactly the calls the
 * worker needs, matching real OpenCV.js runtime behavior.
 */

export interface CvMat {
  readonly rows: number;
  readonly cols: number;
  readonly data: Uint8Array;
  readonly data32F: Float32Array;
  readonly data64F: Float64Array;
  delete(): void;
  isDeleted(): boolean;
}

export interface CvMatVector {
  size(): number;
  get(index: number): CvMat;
  delete(): void;
  isDeleted(): boolean;
}

export interface CvPoint {
  readonly x: number;
  readonly y: number;
}

export interface CvSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The subset of the global `cv` Emscripten module used by
 * `opencv.worker.ts`. Constructed once the loader resolves
 * `cv.onRuntimeInitialized`.
 */
export interface CvBindings {
  readonly Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
  readonly MatVector: new () => CvMatVector;
  readonly Size: new (width: number, height: number) => CvSize;

  matFromImageData(imageData: ImageData): CvMat;
  matFromArray(rows: number, cols: number, type: number, data: readonly number[]): CvMat;

  cvtColor(src: CvMat, dst: CvMat, code: number): void;
  GaussianBlur(src: CvMat, dst: CvMat, ksize: CvSize, sigmaX: number, sigmaY?: number): void;
  Canny(src: CvMat, dst: CvMat, threshold1: number, threshold2: number): void;
  findContours(
    image: CvMat,
    contours: CvMatVector,
    hierarchy: CvMat,
    mode: number,
    method: number,
  ): void;
  contourArea(contour: CvMat, oriented?: boolean): number;
  arcLength(curve: CvMat, closed: boolean): number;
  approxPolyDP(curve: CvMat, approxCurve: CvMat, epsilon: number, closed: boolean): void;
  Laplacian(src: CvMat, dst: CvMat, ddepth: number): void;
  meanStdDev(src: CvMat, mean: CvMat, stddev: CvMat): void;
  getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat;
  warpPerspective(src: CvMat, dst: CvMat, transform: CvMat, dsize: CvSize): void;

  readonly CV_8UC1: number;
  readonly CV_32FC2: number;
  readonly CV_64F: number;
  readonly COLOR_RGBA2GRAY: number;
  readonly RETR_LIST: number;
  readonly CHAIN_APPROX_SIMPLE: number;
}
