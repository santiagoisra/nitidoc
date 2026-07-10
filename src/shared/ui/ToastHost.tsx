import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ToastAction, ToastVariant } from '@/shared/ui/Toast';
import { Toast } from '@/shared/ui/Toast';

/**
 * `ToastHost` — the toast queue + auto-dismiss timer + `useToast()` hook
 * (design section 5.5, Group 6/PR9). Extends the EXISTING presentational
 * `Toast` primitive; does not re-create it.
 *
 * Ownership split (design section 5.5, normative): `ToastHost` owns ONLY the
 * queue and each toast's own VISUAL auto-dismiss timer. It does not know
 * about page deletion, undo semantics, or the store — callers such as
 * `usePageDeletion` own their OWN domain-logic timer (e.g. "hard-release
 * after 5s") independently, and use `dismissToast` to remove the visual
 * toast immediately when their own action fires (e.g. "Undo" clicked).
 */

const DEFAULT_DURATION_MS = 4000;

export interface ShowToastOptions {
  readonly message: string;
  readonly variant?: ToastVariant;
  readonly action?: ToastAction;
  /** Defaults to `DEFAULT_DURATION_MS` when omitted. */
  readonly durationMs?: number;
}

export interface ToastContextValue {
  /** Enqueues a toast; returns its id so the caller can `dismissToast(id)` later (e.g. from an action's onClick). */
  readonly showToast: (options: ShowToastOptions) => string;
  readonly dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast() must be called within a <ToastHost>.');
  }
  return ctx;
}

interface QueuedToast extends ShowToastOptions {
  readonly id: string;
}

export interface ToastHostProps {
  readonly children: ReactNode;
}

/**
 * Mounted once near the app root (see `src/app/App.tsx`) so `useToast()` is
 * available anywhere in the tree. Renders `children` untouched plus a fixed
 * toast queue overlay.
 */
export function ToastHost({ children }: ToastHostProps): ReactNode {
  const [toasts, setToasts] = useState<readonly QueuedToast[]>([]);
  // Per-toast auto-dismiss timers, keyed by toast id — this host's OWN
  // timers, distinct from any domain-logic timer a caller (e.g.
  // `usePageDeletion`) keeps for itself.
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (options: ShowToastOptions): string => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { ...options, id }]);
      const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
      const timer = setTimeout(() => dismissToast(id), durationMs);
      timersRef.current.set(id, timer);
      return id;
    },
    [dismissToast],
  );

  // Clears every outstanding timer on unmount (this host's own visual timers
  // only — a caller's domain-logic timer is its own responsibility).
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ showToast, dismissToast }), [showToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
        data-testid="toast-host"
      >
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto w-full max-w-sm" data-testid={`toast-${toast.id}`}>
            <Toast variant={toast.variant} message={toast.message} action={toast.action} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
