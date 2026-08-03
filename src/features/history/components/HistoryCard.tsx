/**
 * One row of the scan history: cover, title, page count, size, and the
 * open/pin/delete actions.
 *
 * The cover is a `Blob` straight out of IndexedDB, so this component owns an
 * object URL for it and MUST revoke it on unmount — a history long enough to
 * scroll would otherwise leak one decoded image per row for the lifetime of
 * the document.
 */

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Pin, PinOff, Trash2 } from 'lucide-react';
import { formatBytes } from '@/features/history/lib/formatBytes';
import { useTranslation } from '@/shared/i18n';
import type { HistoryDocumentMeta } from '@/shared/types/history';

export interface HistoryCardProps {
  readonly document: HistoryDocumentMeta;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onTogglePin: (id: string, pinned: boolean) => void;
}

export function HistoryCard({ document, onOpen, onDelete, onTogglePin }: HistoryCardProps): ReactNode {
  const { t } = useTranslation();
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(document.cover);
    setCoverUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [document.cover]);

  return (
    <li
      className="flex items-center gap-3 rounded-2xl border border-text/10 bg-surface p-3"
      data-testid="history-card"
      data-document-id={document.id}
    >
      {/* The whole cover+title block opens the document — a bigger target than
          a text link, and the obvious thing to tap on a phone. */}
      <button
        type="button"
        onClick={() => onOpen(document.id)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light
          focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        data-testid="history-open"
      >
        <span className="h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-surface-2">
          {coverUrl && (
            <img src={coverUrl} alt="" className="h-full w-full object-cover" draggable={false} />
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-text">{document.title}</span>
          <span className="text-xs text-text-muted">
            {t('history.pageCount', { n: document.pageCount })} · {formatBytes(document.sizeBytes)}
          </span>
          {document.pinned && (
            <span className="text-xs font-medium text-primary">{t('history.pinned')}</span>
          )}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onTogglePin(document.id, !document.pinned)}
          aria-label={document.pinned ? t('history.unpin') : t('history.pin')}
          className="flex h-11 w-11 items-center justify-center rounded-full text-text-muted
            transition-colors hover:bg-surface-2 hover:text-text
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
          data-testid="history-pin"
        >
          {document.pinned ? <PinOff size={18} /> : <Pin size={18} />}
        </button>
        <button
          type="button"
          onClick={() => onDelete(document.id)}
          aria-label={t('history.deleteDocument')}
          className="flex h-11 w-11 items-center justify-center rounded-full text-text-muted
            transition-colors hover:bg-surface-2 hover:text-danger
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
          data-testid="history-delete"
        >
          <Trash2 size={18} />
        </button>
      </div>
    </li>
  );
}
