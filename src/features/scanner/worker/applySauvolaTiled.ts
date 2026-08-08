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
  const latticeBytes = Math.ceil(width / FILTER.SAUVOLA_ILLUMINATION_CELL) * Math.ceil(height / FILTER.SAUVOLA_ILLUMINATION_CELL);
  return { liveBytes: width * height * 5 + tileWidth * tileHeight + integralBytes + latticeBytes + Uint32Array.BYTES_PER_ELEMENT * 256, fullPageFloatBytes: 0 };
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

function preGainedGray(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  alpha: number,
  beta: number,
): number {
  const offset = (clamp(y, height - 1) * width + clamp(x, width - 1)) * 4;
  const gray = (9798 * (data[offset] ?? 0) + 19235 * (data[offset + 1] ?? 0) + 3735 * (data[offset + 2] ?? 0) + 16384) >> 15;
  return Math.min(255, cvRound(Math.abs(gray * alpha + beta)));
}

function quantile90(histogram: Uint32Array, count: number): number {
  const rank = Math.ceil(count * FILTER.SAUVOLA_ILLUMINATION_QUANTILE);
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value] ?? 0;
    if (cumulative >= rank) return value;
  }
  return 255;
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
    const cellSize = FILTER.SAUVOLA_ILLUMINATION_CELL;
    const latticeWidth = Math.ceil(width / cellSize);
    const latticeHeight = Math.ceil(height / cellSize);
    const lattice = new Uint8Array(latticeWidth * latticeHeight);
    const histogram = new Uint32Array(256);
    for (let cellY = 0; cellY < latticeHeight; cellY += 1) for (let cellX = 0; cellX < latticeWidth; cellX += 1) {
      histogram.fill(0);
      const left = cellX * cellSize;
      const top = cellY * cellSize;
      const right = Math.min(width, left + cellSize);
      const bottom = Math.min(height, top + cellSize);
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
        const value = preGainedGray(data, width, height, x, y, alpha, beta);
        histogram[value] = (histogram[value] ?? 0) + 1;
      }
      lattice[cellY * latticeWidth + cellX] = quantile90(histogram, (right - left) * (bottom - top));
    }
    histogram.fill(0);
    for (const value of lattice) histogram[value] = (histogram[value] ?? 0) + 1;
    const pageReference = quantile90(histogram, lattice.length);
    const backgroundAt = (x: number, y: number): number => {
      const cellX = Math.min(latticeWidth - 1, Math.floor(x / cellSize));
      const cellY = Math.min(latticeHeight - 1, Math.floor(y / cellSize));
      const nextX = Math.min(latticeWidth - 1, cellX + 1);
      const nextY = Math.min(latticeHeight - 1, cellY + 1);
      const fractionalX = x % cellSize;
      const fractionalY = y % cellSize;
      const at = (gridX: number, gridY: number) => lattice[gridY * latticeWidth + gridX] ?? 0;
      const top = at(cellX, cellY) * (cellSize - fractionalX) + at(nextX, cellY) * fractionalX;
      const bottom = at(cellX, nextY) * (cellSize - fractionalX) + at(nextX, nextY) * fractionalX;
      return Math.floor((top * (cellSize - fractionalY) + bottom * fractionalY) / (cellSize * cellSize));
    };
    output = new cv.Mat(height, width, cv.CV_8UC1);
    const outputData = output.data;

    for (let top = 0; top < height; top += FILTER.SAUVOLA_TILE_INTERIOR) {
      const interiorHeight = Math.min(FILTER.SAUVOLA_TILE_INTERIOR, height - top);
      const expandedHeight = interiorHeight + halo * 2;
      for (let left = 0; left < width; left += FILTER.SAUVOLA_TILE_INTERIOR) {
        const interiorWidth = Math.min(FILTER.SAUVOLA_TILE_INTERIOR, width - left);
        const expandedWidth = interiorWidth + halo * 2;
        for (let y = 0; y < expandedHeight; y += 1) for (let x = 0; x < expandedWidth; x += 1) {
          const globalX = clamp(left + x - halo, width - 1);
          const globalY = clamp(top + y - halo, height - 1);
          const gray = preGainedGray(data, width, height, globalX, globalY, alpha, beta);
          const background = backgroundAt(globalX, globalY);
          const difference = Math.min(FILTER.SAUVOLA_ILLUMINATION_CAP, Math.max(0, pageReference - background));
          const weight = background === 0 ? 0 : Math.min(1, gray / background);
          tile[y * maxWidth + x] = Math.min(255, cvRound(gray + difference * weight));
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
