import { describe, expect, it } from 'vitest';
import { applySauvolaTiled } from '@/features/scanner/worker/applySauvolaTiled';
import type { CvBindings, CvMat } from '@/features/scanner/worker/cvBindings';
import { createFilterQualityFixture, type QualityRegion } from './fixtures/filterQualityFixture';

const layouts = [
  { name: 'compact portrait', width: 320, height: 440, margin: 0.06 },
  { name: 'wide landscape', width: 768, height: 512, margin: 0.14 },
  { name: 'roomy portrait', width: 720, height: 960, margin: 0.10 },
] as const;

function fakeCv(): CvBindings {
  return { Mat: class implements CvMat {
    readonly data: Uint8Array; private deleted = false;
    constructor(readonly rows = 0, readonly cols = 0) { this.data = new Uint8Array(rows * cols); }
    readonly data32F = new Float32Array(); readonly data32S = new Int32Array(); readonly data64F = new Float64Array();
    delete(): void { this.deleted = true; } isDeleted(): boolean { return this.deleted; }
  }, CV_8UC1: 1 } as unknown as CvBindings;
}

function run(layout: (typeof layouts)[number]) {
  const fixture = createFilterQualityFixture(layout);
  const result = applySauvolaTiled(fakeCv(), fixture.image, 0, 0);
  return { fixture, pixels: result.data };
}

function blackRatio(pixels: Uint8Array, indices: readonly number[]): number {
  return indices.filter((index) => pixels[index] === 0).length / indices.length;
}

function ratios(layout: (typeof layouts)[number]) {
  const { fixture, pixels } = run(layout);
  return Object.fromEntries((Object.keys(fixture.samples) as QualityRegion[]).map((name) => [name, blackRatio(pixels, fixture.samples[name])])) as Record<QualityRegion, number>;
}

describe('independent Sauvola document-quality gates', () => {
  it('emits only binary output for every scaled document layout', () => {
    for (const layout of layouts) expect([...run(layout).pixels].every((pixel) => pixel === 0 || pixel === 255), layout.name).toBe(true);
  });

  it('is byte-identical across repeated runs for every scaled document layout', () => {
    for (const layout of layouts) expect([...run(layout).pixels], layout.name).toEqual([...run(layout).pixels]);
  });

  it('keeps thick interiors, a wide uniform ink bar, fine writing, and punctuation readable', () => {
    for (const layout of layouts) {
      const quality = ratios(layout);
      expect(quality.thick, `${layout.name}: thick`).toBeGreaterThanOrEqual(0.92);
      expect(quality.wideInk, `${layout.name}: wide uniform ink`).toBeGreaterThanOrEqual(0.92);
      expect(quality.fine, `${layout.name}: fine strokes`).toBeGreaterThanOrEqual(0.65);
      expect(quality.punctuation, `${layout.name}: punctuation`).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('does not turn textured paper or either bounded shadow into solid ink across layouts', () => {
    for (const layout of layouts) {
      const quality = ratios(layout);
      expect(quality.paper, `${layout.name}: paper`).toBeLessThanOrEqual(0.08);
      expect(quality.darkShadow, `${layout.name}: <80 shadow`).toBeLessThanOrEqual(0.18);
      expect(quality.midShadow, `${layout.name}: 145-175 shadow`).toBeLessThanOrEqual(0.18);
      console.info(`${layout.name}: ${JSON.stringify(quality)}`);
    }
  });
});
