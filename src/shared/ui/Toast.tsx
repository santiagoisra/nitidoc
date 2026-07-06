import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export interface ToastProps {
  readonly variant?: ToastVariant;
  readonly message: string;
}

const VARIANT_ICON: Record<ToastVariant, ReactNode> = {
  info: <Info size={18} strokeWidth={1.5} aria-hidden="true" />,
  success: <CheckCircle2 size={18} strokeWidth={1.5} aria-hidden="true" />,
  warning: <AlertTriangle size={18} strokeWidth={1.5} aria-hidden="true" />,
  danger: <XCircle size={18} strokeWidth={1.5} aria-hidden="true" />,
};

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  info: 'border-text-muted/30 text-text',
  success: 'border-success/40 text-success',
  warning: 'border-warning/40 text-warning',
  danger: 'border-danger/40 text-danger',
};

/**
 * Single toast notification. Fase 1 ships the presentational primitive only;
 * a toast queue/manager is added when a capability needs to surface one
 * (e.g. OpenCV load failure in Group 6).
 */
export function Toast({ variant = 'info', message }: ToastProps): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 rounded-lg border bg-surface px-4 py-3 text-sm shadow-lg ${VARIANT_CLASSES[variant]}`}
    >
      {VARIANT_ICON[variant]}
      <span>{message}</span>
    </div>
  );
}
