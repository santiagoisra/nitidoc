import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { CvBindings, CvMat } from './cvBindings';
import type { ImageDataLike } from './messages';

export interface SauvolaOwnedBytes {
  readonly liveBytes: number;
  readonly fullPageFloatBytes: 0;
}

export function sauvolaWindowSize(width: number, height: number): number {
  const rounded = Math.round(Math.min(width, height) / 16);
  return Math.max(FILTER.SAUVOLA_MIN_WINDOW, Math.min(FILTER.SAUVOLA_MAX_WINDOW, rounded | 1));
}

/** Algorithm-owned buffers only; this is not a browser RSS measurement. */
export function estimateSauvolaOwnedBytes(width: number, height: number): SauvolaOwnedBytes {
  const halo = (sauvolaWindowSize(width, height) - 1) / 2;
  const tileWidth = Math.min(width, FILTER.SAUVOLA_TILE_INTERIOR) + halo * 2;
  const tileHeight = Math.min(height, FILTER.SAUVOLA_TILE_INTERIOR) + halo * 2;
  const integralBytes = (tileWidth + 1) * (tileHeight + 1) * Float64Array.BYTES_PER_ELEMENT * 2;
  return { liveBytes: width * height * 5 + tileWidth * tileHeight + integralBytes, fullPageFloatBytes: 0 };
}

/** Rewrites the transferred RGBA buffer; it never creates an RGBA OpenCV Mat. */
export function writeBinaryMatToRgba(binary: Uint8Array, rgba: Uint8ClampedArray): Uint8ClampedArray {
  if (binary.length * 4 !== rgba.length) throw new Error('Binary and RGBA dimensions differ.');
  for (let index = 0; index < binary.length; index += 1) {
    const value = binary[index] ?? 0;
    const offset = index * 4;
    rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function cvRound(value: number): number {
  const floor = Math.floor(value);
  return floor + (value - floor > 0.5 || (value - floor === 0.5 && floor % 2 !== 0) ? 1 : 0);
}

function release(mat: CvMat | null): void {
  try {
    if (mat && !mat.isDeleted()) mat.delete();
  } catch {
    // Preserve the processing error that triggered cleanup.
  }
}

/** Returns a caller-owned single-channel Mat; temporary tile buffers are plain JS arrays. */
export function applySauvolaTiled(
  cv: CvBindings,
  image: ImageDataLike,
  brightness: number,
  contrast: number,
): CvMat {
  let output: CvMat | null = null;
  try {
    const { width, height, data } = image;
    if (width < 1 || height < 1 || data.length !== width * height * 4) throw new Error('Invalid RGBA filter image.');
    const window = sauvolaWindowSize(width, height);
    const halo = (window - 1) / 2;
    const maxWidth = Math.min(width, FILTER.SAUVOLA_TILE_INTERIOR) + halo * 2;
    const maxHeight = Math.min(height, FILTER.SAUVOLA_TILE_INTERIOR) + halo * 2;
    const tile = new Uint8Array(maxWidth * maxHeight);
    const stride = maxWidth + 1;
    const sum = new Float64Array(stride * (maxHeight + 1));
    const square = new Float64Array(stride * (maxHeight + 1));
    const alpha = 1 + contrast / 100;
    const beta = brightness * FILTER.BETA_SCALE;
    output = new cv.Mat(height, width, cv.CV_8UC1);
    const outputData = output.data;

    for (let top = 0; top < height; top += FILTER.SAUVOLA_TILE_INTERIOR) {
      const interiorHeight = Math.min(FILTER.SAUVOLA_TILE_INTERIOR, height - top);
      const expandedHeight = interiorHeight + halo * 2;
      for (let left = 0; left < width; left += FILTER.SAUVOLA_TILE_INTERIOR) {
        const interiorWidth = Math.min(FILTER.SAUVOLA_TILE_INTERIOR, width - left);
        const expandedWidth = interiorWidth + halo * 2;
        for (let y = 0; y < expandedHeight; y += 1) for (let x = 0; x < expandedWidth; x += 1) {
          const source = (clamp(top + y - halo, height - 1) * width + clamp(left + x - halo, width - 1)) * 4;
          const gray = (9798 * (data[source] ?? 0) + 19235 * (data[source + 1] ?? 0) + 3735 * (data[source + 2] ?? 0) + 16384) >> 15;
          tile[y * maxWidth + x] = Math.min(255, cvRound(Math.abs(gray * alpha + beta)));
        }
        for (let x = 0; x <= expandedWidth; x += 1) sum[x] = square[x] = 0;
        for (let y = 1; y <= expandedHeight; y += 1) {
          const row = y * stride;
          sum[row] = square[row] = 0;
          for (let x = 1; x <= expandedWidth; x += 1) {
            const value = tile[(y - 1) * maxWidth + x - 1] ?? 0;
            sum[row + x] = value + (sum[row - stride + x] ?? 0) + (sum[row + x - 1] ?? 0) - (sum[row - stride + x - 1] ?? 0);
            square[row + x] = value * value + (square[row - stride + x] ?? 0) + (square[row + x - 1] ?? 0) - (square[row - stride + x - 1] ?? 0);
          }
        }
        const count = window * window;
        for (let y = halo; y < halo + interiorHeight; y += 1) for (let x = halo; x < halo + interiorWidth; x += 1) {
          const x0 = x - halo; const y0 = y - halo; const x1 = x + halo + 1; const y1 = y + halo + 1;
          const total = (sum[y1 * stride + x1] ?? 0) - (sum[y0 * stride + x1] ?? 0) - (sum[y1 * stride + x0] ?? 0) + (sum[y0 * stride + x0] ?? 0);
          const totalSquare = (square[y1 * stride + x1] ?? 0) - (square[y0 * stride + x1] ?? 0) - (square[y1 * stride + x0] ?? 0) + (square[y0 * stride + x0] ?? 0);
          const mean = total / count;
          const stddev = Math.sqrt(Math.max(0, totalSquare / count - mean * mean));
          if (!Number.isFinite(mean) || !Number.isFinite(stddev)) throw new Error('Non-finite Sauvola statistics.');
          const threshold = mean * (1 + FILTER.SAUVOLA_K * (stddev / FILTER.SAUVOLA_R - 1));
          outputData[(top + y - halo) * width + left + x - halo] = (tile[y * maxWidth + x] ?? 0) <= threshold ? 0 : 255;
        }
      }
    }
    const result = output;
    output = null;
    return result;
  } catch (error) {
    release(output);
    throw error;
  }
}
