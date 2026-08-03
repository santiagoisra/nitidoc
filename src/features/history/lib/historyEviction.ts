/**
 * Size-capped LRU retention for the scan history (design section 7).
 *
 * The whole point of the two-store schema is visible here: eviction decides
 * what to delete by reading ONLY `documents` metadata records — a few KB each,
 * carrying their own `sizeBytes` — and never deserializes a single page blob to
 * find out how much space it is reclaiming.
 */

import { HISTORY } from '@/features/history/lib/historyConstants';
import { pageRangeFor, promisifyRequest, runTransaction } from '@/features/history/lib/historyDb';
import type { HistoryDocumentMeta } from '@/shared/types/history';

export interface EvictionResult {
  /** Ids removed, oldest-first. Empty when the history already fit the budget. */
  readonly evictedIds: readonly string[];
  readonly freedBytes: number;
}

/**
 * Deletes the least-recently-opened non-pinned documents until the total fits
 * `budgetBytes`.
 *
 * Pinned documents still COUNT toward the total but are never deleted. If the
 * pinned set alone exceeds the budget, eviction removes everything it is
 * allowed to and then stops rather than looping — the user explicitly asked to
 * keep those, and silently discarding them would be a worse outcome than being
 * over budget.
 */
export async function enforceBudget(
  budgetBytes: number = HISTORY.BUDGET_BYTES,
): Promise<EvictionResult> {
  const metas = await runTransaction(HISTORY.DOCUMENTS_STORE, 'readonly', (tx) =>
    promisifyRequest<HistoryDocumentMeta[]>(
      tx.objectStore(HISTORY.DOCUMENTS_STORE).index(HISTORY.INDEX_LAST_OPENED_AT).getAll(),
    ),
  );

  // `getAll` on the index yields ascending `lastOpenedAt` — least recently
  // opened first, which is exactly the eviction order.
  let total = metas.reduce((sum, meta) => sum + meta.sizeBytes, 0);
  if (total <= budgetBytes) {
    return { evictedIds: [], freedBytes: 0 };
  }

  const doomed: HistoryDocumentMeta[] = [];
  for (const meta of metas) {
    if (total <= budgetBytes) break;
    if (meta.pinned) continue;
    doomed.push(meta);
    total -= meta.sizeBytes;
  }

  if (doomed.length === 0) {
    return { evictedIds: [], freedBytes: 0 };
  }

  await runTransaction([HISTORY.DOCUMENTS_STORE, HISTORY.PAGES_STORE], 'readwrite', (tx) => {
    const documents = tx.objectStore(HISTORY.DOCUMENTS_STORE);
    const pages = tx.objectStore(HISTORY.PAGES_STORE);
    doomed.forEach((meta) => {
      documents.delete(meta.id);
      pages.delete(pageRangeFor(meta.id));
    });
  });

  return {
    evictedIds: doomed.map((meta) => meta.id),
    freedBytes: doomed.reduce((sum, meta) => sum + meta.sizeBytes, 0),
  };
}
