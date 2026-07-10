/**
 * Accessible quality feedback for the live-detection loop (task 4.5.1;
 * scanner spec "Feedback de calidad en vivo"; proposal section 5 CAP-5).
 *
 * Exposes a single `aria-live="polite"` region so assistive tech announces
 * hint changes without needing focus to move. Priority when multiple
 * conditions are true simultaneously (most actionable first): too far >
 * too dark > blurry. Only one hint is shown at a time to avoid overwhelming
 * the user with simultaneous, sometimes-contradictory feedback.
 *
 * "Too far" is computed by the CALLER on the UI thread from the raw
 * detected contour's area ratio (task 4.5.2, `isTooFar` in
 * `detectionMath.ts`) — this component only renders the resulting boolean,
 * it does not compute it, keeping this component a pure presentational
 * consumer of `DetectionSlice.quality` + the passed-in `tooFar` flag.
 */

import type { ReactNode } from 'react';
import { useTranslation } from '@/shared/i18n';
import type { TranslationKey } from '@/shared/i18n';
import type { QualityMetrics } from '@/shared/types/geometry';

export interface QualityHintsProps {
  readonly quality: QualityMetrics | null;
  readonly tooFar: boolean;
}

type HintKind = 'too-far' | 'too-dark' | 'blurry' | null;

function resolveHint(quality: QualityMetrics | null, tooFar: boolean): HintKind {
  if (tooFar) {
    return 'too-far';
  }
  if (quality?.isDark) {
    return 'too-dark';
  }
  if (quality?.isBlurry) {
    return 'blurry';
  }
  return null;
}

const HINT_KEY: Record<Exclude<HintKind, null>, TranslationKey> = {
  'too-far': 'quality.moveCloser',
  'too-dark': 'quality.tooDark',
  blurry: 'quality.holdSteady',
};

export function QualityHints({ quality, tooFar }: QualityHintsProps): ReactNode {
  const { t } = useTranslation();
  const hint = resolveHint(quality, tooFar);

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
