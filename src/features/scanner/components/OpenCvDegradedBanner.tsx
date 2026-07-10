/**
 * Degraded-mode banner shown when OpenCV.js failed to load after exhausting
 * automatic retries (Group 6 / Slice F, task 6.6.1; design section 4.4;
 * scanner spec "Fallo de carga de OpenCV.js").
 *
 * Product-scope decision recorded here per design section 11 ("alcance del
 * degradado, confirmar en apply"): degraded mode means the user can still
 * CAPTURE (manual only — no live detection, no auto-capture, no quality
 * hints, since all of those need OpenCV) and EDIT corners with the frame
 * fully visible. `CornerEditor.runWarp` already calls
 * `workerClient.warp(...)` unconditionally; if OpenCV recovers (a manual or
 * still-pending automatic retry succeeds) the NEXT warp attempt simply
 * succeeds because the worker's `cv` binding is now populated — no special
 * "deferred warp" plumbing is needed beyond retrying `INIT`. If OpenCV never
 * recovers, warp keeps failing and `CornerEditor`'s existing `warpError`
 * state communicates that per-attempt; this banner communicates the
 * upstream CAUSE (no OpenCV) rather than duplicating that per-warp error.
 */

import type { ReactNode } from 'react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';

export interface OpenCvDegradedBannerProps {
  readonly lastError: string | null;
  readonly onRetry: () => void;
}

export function OpenCvDegradedBanner({ lastError, onRetry }: OpenCvDegradedBannerProps): ReactNode {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex w-full max-w-md flex-col items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-center"
      data-testid="opencv-degraded-banner"
    >
      <p className="text-sm text-text">
        {t('opencv.unavailable', { error: lastError ? ` (${lastError})` : '' })}
      </p>
      <Button type="button" variant="secondary" onClick={onRetry} data-testid="opencv-retry-button">
        {t('opencv.retry')}
      </Button>
    </div>
  );
}
