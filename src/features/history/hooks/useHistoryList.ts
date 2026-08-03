/**
 * `useHistoryList` — list/delete/pin state for `HistoryScreen` (history design
 * section 6).
 *
 * Reads the `documents` store ONLY. No page blob is deserialized to render the
 * list, which is the entire reason the schema splits metadata from pages.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  deleteDocument,
  getUsage,
  listDocuments,
  setPinned,
} from '@/features/history/lib/historyRepository';
import type { HistoryDocumentMeta, HistoryUsage } from '@/shared/types/history';

export interface UseHistoryListResult {
  readonly documents: readonly HistoryDocumentMeta[];
  readonly usage: HistoryUsage | null;
  readonly loading: boolean;
  readonly remove: (id: string) => Promise<void>;
  readonly togglePin: (id: string, pinned: boolean) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export function useHistoryList(): UseHistoryListResult {
  const [documents, setDocuments] = useState<readonly HistoryDocumentMeta[]>([]);
  const [usage, setUsage] = useState<HistoryUsage | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [metas, nextUsage] = await Promise.all([listDocuments(), getUsage()]);
    setDocuments(metas);
    setUsage(nextUsage);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [metas, nextUsage] = await Promise.all([listDocuments(), getUsage()]);
      // The screen can be closed mid-read; assigning after unmount would warn
      // and, worse, keep the cover blobs referenced by dead state.
      if (cancelled) return;
      setDocuments(metas);
      setUsage(nextUsage);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = useCallback(
    async (id: string) => {
      // Optimistic: the row disappears immediately, then the real usage
      // figure comes back from the refresh. A failed delete re-appears on the
      // next refresh rather than lying about being gone.
      setDocuments((current) => current.filter((meta) => meta.id !== id));
      await deleteDocument(id);
      await refresh();
    },
    [refresh],
  );

  const togglePin = useCallback(
    async (id: string, pinned: boolean) => {
      setDocuments((current) =>
        current.map((meta) => (meta.id === id ? { ...meta, pinned } : meta)),
      );
      await setPinned(id, pinned);
    },
    [],
  );

  return { documents, usage, loading, remove, togglePin, refresh };
}
