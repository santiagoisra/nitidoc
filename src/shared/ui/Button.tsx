import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-bg hover:bg-primary-dark active:bg-primary-dark',
  secondary: 'bg-surface text-text hover:bg-surface/80 active:bg-surface/70 border border-text-muted/20',
  ghost: 'bg-transparent text-text hover:bg-surface/60 active:bg-surface/50',
  danger: 'bg-danger text-text hover:bg-danger/90 active:bg-danger/80',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ' +
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
