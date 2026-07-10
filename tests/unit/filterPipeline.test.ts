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
  it('original -> none, regardless of sliders', () => {
    expect(buildCssFilter(filter('original', { brightness: 20, contrast: -10 }))).toBe('none');
  });

  it('enhanced -> brightness/contrast/saturate(SAT), neutral sliders map to 1', () => {
    const result = buildCssFilter(filter('enhanced'));
    expect(result).toBe(`brightness(1) contrast(1) saturate(${FILTER.ENHANCED_SATURATION})`);
  });

  it('enhanced -> non-neutral sliders map v = 1 + slider/100', () => {
    const result = buildCssFilter(filter('enhanced', { brightness: 50, contrast: -20 }));
    expect(result).toBe(`brightness(1.5) contrast(0.8) saturate(${FILTER.ENHANCED_SATURATION})`);
  });

  it('grayscale -> grayscale(1) always, plus brightness/contrast', () => {
    const result = buildCssFilter(filter('grayscale', { brightness: 10, contrast: 0 }));
    expect(result).toBe('grayscale(1) brightness(1.1) contrast(1)');
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
