import type {
  PaperConfidence,
  PaperEvidence,
  PaperFormat,
  PaperFormatAlias,
  PaperSelection,
  WarpGeometry,
} from '@/shared/types/paper';

const A4_RATIO = 210 / 297;
const LETTER_RATIO = 215.9 / 279.4;
const LEGAL_RATIO = 216 / 356;

export const PAPER_FORMATS: readonly PaperFormat[] = [
  { id: 'a4', aliases: ['a4'], label: 'A4', nominalMm: { width: 210, height: 297 }, portraitRatio: A4_RATIO },
  { id: 'letter', aliases: ['letter'], label: 'Letter', nominalMm: { width: 215.9, height: 279.4 }, portraitRatio: LETTER_RATIO },
  { id: 'legal', aliases: ['legal', 'oficio'], label: 'Legal', nominalMm: { width: 216, height: 356 }, portraitRatio: LEGAL_RATIO },
  { id: 'ticket', aliases: ['ticket'], label: 'Ticket' },
  { id: 'original', aliases: ['original'], label: 'Original' },
] as const;

const DETECTABLE_FORMATS = PAPER_FORMATS.filter(
  (format): format is PaperFormat & Required<Pick<PaperFormat, 'portraitRatio'>> =>
    format.portraitRatio !== undefined,
);

const HIGH_MAX_ERROR = 0.015;
const HIGH_MIN_MARGIN = 0.03;
const MEDIUM_MAX_ERROR = 0.03;
const MEDIUM_MIN_MARGIN = 0.015;
const TICKET_MAX_RATIO = 1 / 2.4;
const A_SERIES_MAX_ERROR = 0.03;

function evidence(measuredRatio: number, relativeError?: number, runnerUpMargin?: number): PaperEvidence {
  return { measuredRatio, relativeError, runnerUpMargin, scaleInferred: false };
}

export function getPaperFormat(alias: PaperFormatAlias): PaperFormat {
  const format = PAPER_FORMATS.find((candidate) => candidate.aliases.includes(alias));
  if (!format) throw new Error(`Unsupported paper format: ${alias}`);
  return format;
}

export function paperSelection(
  alias: PaperFormatAlias,
  source: PaperSelection['source'],
  confidence: PaperConfidence = source === 'manual' ? 'none' : 'low',
  measuredRatio = 0,
): PaperSelection {
  return { id: getPaperFormat(alias).id, alias, source, confidence, evidence: evidence(measuredRatio) };
}

/** Creates a manual choice without discarding the measured shape evidence needed by clear-to-auto. */
export function manualPaperSelection(alias: PaperFormatAlias, previous: PaperSelection): PaperSelection {
  return paperSelection(alias, 'manual', 'none', previous.evidence.measuredRatio);
}

/**
 * Classifies shape evidence only. ISO A-series sheets share one ratio, so an
 * A-shaped crop yields a deliberately low-confidence canonical A4
 * recommendation with `scaleInferred: false` rather than physical-size
 * certainty. Legal and Oficio share one candidate so an alias never creates
 * an artificial tie.
 */
export function classifyPaperRatio(measuredRatio: number): PaperSelection {
  if (!Number.isFinite(measuredRatio) || measuredRatio <= 0 || measuredRatio > 1) {
    return paperSelection('original', 'auto', 'none', measuredRatio);
  }
  // Retain the existing receipt behavior: this is a shape classification only,
  // so its resulting warp remains measured rather than becoming a page size.
  if (measuredRatio <= TICKET_MAX_RATIO) {
    return paperSelection('ticket', 'auto', 'high', measuredRatio);
  }

  const ranked = DETECTABLE_FORMATS
    .map((format) => ({ format, error: Math.abs(measuredRatio - format.portraitRatio) / format.portraitRatio }))
    .sort((a, b) => a.error - b.error);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || !runnerUp) return paperSelection('original', 'auto', 'none', measuredRatio);

  const margin = runnerUp.error - best.error;
  if (best.format.id === 'a4' && best.error <= A_SERIES_MAX_ERROR) {
    return {
      id: 'a4',
      alias: 'a4',
      source: 'auto',
      confidence: 'low',
      evidence: { ...evidence(measuredRatio, best.error, margin), probabilistic: true },
    };
  }
  const confidence: PaperConfidence =
    best.error <= HIGH_MAX_ERROR && margin >= HIGH_MIN_MARGIN
      ? 'high'
      : best.error <= MEDIUM_MAX_ERROR && margin >= MEDIUM_MIN_MARGIN
        ? 'medium'
        : 'none';

  if (confidence === 'none') {
    return { ...paperSelection('original', 'auto', 'none', measuredRatio), evidence: evidence(measuredRatio, best.error, margin) };
  }

  return {
    id: best.format.id,
    alias: best.format.id,
    source: 'auto',
    confidence,
    evidence: evidence(measuredRatio, best.error, margin),
  };
}

/** Restores automatic selection from persisted shape evidence; it never infers physical scale. */
export function automaticPaperSelection(previous: PaperSelection): PaperSelection {
  return classifyPaperRatio(previous.evidence.measuredRatio);
}

/** Reclassifies confirmed geometry unless the user explicitly chose a format. */
export function paperSelectionAfterCornerEdit(previous: PaperSelection, measuredRatio: number): PaperSelection {
  return previous.source === 'manual' ? previous : classifyPaperRatio(measuredRatio);
}

export function resolveWarpGeometry(selection: PaperSelection): WarpGeometry {
  const ratio = getPaperFormat(selection.alias).portraitRatio;
  return ratio === undefined ? { mode: 'measured' } : { mode: 'fixed', portraitRatio: ratio };
}

/** Converts old persisted crop labels without altering the crop itself. */
export function selectionFromLegacyAspectRatio(
  aspectRatio: 'a4' | 'letter' | 'ticket' | 'unknown',
  measuredRatio = 0,
): PaperSelection {
  const alias: PaperFormatAlias = aspectRatio === 'unknown' ? 'original' : aspectRatio;
  return paperSelection(alias, 'legacy', 'none', measuredRatio);
}
