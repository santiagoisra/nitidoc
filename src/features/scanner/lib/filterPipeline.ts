/**
 * Pure, DOM-free routing helpers for the two-stage filter render pipeline
 * (design section 3, ADR-008/ADR-009). No OpenCV, no Canvas here — this
 * module only decides WHERE a given `FilterParams` should render and
 * produces the CSS string / memoization key other modules consume.
 */

import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { FilterParams, FilterPreset } from '@/shared/types/scanner';

/**
 * Presets rendered by the OpenCV worker's `APPLY_FILTER` RPC (real pixel
 * manipulation) rather than Canvas2D `ctx.filter` (design section 3.1,
 * ADR-008). Includes the 3 `adaptiveThreshold` presets (`bw`/`bw-high-contrast`
 * /`eco`) AND `enhanced`/`grayscale`: their CSS `ctx.filter` realce was a
 * SILENT no-op on WebKit/iOS before Safari 17 (Canvas2D `ctx.filter` was
 * unsupported there), so their brightness/contrast realce is baked into pixels
 * in the worker instead. Only `original` (a true no-op, filter `'none'`) stays
 * on the Canvas2D/raw path.
 */
const WORKER_PRESETS: ReadonlySet<FilterPreset> = new Set([
  'bw',
  'bw-high-contrast',
  'eco',
  'enhanced',
  'grayscale',
]);

/**
 * Routing decision (design section 3.1): worker-rendered presets always need
 * the worker; any preset with `sharpness > 0` (a neighborhood convolution)
 * also needs the worker, regardless of which preset is active — sharpness
 * overrides an otherwise raw `original` (spec `filters` scenario "Nitidez
 * fuerza ruta de worker sobre preset Canvas2D").
 */
export function needsWorker(filter: FilterParams): boolean {
  return WORKER_PRESETS.has(filter.preset) || filter.sharpness > 0;
}

/**
 * Trims floating-point noise (e.g. `1.08 * 1.1 = 1.1880000000000002`) from a
 * base×slider product so the emitted CSS string stays clean and stable.
 */
function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * Maps `FilterParams` to a Canvas2D `ctx.filter` string (design section 3.2,
 * Stage 2 — presentation only). The CSS presets carry a BASE realce (see
 * `FILTER.ENHANCED_*` / `FILTER.GRAYSCALE_*`) so "Mejorado" / "Escala de
 * grises" visibly lift a document at neutral sliders — a plain `brightness(1)
 * contrast(1)` was a no-op on achromatic pages. Slider values modulate that
 * base multiplicatively. Adaptive presets return `'none'`: their brightness/
 * contrast are already folded into the worker's Stage 1 (`convertScaleAbs`
 * pre-gain, design section 3.3/4.4), so Stage 2 must not re-apply them on top.
 */
export function buildCssFilter(filter: FilterParams): string {
  const brightnessValue = 1 + filter.brightness / 100;
  const contrastValue = 1 + filter.contrast / 100;

  switch (filter.preset) {
    case 'original':
      return 'none';
    case 'enhanced':
      return `brightness(${fmt(FILTER.ENHANCED_BRIGHTNESS * brightnessValue)}) contrast(${fmt(FILTER.ENHANCED_CONTRAST * contrastValue)}) saturate(${FILTER.ENHANCED_SATURATION})`;
    case 'grayscale':
      return `grayscale(1) brightness(${fmt(FILTER.GRAYSCALE_BRIGHTNESS * brightnessValue)}) contrast(${fmt(FILTER.GRAYSCALE_CONTRAST * contrastValue)})`;
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
 * CSS filter approximation for a THUMBNAIL-ONLY render (tray strip / grid
 * tiles — Fase 2.1 punch-list item 3, "thumbnails must visibly reflect the
 * applied filter"). `buildCssFilter` intentionally returns `'none'` for the
 * 3 adaptive presets (`bw`/`bw-high-contrast`/`eco`) because their ACCURATE
 * render needs the OpenCV worker (adaptiveThreshold + morphology) — not
 * worth invoking for a ~150px cached thumbnail. This helper instead returns
 * a cheap CSS approximation (grayscale + boosted contrast) so a small
 * thumbnail still visibly communicates "a B&W-style filter is applied",
 * even though it is NOT pixel-accurate. The active-page EDIT preview stays
 * accurate — it renders via `FilterPanel`'s worker-routed preset tiles, not
 * this helper.
 *
 * Fase 2.2 punch-list item 4c: the original multipliers below read too close
 * to "looks like original" on a real device (per a real-device test report).
 * Bumped the contrast/brightness multipliers so `bw`/`bw-high-contrast`/`eco`
 * visibly read as a B&W/high-contrast approximation at thumbnail size —
 * still a documented CSS approximation, not the accurate worker render.
 */
export function buildThumbnailCssFilter(filter: FilterParams): string {
  const brightnessValue = 1 + filter.brightness / 100;
  const contrastValue = 1 + filter.contrast / 100;

  switch (filter.preset) {
    case 'bw':
      return `grayscale(1) contrast(${1.8 * contrastValue}) brightness(${brightnessValue})`;
    case 'bw-high-contrast':
      return `grayscale(1) contrast(${2.5 * contrastValue}) brightness(${brightnessValue})`;
    case 'eco':
      return `grayscale(1) contrast(${1.3 * contrastValue}) brightness(${1.1 * brightnessValue})`;
    default:
      return buildCssFilter(filter);
  }
}

/**
 * `convertScaleAbs(src, dst, alpha, beta)` params for the worker-BAKED realce
 * of the CSS presets `enhanced`/`grayscale` — the iOS/WebKit fix. These presets
 * used to render via Canvas2D `ctx.filter`, a silent no-op on WebKit before
 * Safari 17; they are now baked into pixels in the worker instead.
 *
 * Mapping: CSS `brightness(b) contrast(c)` == `pixel*(b*c) + 128*(1 - c)`
 * (contrast pivots around mid-gray 128). OpenCV's `convertScaleAbs` computes
 * `|src*alpha + beta|`, so `alpha = b*c` and `beta = 128*(1 - c)`, where
 * `b`/`c` fold the base FILTER.* multiplier with the neutral-at-0 slider.
 * `original` (and anything else) is an identity copy `{ alpha: 1, beta: 0 }`.
 *
 * Pure and OpenCV-free ON PURPOSE: it makes the realce unit-testable at the
 * PIXEL level — the gap that let the Slice B CSS-string fix ship broken, since
 * a test can only assert a `ctx.filter` string, never that it actually renders.
 */
export interface RealceParams {
  readonly alpha: number;
  readonly beta: number;
}

export function cssPresetRealce(preset: FilterPreset, brightness: number, contrast: number): RealceParams {
  const brightnessSlider = 1 + brightness / 100;
  const contrastSlider = 1 + contrast / 100;

  switch (preset) {
    case 'enhanced': {
      const c = FILTER.ENHANCED_CONTRAST * contrastSlider;
      const b = FILTER.ENHANCED_BRIGHTNESS * brightnessSlider;
      return { alpha: b * c, beta: 128 * (1 - c) };
    }
    case 'grayscale': {
      const c = FILTER.GRAYSCALE_CONTRAST * contrastSlider;
      const b = FILTER.GRAYSCALE_BRIGHTNESS * brightnessSlider;
      return { alpha: b * c, beta: 128 * (1 - c) };
    }
    default:
      return { alpha: 1, beta: 0 };
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
