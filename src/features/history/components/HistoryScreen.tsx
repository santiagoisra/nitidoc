/**
 * The scan history screen (history design section 6).
 *
 * Opening a document is the only place that reads page blobs: the list itself
 * is fed entirely by `documents` metadata records, so scrolling a long history
 * costs nothing but a cover image per row.
 */

import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { HistoryCard } from '@/features/history/components/HistoryCard';
import { useHistoryList } from '@/features/history/hooks/useHistoryList';
import { formatBytes } from '@/features/history/lib/formatBytes';
import { isHistoryAvailable } from '@/features/history/lib/historyDb';
import { loadDocumentPages } from '@/features/history/lib/historyRepository';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import { useTranslation } from '@/shared/i18n';
import { Button, useToast } from '@/shared/ui';

export interface HistoryScreenProps {
  /** Returns to the scanner without loading anything. */
  readonly onBack: () => void;
  /** Fired after a document has been loaded into the store, so the shell can show the scanner. */
  readonly onOpened: () => void;
}

export function HistoryScreen({ onBack, onOpened }: HistoryScreenProps): ReactNode {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { documents, usage, loading, remove, togglePin } = useHistoryList();
  const loadDocumentFromHistory = useScannerStore((state) => state.loadDocumentFromHistory);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const handleOpen = useCallback(
    (id: string) => {
      if (openingId !== null) return;
      setOpeningId(id);
      void (async () => {
        try {
          const pages = await loadDocumentPages(id);
          if (pages.length === 0) {
            // Empty means the record vanished between listing and opening
            // (evicted, or deleted in another tab) — not a crash, just a stale
            // row the user tapped.
            showToast({ message: t('history.openError'), variant: 'danger' });
            return;
          }
          loadDocumentFromHistory(id, pages);
          onOpened();
        } catch {
          showToast({ message: t('history.openError'), variant: 'danger' });
        } finally {
          setOpeningId(null);
        }
      })();
    },
    [loadDocumentFromHistory, onOpened, openingId, showToast, t],
  );

  const handleDelete = useCallback(
    (id: string) => {
      void remove(id);
    },
    [remove],
  );

  const handleTogglePin = useCallback(
    (id: string, pinned: boolean) => {
      void togglePin(id, pinned);
    },
    [togglePin],
  );

  return (
    <div className="flex w-full max-w-md flex-1 flex-col gap-5 py-2" data-testid="history-screen">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('history.back')}
          className="flex h-11 w-11 items-center justify-center rounded-full text-text-muted
            transition-colors hover:bg-surface hover:text-text
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
          data-testid="history-back"
        >
          <ChevronLeft size={22} />
        </button>
        <h1 className="text-xl font-extrabold tracking-tight text-text">{t('history.title')}</h1>
      </div>

      {!isHistoryAvailable() && (
        <p role="status" className="text-sm text-text-muted" data-testid="history-unavailable">
          {t('history.unavailable')}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-text-muted" data-testid="history-loading">
          {t('history.loading')}
        </p>
      ) : documents.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center" data-testid="history-empty">
          <p className="text-base font-semibold text-text">{t('history.empty')}</p>
          <p className="max-w-[18rem] text-sm text-text-muted">{t('history.emptyHint')}</p>
          <Button type="button" variant="ghost" onClick={onBack} className="mt-3">
            {t('history.back')}
          </Button>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2" data-testid="history-list">
            {documents.map((meta) => (
              <HistoryCard
                key={meta.id}
                document={meta}
                onOpen={handleOpen}
                onDelete={handleDelete}
                onTogglePin={handleTogglePin}
              />
            ))}
          </ul>

          {usage && (
            <p className="text-center text-xs text-text-muted" data-testid="history-usage">
              {t('history.usage', {
                used: formatBytes(usage.totalBytes),
                total: formatBytes(usage.budgetBytes),
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
