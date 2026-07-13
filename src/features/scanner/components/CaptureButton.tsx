/**
 * FAB (72px) that triggers a manual capture (proposal section 4.1
 * `CaptureButton.tsx`; proposal section 5 CAP-3).
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 6): the animated countdown ring
 * that used to reflect the live-detection loop's auto-capture countdown
 * (0-3) is REMOVED along with the rest of that path — every capture is
 * manual now (`CaptureScreen`'s tap-to-capture flow), so there is no
 * countdown state left to display.
 */

import type { ReactNode } from 'react';
import { Camera } from 'lucide-react';
import { useTranslation } from '@/shared/i18n';

export interface CaptureButtonProps {
  readonly onCapture: () => void;
  readonly disabled?: boolean;
  /**
   * Bumps once per capture. Used as the shutter-ring's React `key` so each
   * shot remounts (and therefore re-plays) the one-shot expand animation —
   * `0` (the default) renders no ring, so the very first mount stays still.
   */
  readonly shutterKey?: number;
}

export function CaptureButton({ onCapture, disabled = false, shutterKey = 0 }: CaptureButtonProps): ReactNode {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onCapture}
      disabled={disabled}
      data-testid="capture-button"
      aria-label={t('capture.captureDocument')}
      className="relative flex h-[72px] w-[72px] items-center justify-center rounded-full bg-primary text-bg
        shadow-lg transition-transform duration-150 ease-out
        hover:bg-primary-dark active:translate-y-[1px] active:scale-[0.98]
        disabled:opacity-50 disabled:pointer-events-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      {shutterKey > 0 && (
        <span
          key={shutterKey}
          aria-hidden="true"
          data-testid="capture-shutter-ring"
          className="animate-capture-ring pointer-events-none absolute inset-0 rounded-full border-2 border-primary-light"
        />
      )}
      <Camera size={28} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}
