/**
 * `usePageDeletion` — deletion + undo controller (design section 5.5, spec
 * `document` Req "Borrado de pagina con undo por toast"; Group 6/PR9).
 *
 * Ownership split (design section 5.5, normative):
 *  - the STORE (`documentSlice.ts`) owns retention state (`pendingDeletion`),
 *  - this HOOK owns the 5s undo-window timer (business logic: when it
 *    expires, the deletion becomes permanent),
 *  - `ToastHost` owns rendering + its OWN independent visual auto-dismiss
 *    timer.
 *
 * This hook's timer is deliberately separate from `ToastHost`'s: the toast
 * disappearing visually and the page's resources being hard-released are two
 * different concerns that happen to share a duration today (`UNDO_WINDOW_MS`
 * === the toast's `durationMs`), not the same mechanism.
 */

import { useCallback, useRef } from 'react';
import { useToast } from '@/shared/ui';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

/** Starting value (design section 5.5): "5000ms is a starting value". */
export const UNDO_WINDOW_MS = 5000;

export interface UsePageDeletionResult {
  /** Drop-in replacement for `DocumentSlice.deletePage` at UI call sites (e.g. `PageGrid.onDeletePage`). */
  readonly deletePage: (pageId: string) => void;
}

export function usePageDeletion(): UsePageDeletionResult {
  const { showToast, dismissToast } = useToast();
  // Tracks THIS hook's own undo-window timer (not ToastHost's). Only one
  // deletion can be pending at a time (only one `pendingDeletion` slot
  // exists in the store — design section 1.5), so a single ref suffices.
  const hardReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const deletePage = useCallback(
    (pageId: string) => {
      const state = useScannerStore.getState();

      // A second delete while one is already pending must supersede the
      // older one: cancel this hook's OWN stale timer first (so it never
      // fires against whatever ends up pending next) and hard-release the
      // older page's resources explicitly, BEFORE the new deletePage call
      // (design section 1.5 "a second deletePage while one is pending" row).
      if (state.pendingDeletion !== null) {
        if (hardReleaseTimerRef.current !== null) {
          clearTimeout(hardReleaseTimerRef.current);
          hardReleaseTimerRef.current = null;
        }
        state.hardReleaseDeletion();
      }

      state.deletePage(pageId);

      let toastId = '';
      toastId = showToast({
        message: 'Page removed.',
        variant: 'info',
        durationMs: UNDO_WINDOW_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            if (hardReleaseTimerRef.current !== null) {
              clearTimeout(hardReleaseTimerRef.current);
              hardReleaseTimerRef.current = null;
            }
            dismissToast(toastId);
            useScannerStore.getState().restorePage();
          },
        },
      });

      hardReleaseTimerRef.current = setTimeout(() => {
        hardReleaseTimerRef.current = null;
        useScannerStore.getState().hardReleaseDeletion();
      }, UNDO_WINDOW_MS);
    },
    [showToast, dismissToast],
  );

  return { deletePage };
}
