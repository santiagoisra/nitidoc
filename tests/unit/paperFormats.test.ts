import { describe, expect, it } from 'vitest';
import {
  CAPTURE_PAPER_FORMAT_OPTIONS,
  PAPER_FORMATS,
  capturePaperSelection,
  classifyPaperRatio,
  getPaperFormat,
  paperSelection,
  resolveWarpGeometry,
  selectionFromLegacyAspectRatio,
} from '@/features/scanner/lib/paperFormats';

describe('paper format catalog', () => {
  it('provides the manual capture picker aliases and their fixed or measured warp geometry', () => {
    expect(CAPTURE_PAPER_FORMAT_OPTIONS).toEqual(['a4', 'oficio', 'letter', 'legal', 'ticket', 'original']);
    expect(capturePaperSelection('a4')).toMatchObject({ alias: 'a4', source: 'manual' });
    expect(resolveWarpGeometry(capturePaperSelection('a4'))).toEqual({ mode: 'fixed', portraitRatio: 210 / 297 });
    expect(resolveWarpGeometry(capturePaperSelection('ticket'))).toEqual({ mode: 'fixed', portraitRatio: 53.98 / 85.6 });
    expect(resolveWarpGeometry(capturePaperSelection('original'))).toEqual({ mode: 'measured' });
  });

  it('keeps Oficio as the Legal family with its nominal 216 x 356 mm size', () => {
    expect(getPaperFormat('oficio')).toMatchObject({
      id: 'legal',
      aliases: ['legal', 'oficio'],
      nominalMm: { width: 216, height: 356 },
    });
    expect(PAPER_FORMATS.map((format) => format.id)).toEqual(['a4', 'letter', 'legal', 'ticket', 'original']);
  });

  it('preselects canonical A4 as a low-confidence probabilistic A-series recommendation', () => {
    const result = classifyPaperRatio(210 / 297);
    expect(result).toMatchObject({ id: 'a4', alias: 'a4', source: 'auto', confidence: 'low' });
    expect(result.evidence.scaleInferred).toBe(false);
    expect(result.evidence.probabilistic).toBe(true);
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

  it('keeps legacy and manual A4 selections non-probabilistic', () => {
    expect(selectionFromLegacyAspectRatio('a4').evidence.probabilistic).toBeUndefined();
    expect(paperSelection('a4', 'manual').evidence.probabilistic).toBeUndefined();
  });
});
