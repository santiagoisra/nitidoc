import { describe, expect, it } from 'vitest';
import {
  PAPER_FORMATS,
  classifyPaperRatio,
  getPaperFormat,
  paperSelection,
  resolveWarpGeometry,
  selectionFromLegacyAspectRatio,
} from '@/features/scanner/lib/paperFormats';

describe('paper format catalog', () => {
  it('keeps Oficio as the Legal family with its nominal 216 x 356 mm size', () => {
    expect(getPaperFormat('oficio')).toMatchObject({
      id: 'legal',
      aliases: ['legal', 'oficio'],
      nominalMm: { width: 216, height: 356 },
    });
    expect(PAPER_FORMATS.map((format) => format.id)).toEqual(['a4', 'letter', 'legal', 'ticket', 'original']);
  });

  it('falls back to Original for an ISO A-series ratio because ratio cannot identify physical scale', () => {
    const result = classifyPaperRatio(210 / 297);
    expect(result).toMatchObject({ id: 'original', alias: 'original', source: 'auto', confidence: 'none' });
    expect(result.evidence.scaleInferred).toBe(false);
  });

  it('falls back to Original when ratios are too close to distinguish honestly', () => {
    const result = classifyPaperRatio(0.74);
    expect(result).toMatchObject({ id: 'original', alias: 'original', confidence: 'none' });
    expect(result.evidence.scaleInferred).toBe(false);
  });

  it('retains the existing elongated Ticket classification with measured geometry', () => {
    const selection = classifyPaperRatio(1 / 6);
    expect(selection).toMatchObject({ id: 'ticket', source: 'auto', confidence: 'high' });
    expect(resolveWarpGeometry(selection)).toEqual({ mode: 'measured' });
  });

  it('preserves a manual Oficio label while resolving Legal geometry', () => {
    const selection = paperSelection('oficio', 'manual');
    expect(selection).toMatchObject({ id: 'legal', alias: 'oficio', source: 'manual' });
    expect(resolveWarpGeometry(selection)).toEqual({ mode: 'fixed', portraitRatio: 216 / 356 });
  });

  it('maps legacy ratios without changing their original raster semantics', () => {
    expect(selectionFromLegacyAspectRatio('a4')).toMatchObject({ id: 'a4', source: 'legacy', confidence: 'none' });
    expect(resolveWarpGeometry(selectionFromLegacyAspectRatio('ticket'))).toEqual({ mode: 'measured' });
    expect(selectionFromLegacyAspectRatio('unknown')).toMatchObject({ id: 'original', source: 'legacy' });
  });
});
