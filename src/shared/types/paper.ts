/**
 * Domain contracts for nominal paper formats. These remain independent from
 * raster pixels: a crop ratio can describe shape, never physical scale.
 */

export type PaperFormatId = 'a4' | 'letter' | 'legal' | 'ticket' | 'original';

/** `oficio` is a persisted user-facing alias of the canonical Legal family. */
export type PaperFormatAlias = PaperFormatId | 'oficio';

export type PaperSelectionSource = 'auto' | 'manual' | 'legacy';

export type PaperConfidence = 'high' | 'medium' | 'low' | 'none';

export interface PaperFormat {
  readonly id: PaperFormatId;
  readonly aliases: readonly PaperFormatAlias[];
  readonly label: string;
  readonly nominalMm?: Readonly<{ width: number; height: number }>;
  /** Portrait width / height. Absent when the raster ratio must be retained. */
  readonly portraitRatio?: number;
}

export interface PaperEvidence {
  readonly measuredRatio: number;
  readonly relativeError?: number;
  readonly runnerUpMargin?: number;
  /** Ratios and pixels never establish a physical measurement. */
  readonly scaleInferred: false;
}

export interface PaperSelection {
  readonly id: PaperFormatId;
  readonly alias: PaperFormatAlias;
  readonly source: PaperSelectionSource;
  readonly confidence: PaperConfidence;
  readonly evidence: PaperEvidence;
}

/** Numeric-only worker contract; the worker does not know UI labels or aliases. */
export type WarpGeometry =
  | Readonly<{ mode: 'fixed'; portraitRatio: number }>
  | Readonly<{ mode: 'measured' }>;
