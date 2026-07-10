/**
 * Accessible quality feedback for the live-detection loop (task 4.5.1;
 * scanner spec "Feedback de calidad en vivo"; proposal section 5 CAP-5).
 *
 * Exposes a single `aria-live="polite"` region so assistive tech announces
 * hint changes without needing focus to move. Priority when multiple
 * conditions are true simultaneously (most actionable first): too far >
 * too dark > blurry > detecting (not yet stable). Only one hint is shown at
 * a time to avoid overwhelming the user with simultaneous, sometimes-
 * contradictory feedback.
 *
 * "Too far" is computed by the CALLER on the UI thread from the raw
 * detected contour's area ratio (task 4.5.2, `isTooFar` in
 * `detectionMath.ts`) — this component only renders the resulting boolean,
 * it does not compute it, keeping this component a pure presentational
 * consumer of `DetectionSlice.quality` + the passed-in `tooFar` flag.
 *
 * "Blurry" (bug fix, Fase 2.2 punch-list item 1): this used to be mislabeled
 * "Hold steady", implying the fix is to hold the device still. The blur
 * signal is a Laplacian-variance sharpness check on the downscaled 640px
 * detection frame (`computeQuality` in `opencv.worker.ts`) — it has nothing
 * to do with motion, so the copy was actively misleading (and, combined
 * with a too-high threshold for the downscaled frame, was near-permanently
 * true even for a document sitting still on a tripod). The copy now says
 * "blurry" and suggests focusing/lighting instead.
 *
 * "Detecting" (secondary, Fase 2.2 punch-list item 1): surfaces the REAL
 * corner-stability signal (`DetectionSlice.stability`, driven by
 * `maxCornerStdDevPx` vs `STABILITY_STDDEV_PX` in `useDocumentDetection`) —
 * the exact metric auto-capture itself gates on — instead of leaving the
 * user with no feedback while a document is detected but the countdown
 * hasn't armed yet.
 */

import type { ReactNode } from 'react';
import { useTranslation } from '@/shared/i18n';
import type { TranslationKey } from '@/shared/i18n';
import type { QualityMetrics } from '@/shared/types/geometry';

export interface QualityHintsProps {
  readonly quality: QualityMetrics | null;
  readonly tooFar: boolean;
  /** Whether a document contour is currently detected (`DetectionSlice.rawCorners != null`). */
  readonly detected: boolean;
  /** `DetectionSlice.stability`: 1 when corners are stable enough for auto-capture, 0 otherwise. */
  readonly stability: number;
}

type HintKind = 'too-far' | 'too-dark' | 'blurry' | 'detecting' | null;

function resolveHint(
  quality: QualityMetrics | null,
  tooFar: boolean,
  detected: boolean,
  stability: number,
): HintKind {
  if (tooFar) {
    return 'too-far';
  }
  if (quality?.isDark) {
    return 'too-dark';
  }
  if (quality?.isBlurry) {
    return 'blurry';
  }
  if (detected && stability < 1) {
    return 'detecting';
  }
  return null;
}

const HINT_KEY: Record<Exclude<HintKind, null>, TranslationKey> = {
  'too-far': 'quality.moveCloser',
  'too-dark': 'quality.tooDark',
  blurry: 'quality.blurry',
  detecting: 'quality.detecting',
};

export function QualityHints({ quality, tooFar, detected, stability }: QualityHintsProps): ReactNode {
  const { t } = useTranslation();
  const hint = resolveHint(quality, tooFar, detected, stability);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="quality-hints"
      className="min-h-[1.5rem] text-center text-sm font-medium text-text-muted"
    >
      {hint ? t(HINT_KEY[hint]) : null}
    </div>
  );
}
