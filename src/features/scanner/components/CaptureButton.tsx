/**
 * FAB (72px) that triggers a manual capture at any time, regardless of
 * auto-capture state (task 4.4.1; proposal section 4.1 `CaptureButton.tsx`;
 * proposal section 5 CAP-3).
 *
 * The animated ring communicates the auto-capture countdown (0-3) when one
 * is in progress; it is purely decorative (`aria-hidden`) — the actual
 * countdown state is announced via `QualityHints`' aria-live region, not
 * here, to avoid double-announcing the same state from two elements.
 *
 * `prefers-reduced-motion` is respected via Tailwind's `motion-reduce:`
 * variant: the ring stops spinning/pulsing and instead just renders as a
 * static ring reflecting the current countdown step.
 */

import type { ReactNode } from 'react';
import { Camera } from 'lucide-react';

export interface CaptureButtonProps {
  readonly onCapture: () => void;
  /** 0 = no countdown in progress. 1-3 = countdown steps remaining. */
  readonly countdown: 0 | 1 | 2 | 3;
  readonly disabled?: boolean;
}

export function CaptureButton({ onCapture, countdown, disabled = false }: CaptureButtonProps): ReactNode {
  const isCountingDown = countdown > 0;

  return (
    <button
      type="button"
      onClick={onCapture}
      disabled={disabled}
      data-testid="capture-button"
      aria-label={isCountingDown ? `Auto-capturing in ${countdown}` : 'Capture document'}
      className="relative flex h-[72px] w-[72px] items-center justify-center rounded-full bg-primary text-bg
        shadow-lg transition-transform duration-150 ease-out
        hover:bg-primary-dark active:translate-y-[1px] active:scale-[0.98]
        disabled:opacity-50 disabled:pointer-events-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-full border-2 border-primary-light
          ${
            isCountingDown
              ? 'motion-safe:animate-pulse motion-reduce:opacity-100 opacity-80'
              : 'opacity-0'
          }`}
      />
      <Camera size={28} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}
