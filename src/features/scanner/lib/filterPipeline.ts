/**
 * Pure, DOM-free routing helpers for the two-stage filter render pipeline
 * (design section 3, ADR-008/ADR-009). No OpenCV, no Canvas here — this
 * module only decides WHERE a given `FilterParams` should render and
 * produces the CSS string / memoization key other modules consume.
 */

import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { FilterParams, FilterPreset } from '@/shared/types/scanner';

/**
 * Presets that render via the OpenCV worker's `APPLY_FILTER` RPC
 * (adaptiveThreshold + morphology, design section 4.4) rather than
 * Canvas2D `ctx.filter` (design section 3.1, ADR-008).
 */
const ADAPTIVE_PRESETS: ReadonlySet<FilterPreset> = new Set(['bw', 'bw-high-contrast', 'eco']);

/**
 * Routing decision (design section 3.1): adaptive presets always need the
 * worker; any preset with `sharpness > 0` (a neighborhood convolution) also
 * needs the worker, regardless of which preset is active — sharpness
 * overrides an otherwise Canvas2D-only preset (spec `filters` scenario
 * "Nitidez fuerza ruta de worker sobre preset Canvas2D").
 */
export function needsWorker(filter: FilterParams): boolean {
  return ADAPTIVE_PRESETS.has(filter.preset) || filter.sharpness > 0;
}

/**
 * Maps `FilterParams` to a Canvas2D `ctx.filter` string (design section 3.2,
 * Stage 2 — presentation only). Adaptive presets return `'none'`: their
 * brightness/contrast are already folded into the worker's Stage 1
 * (`convertScaleAbs` pre-gain, design section 3.3/4.4), so Stage 2 must not
 * re-apply them on top.
 */
export function buildCssFilter(filter: FilterParams): string {
  const brightnessValue = 1 + filter.brightness / 100;
  const contrastValue = 1 + filter.contrast / 100;

  switch (filter.preset) {
    case 'original':
      return 'none';
    case 'enhanced':
      return `brightness(${brightnessValue}) contrast(${contrastValue}) saturate(${FILTER.ENHANCED_SATURATION})`;
    case 'grayscale':
      return `grayscale(1) brightness(${brightnessValue}) contrast(${contrastValue})`;
    case 'bw':
    case 'bw-high-contrast':
    case 'eco':
      return 'none';
    default: {
      const exhaustiveCheck: never = filter.preset;
      throw new Error(`Unhandled filter preset: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Stable string key for the 4 `FilterParams` fields (design section 3.4),
 * used to memoize/evict derived filtered previews (e.g. a grid tile's
 * transient filtered-thumbnail cache).
 */
export function filterSignature(filter: FilterParams): string {
  return `${filter.preset}:${filter.brightness}:${filter.contrast}:${filter.sharpness}`;
}
