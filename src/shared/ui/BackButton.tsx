/**
 * The one back affordance, shared by every screen that has a previous step
 * (navigation-ux, bug 3: "no hay botón de volver en casi ninguna pantalla").
 *
 * A single component rather than a chevron re-drawn per screen, because the
 * whole complaint was inconsistency: a control that means "go back" has to
 * look and sit the same everywhere, or it stops reading as a control at all.
 *
 * `tone` exists because two of the screens are full-bleed over a black camera
 * or preview surface, where the app's normal muted foreground disappears.
 */

import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from '@/shared/i18n';

export interface BackButtonProps {
  readonly onClick: () => void;
  /** `'surface'` for normal screens, `'overlay'` for full-bleed dark ones (camera, viewer). */
  readonly tone?: 'surface' | 'overlay';
  /** Overrides the default "Back" label for screen readers. */
  readonly label?: string;
  readonly testId?: string;
  readonly className?: string;
}

const TONE_CLASSES: Record<'surface' | 'overlay', string> = {
  surface: 'text-text-muted hover:bg-surface hover:text-text',
  overlay: 'bg-black/45 text-white hover:bg-black/65',
};

export function BackButton({
  onClick,
  tone = 'surface',
  label,
  testId = 'back-button',
  className,
}: BackButtonProps): ReactNode {
  const { t } = useTranslation();
  const accessibleLabel = label ?? t('common.back');

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      // 44px minimum: this is the control users reach for by reflex on a
      // phone, often one-handed, and it sits in the corner where thumbs are
      // least precise.
      className={[
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light',
        TONE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
    >
      <ChevronLeft size={22} aria-hidden="true" />
    </button>
  );
}
