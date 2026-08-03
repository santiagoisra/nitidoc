/**
 * `useSaveToHistory` — the single "this document is finished, persist it" action
 * (history design section 6).
 *
 * Fired from the two places a document is actually done: a successful PDF
 * export, and the grid's "Listo" transition into the `done` phase. Both go
 * through `DocumentSlice.documentId`, so the second one to fire UPDATES the
 * record the first one wrote rather than creating a duplicate.
 *
 * Deliberately not fired per-capture: incremental autosave would write during
 * the phase of highest memory pressure and leave half-finished documents in the
 * database to reconcile (design section 2, "when is a scan written").
 */

import { useCallback } from 'react';
import { saveDocument } from '@/features/history/lib/historyRepository';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import { useTranslation } from '@/shared/i18n';
import { useToast } from '@/shared/ui';

export interface UseSaveToHistoryResult {
  /** Fire-and-forget; never rejects. Resolves to whether the document was persisted. */
  readonly saveToHistory: (pages: readonly DocumentPage[]) => Promise<boolean>;
}

/**
 * Documents with a write in flight, guarding against the export path and the
 * "Listo" path racing on the same document.
 *
 * Module-level rather than a `useRef`, and that is the whole point: the two
 * call sites live in DIFFERENT hook instances (`useExportPdf` and
 * `ScannerScreen`), so a per-instance ref would not see the other's write at
 * all. Both writes are idempotent `put`s, so a race corrupts nothing — but it
 * would re-encode every thumbnail in the document for no reason.
 */
const inFlight = new Set<string>();

export function useSaveToHistory(): UseSaveToHistoryResult {
  const { t, locale } = useTranslation();
  const { showToast } = useToast();
  const documentId = useScannerStore((state) => state.documentId);

  const saveToHistory = useCallback(
    async (pages: readonly DocumentPage[]): Promise<boolean> => {
      if (pages.length === 0 || inFlight.has(documentId)) {
        return false;
      }
      inFlight.add(documentId);
      try {
        const title = t('history.documentTitle', {
          date: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(
            new Date(),
          ),
        });

        const result = await saveDocument(documentId, title, pages);

        if (!result.saved && result.reason === 'quota') {
          showToast({ message: t('history.saveQuotaError'), variant: 'danger' });
        } else if (!result.saved && result.reason === 'error') {
          showToast({ message: t('history.saveError'), variant: 'danger' });
        }
        // `reason === 'unavailable'` stays silent on purpose: storage being
        // off (private mode) is a standing condition of the environment, not
        // an event worth interrupting the user about on every single export.

        return result.saved;
      } finally {
        inFlight.delete(documentId);
      }
    },
    [documentId, locale, showToast, t],
  );

  return { saveToHistory };
}
