import { describe, expect, it } from 'vitest';
import {
  buildCssFilter,
  buildThumbnailCssFilter,
  cssPresetRealce,
  filterSignature,
  needsWorker,
} from '@/features/scanner/lib/filterPipeline';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { FilterParams, FilterPreset } from '@/shared/types/scanner';

/**
 * Group 3 / PR6 unit tests for `filterPipeline.ts` (task 3.7, design
 * section 3.1-3.2). Covers the routing truth table and the CSS mapping
 * scenarios from `specs/filters/spec.md`.
 */

function filter(preset: FilterPreset, overrides: Partial<FilterParams> = {}): FilterParams {
  return { preset, brightness: 0, contrast: 0, sharpness: 0, ...overrides };
}

const ALL_PRESETS: readonly FilterPreset[] = [
  'original',
  'enhanced',
  'grayscale',
  'bw',
  'bw-high-contrast',
  'eco',
];

describe('needsWorker — routing truth table (design section 3.1)', () => {
  it.each(ALL_PRESETS)('preset=%s, sharpness=0 -> worker for every preset EXCEPT original', (preset) => {
    // iOS/WebKit ctx.filter fix: enhanced/grayscale now bake their realce in
    // the worker too (the CSS path was a silent no-op on WebKit < Safari 17).
    // Only `original` (filter "none") stays off the worker.
    const cssOnly = preset === 'original';
    expect(needsWorker(filter(preset))).toBe(!cssOnly);
  });

  it.each(ALL_PRESETS)('preset=%s, sharpness=40 -> ALWAYS routes to the worker', (preset) => {
    expect(needsWorker(filter(preset, { sharpness: 40 }))).toBe(true);
  });

  it('iOS/WebKit fix: enhanced + sharpness 0 now routes to the worker (CSS ctx.filter was a no-op there)', () => {
    expect(needsWorker(filter('enhanced', { sharpness: 0 }))).toBe(true);
  });

  it('grayscale + sharpness 0 now routes to the worker (same ctx.filter fix)', () => {
    expect(needsWorker(filter('grayscale', { sharpness: 0 }))).toBe(true);
  });

  it('original is the ONLY preset that stays off the worker (drawn raw, filter "none")', () => {
    expect(needsWorker(filter('original', { sharpness: 0 }))).toBe(false);
  });

  it('spec scenario "Preset adaptativo enruta al worker": bw always routes to the worker', () => {
    expect(needsWorker(filter('bw'))).toBe(true);
  });

  it('spec scenario "Nitidez fuerza ruta de worker sobre preset Canvas2D": grayscale + sharpness 40 routes to the worker', () => {
    expect(needsWorker(filter('grayscale', { sharpness: 40 }))).toBe(true);
  });
});

describe('buildCssFilter — Stage 2 CSS mapping (design section 3.2)', () => {
  // Assert the CONTRACT, not the exact calibratable multipliers — filterConstants
  // marks the FILTER.* values as pending on-device calibration.
  const extract = (css: string, fn: string): number => Number(new RegExp(`${fn}\\(([\\d.]+)\\)`).exec(css)?.[1]);

  it('original -> none, regardless of sliders', () => {
    expect(buildCssFilter(filter('original', { brightness: 20, contrast: -10 }))).toBe('none');
  });

  it('enhanced -> a visible BASE realce at neutral sliders (not the old brightness(1) contrast(1) no-op), plus saturate', () => {
    const result = buildCssFilter(filter('enhanced'));
    expect(result).not.toBe('none');
    expect(result).toContain(`saturate(${FILTER.ENHANCED_SATURATION})`);
    // The bug 2 regression: neutral sliders must now carry the calibrated base
    // boost (>1) so the preset actually changes achromatic pixels.
    expect(extract(result, 'brightness')).toBeGreaterThan(1);
    expect(extract(result, 'contrast')).toBeGreaterThan(1);
  });

  it('enhanced -> sliders modulate the base multiplicatively (a positive slider raises the value)', () => {
    const neutral = buildCssFilter(filter('enhanced'));
    const brighter = buildCssFilter(filter('enhanced', { brightness: 50 }));
    expect(extract(brighter, 'brightness')).toBeGreaterThan(extract(neutral, 'brightness'));
  });

  it('grayscale -> always grayscale(1), with a base contrast boost (>1) at neutral sliders', () => {
    const result = buildCssFilter(filter('grayscale'));
    expect(result.startsWith('grayscale(1)')).toBe(true);
    expect(extract(result, 'contrast')).toBeGreaterThan(1);
  });

  it('grayscale -> keeps grayscale(1) regardless of sliders', () => {
    expect(buildCssFilter(filter('grayscale', { brightness: 10, contrast: 20 }))).toContain('grayscale(1)');
  });

  it.each(['bw', 'bw-high-contrast', 'eco'] as const)(
    'adaptive preset %s -> none (brightness/contrast already folded into worker Stage 1)',
    (preset) => {
      expect(buildCssFilter(filter(preset, { brightness: 30, contrast: 30 }))).toBe('none');
    },
  );
});

describe('buildThumbnailCssFilter — thumbnail-only CSS approximation (Fase 2.1 punch-list item 3)', () => {
  it('delegates to buildCssFilter unchanged for the 3 CSS-routable presets', () => {
    for (const preset of ['original', 'enhanced', 'grayscale'] as const) {
      const params = filter(preset, { brightness: 15, contrast: -10 });
      expect(buildThumbnailCssFilter(params)).toBe(buildCssFilter(params));
    }
  });

  it.each(['bw', 'bw-high-contrast', 'eco'] as const)(
    'adaptive preset %s -> a non-"none" grayscale CSS approximation (NOT the accurate worker render)',
    (preset) => {
      const result = buildThumbnailCssFilter(filter(preset));
      expect(result).not.toBe('none');
      expect(result).toContain('grayscale(1)');
      // Must differ from buildCssFilter's own answer for adaptive presets
      // ('none') — this helper exists PRECISELY because that's not visible
      // enough for a small thumbnail.
      expect(result).not.toBe(buildCssFilter(filter(preset)));
    },
  );

  it('bw-high-contrast approximates a STRONGER contrast boost than plain bw', () => {
    const bw = buildThumbnailCssFilter(filter('bw'));
    const bwHc = buildThumbnailCssFilter(filter('bw-high-contrast'));
    const extractContrast = (css: string): number => Number(/contrast\(([\d.]+)\)/.exec(css)?.[1]);
    expect(extractContrast(bwHc)).toBeGreaterThan(extractContrast(bw));
  });
});

describe('cssPresetRealce — worker-BAKED pixel realce (iOS/WebKit ctx.filter fix)', () => {
  // Reproduces OpenCV's `convertScaleAbs(src, dst, alpha, beta)` exactly:
  // dst = clamp(round(|src * alpha + beta|)) into [0, 255]. This is what the
  // worker runs on real pixels — so asserting on THIS is asserting on the
  // actual render transform, NOT a ctx.filter string (the Slice B blind spot).
  const convertScaleAbs = (v: number, { alpha, beta }: { alpha: number; beta: number }): number =>
    Math.min(255, Math.max(0, Math.round(Math.abs(v * alpha + beta))));

  it('original -> identity {1,0}: every pixel value is left untouched', () => {
    const p = cssPresetRealce('original', 40, -20);
    expect(p).toEqual({ alpha: 1, beta: 0 });
    for (const v of [0, 64, 128, 200, 255]) {
      expect(convertScaleAbs(v, p)).toBe(v);
    }
  });

  it('enhanced (neutral sliders) -> WIDENS the light/dark gap (real contrast boost, not a no-op)', () => {
    const p = cssPresetRealce('enhanced', 0, 0);
    expect(p.alpha).toBeGreaterThan(1);
    const dark = convertScaleAbs(80, p);
    const light = convertScaleAbs(200, p);
    // The bug: on WebKit the CSS path left these identical to the input (gap
    // 120). Baked in the worker, the gap must actually widen.
    expect(light - dark).toBeGreaterThan(200 - 80);
  });

  it('grayscale (neutral sliders) -> also boosts contrast on the desaturated channel', () => {
    const p = cssPresetRealce('grayscale', 0, 0);
    expect(p.alpha).toBeGreaterThan(1);
    const dark = convertScaleAbs(90, p);
    const light = convertScaleAbs(180, p);
    expect(light - dark).toBeGreaterThan(180 - 90);
  });

  it('a positive brightness slider raises alpha (brighter) for enhanced', () => {
    expect(cssPresetRealce('enhanced', 50, 0).alpha).toBeGreaterThan(cssPresetRealce('enhanced', 0, 0).alpha);
  });

  it.each(['bw', 'bw-high-contrast', 'eco'] as const)(
    'adaptive preset %s -> identity {1,0} (its realce is folded into the adaptiveThreshold pre-gain, not here)',
    (preset) => {
      expect(cssPresetRealce(preset, 10, 10)).toEqual({ alpha: 1, beta: 0 });
    },
  );
});

describe('filterSignature — stable memoization key (design section 3.4)', () => {
  it('produces a string covering all 4 fields', () => {
    expect(filterSignature(filter('bw', { brightness: 10, contrast: -5, sharpness: 20 }))).toBe('bw:10:-5:20');
  });

  it('two structurally-equal FilterParams produce the same signature', () => {
    const a = filter('eco', { brightness: 5 });
    const b = filter('eco', { brightness: 5 });
    expect(filterSignature(a)).toBe(filterSignature(b));
  });

  it('differs when any single field differs', () => {
    const base = filter('enhanced', { brightness: 5, contrast: 5, sharpness: 5 });
    expect(filterSignature(base)).not.toBe(filterSignature({ ...base, brightness: 6 }));
    expect(filterSignature(base)).not.toBe(filterSignature({ ...base, preset: 'grayscale' }));
  });
});
