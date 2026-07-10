import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

/** A single actionable button rendered inside the toast (e.g. "Undo"). */
export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastProps {
  readonly variant?: ToastVariant;
  readonly message: string;
  /**
   * Fase 2 addition (design section 5.5): an optional action button (e.g.
   * "Undo" on page deletion). `Toast` itself never times anything or removes
   * itself — it is still a pure presentational primitive; `ToastHost` owns
   * the queue/auto-dismiss timer that decides how long this stays mounted.
   */
  readonly action?: ToastAction;
  /**
   * Fase 2 addition: how long `ToastHost` should keep this toast visible
   * before auto-dismissing it. `Toast` itself does not read this prop — it
   * exists on `ToastProps` so callers can pass the SAME options object to
   * both `ToastHost.showToast` and (if ever rendered standalone) `Toast`
   * without a shape mismatch. Optional; `ToastHost` applies its own default
   * when omitted.
   */
  readonly durationMs?: number;
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
 * Single toast notification. Fase 1 shipped the presentational primitive
 * only. Fase 2 (design section 5.5, Group 6/PR9) adds an optional `action`
 * button (e.g. "Undo") — the queue/timer/host that decides WHEN this
 * unmounts (`ToastHost`) is a separate, additive component; this primitive
 * is still purely presentational and does NOT rebuild.
 */
export function Toast({ variant = 'info', message, action }: ToastProps): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-between gap-3 rounded-lg border bg-surface px-4 py-3 text-sm shadow-lg ${VARIANT_CLASSES[variant]}`}
    >
      <span className="flex items-center gap-2">
        {VARIANT_ICON[variant]}
        <span>{message}</span>
      </span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
