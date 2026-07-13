import { describe, expect, it } from 'vitest';
import {
  buildCssFilter,
  buildThumbnailCssFilter,
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
  it.each(ALL_PRESETS)('preset=%s, sharpness=0 -> worker only for adaptive presets', (preset) => {
    const isAdaptive = preset === 'bw' || preset === 'bw-high-contrast' || preset === 'eco';
    expect(needsWorker(filter(preset))).toBe(isAdaptive);
  });

  it.each(ALL_PRESETS)('preset=%s, sharpness=40 -> ALWAYS routes to the worker', (preset) => {
    expect(needsWorker(filter(preset, { sharpness: 40 }))).toBe(true);
  });

  it('spec scenario "Preset Canvas2D no toca el worker": enhanced + sharpness 0 stays off the worker', () => {
    expect(needsWorker(filter('enhanced', { sharpness: 0 }))).toBe(false);
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
