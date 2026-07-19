import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

// Warm redesign (HANDOFF-UI.md section 6, "Reglas transversales"):
// primary is ALWAYS a teal pill with near-black text (AA on teal), a teal
// glow shadow and a lighter-teal hover; ghost is a hairline stone border that
// warms to primary-light on hover. Buttons are pills globally (section 1).
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-[#0f0e0c] shadow-[0_8px_22px_rgba(46,196,173,0.3)] hover:bg-primary-light active:bg-primary-light',
  secondary: 'bg-surface text-text hover:bg-surface-2 active:bg-surface-2 border border-text/10',
  ghost: 'bg-transparent text-text border border-text/15 hover:border-primary-light/50 hover:bg-surface/40 active:bg-surface/50',
  danger: 'bg-danger text-text hover:bg-danger/90 active:bg-danger/80',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold ' +
  'min-h-[44px] min-w-[44px] transition-colors duration-150 ' +
  'disabled:opacity-50 disabled:pointer-events-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light focus-visible:ring-offset-2 focus-visible:ring-offset-bg ' +
  'active:translate-y-[1px]';

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', className, children, ...rest },
  ref,
) {
  const classes = [BASE_CLASSES, VARIANT_CLASSES[variant], className].filter(Boolean).join(' ');

  return (
    <button ref={ref} className={classes} {...rest}>
      {children}
    </button>
  );
});
