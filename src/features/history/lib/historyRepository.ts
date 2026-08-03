/**
 * The scan history's public data API (design section 6).
 *
 * Every function here is safe to call when IndexedDB is unavailable or
 * failing: reads resolve to empty, writes resolve to a result object saying so.
 * History is an ENHANCEMENT — the scanner must stay fully usable in private
 * mode or with storage disabled, the same way `LocaleProvider` already degrades
 * when `localStorage` throws (design section 8).
 *
 * Transaction discipline: no function in this module ever awaits non-IDB work
 * while a transaction is open. Blob encoding/decoding lives in
 * `historyMapper.ts` and always runs before or after, never during. See the
 * module note in `historyDb.ts` for why that matters.
 */

import { HISTORY } from '@/features/history/lib/historyConstants';
import {
  isHistoryAvailable,
  pageRangeFor,
  promisifyRequest,
  runTransaction,
} from '@/features/history/lib/historyDb';
import { enforceBudget } from '@/features/history/lib/historyEviction';
import { computeSizeBytes, toDocumentPages, toStoredPages } from '@/features/history/lib/historyMapper';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { HistoryDocumentMeta, HistoryUsage, StoredPage } from '@/shared/types/history';

/** Why a save did not happen, when it did not. `null` reason means it did. */
export type SaveFailure = 'unavailable' | 'quota' | 'error';

export interface SaveResult {
  readonly saved: boolean;
  readonly reason?: SaveFailure;
  /** Documents dropped by budget enforcement as part of this save. */
  readonly evictedIds?: readonly string[];
}

function isQuotaError(error: unknown): boolean {
  // Firefox reports the legacy code 22 without the modern name; Chrome and
  // Safari report the name. Checking both keeps the retry path working on all
  // three rather than only where the modern spelling landed.
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
}

/**
 * Asks the browser to exempt this origin's storage from eviction under disk
 * pressure. Best-effort by definition: Chrome grants it based on engagement
 * heuristics and may simply say no. Called once, after the first successful
 * save, because asking before there is anything to protect is pointless.
 */
let persistenceRequested = false;
async function requestPersistenceOnce(): Promise<void> {
  if (persistenceRequested) return;
  persistenceRequested = true;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // A refused or unsupported persistence request changes nothing about
    // whether the save succeeded — it only affects eviction odds later.
  }
}

/** Writes the document + page rows in one transaction. Extracted so the quota retry can re-run it verbatim. */
async function writeDocument(meta: HistoryDocumentMeta, stored: readonly StoredPage[]): Promise<void> {
  await runTransaction([HISTORY.DOCUMENTS_STORE, HISTORY.PAGES_STORE], 'readwrite', (tx) => {
    const documents = tx.objectStore(HISTORY.DOCUMENTS_STORE);
    const pages = tx.objectStore(HISTORY.PAGES_STORE);
    // Clear the previous page range first: re-saving a document after deleting
    // pages from it would otherwise leave the removed tail behind, since `put`
    // only overwrites the keys it is given.
    pages.delete(pageRangeFor(meta.id));
    stored.forEach((row) => pages.put(row));
    documents.put(meta);
  });
}

/** Reads one document's existing metadata, or null. Used to preserve `createdAt` across re-saves. */
async function readMeta(id: string): Promise<HistoryDocumentMeta | null> {
  const existing = await runTransaction(HISTORY.DOCUMENTS_STORE, 'readonly', (tx) =>
    promisifyRequest<HistoryDocumentMeta | undefined>(tx.objectStore(HISTORY.DOCUMENTS_STORE).get(id)),
  );
  return existing ?? null;
}

/**
 * Persists a finished document. Idempotent on `id`: exporting the same document
 * twice updates one record rather than creating two (design section 5).
 *
 * Never throws. A history write that fails must not cost the user the document
 * they are still holding in memory — the caller shows a toast and carries on.
 */
export async function saveDocument(
  id: string,
  title: string,
  pages: readonly DocumentPage[],
  now: number = Date.now(),
): Promise<SaveResult> {
  if (!isHistoryAvailable() || pages.length === 0) {
    return { saved: false, reason: 'unavailable' };
  }

  try {
    // All async encoding happens HERE, before any transaction exists.
    const stored = await toStoredPages(id, pages);
    const cover = stored[0]?.thumbnail;
    if (!cover) {
      return { saved: false, reason: 'error' };
    }

    const previous = await readMeta(id);
    const meta: HistoryDocumentMeta = {
      id,
      title,
      createdAt: previous?.createdAt ?? now,
      lastOpenedAt: now,
      pageCount: stored.length,
      sizeBytes: computeSizeBytes(stored),
      cover,
      pinned: previous?.pinned ?? false,
    };

    try {
      await writeDocument(meta, stored);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      // Over quota: make room and try once more. A second failure means the
      // document genuinely does not fit, and retrying again would just stall
      // the UI on a write that cannot succeed.
      await enforceBudget();
      try {
        await writeDocument(meta, stored);
      } catch (retryError) {
        return { saved: false, reason: isQuotaError(retryError) ? 'quota' : 'error' };
      }
    }

    const { evictedIds } = await enforceBudget();
    void requestPersistenceOnce();
    return { saved: true, evictedIds };
  } catch {
    return { saved: false, reason: 'error' };
  }
}

/**
 * Every document's metadata, newest first. Reads the `documents` store only —
 * no page blob is touched, which is what keeps a long history cheap to list.
 */
export async function listDocuments(): Promise<HistoryDocumentMeta[]> {
  if (!isHistoryAvailable()) return [];
  try {
    const metas = await runTransaction(HISTORY.DOCUMENTS_STORE, 'readonly', (tx) =>
      promisifyRequest<HistoryDocumentMeta[]>(
        tx.objectStore(HISTORY.DOCUMENTS_STORE).index(HISTORY.INDEX_CREATED_AT).getAll(),
      ),
    );
    // The index yields ascending `createdAt`; the list wants newest first.
    return metas.reverse();
  } catch {
    return [];
  }
}

/**
 * Rehydrates a document's pages into live `DocumentPage`s and stamps
 * `lastOpenedAt` so the LRU reflects actual use. Resolves to an empty array if
 * the document is gone (e.g. evicted between listing and opening).
 */
export async function loadDocumentPages(docId: string): Promise<DocumentPage[]> {
  if (!isHistoryAvailable()) return [];
  try {
    const rows = await runTransaction(HISTORY.PAGES_STORE, 'readonly', (tx) =>
      promisifyRequest<StoredPage[]>(tx.objectStore(HISTORY.PAGES_STORE).getAll(pageRangeFor(docId))),
    );
    if (rows.length === 0) return [];

    // Decode outside the transaction — it committed the moment `getAll`
    // resolved, and `toDocumentPages` awaits image decoding.
    const pages = await toDocumentPages(rows);
    await touchDocument(docId);
    return pages;
  } catch {
    return [];
  }
}

/** Bumps `lastOpenedAt`, moving the document to the back of the eviction queue. */
export async function touchDocument(docId: string, now: number = Date.now()): Promise<void> {
  try {
    const existing = await readMeta(docId);
    if (!existing) return;
    await runTransaction(HISTORY.DOCUMENTS_STORE, 'readwrite', (tx) => {
      tx.objectStore(HISTORY.DOCUMENTS_STORE).put({ ...existing, lastOpenedAt: now });
    });
  } catch {
    // A failed touch only skews eviction ordering slightly. Never worth
    // failing an open the user asked for.
  }
}

/** Removes a document and its whole page range in one transaction. */
export async function deleteDocument(docId: string): Promise<boolean> {
  if (!isHistoryAvailable()) return false;
  try {
    await runTransaction([HISTORY.DOCUMENTS_STORE, HISTORY.PAGES_STORE], 'readwrite', (tx) => {
      tx.objectStore(HISTORY.DOCUMENTS_STORE).delete(docId);
      tx.objectStore(HISTORY.PAGES_STORE).delete(pageRangeFor(docId));
    });
    return true;
  } catch {
    return false;
  }
}

/** Marks a document exempt from (or subject to) budget eviction. */
export async function setPinned(docId: string, pinned: boolean): Promise<boolean> {
  try {
    const existing = await readMeta(docId);
    if (!existing) return false;
    await runTransaction(HISTORY.DOCUMENTS_STORE, 'readwrite', (tx) => {
      tx.objectStore(HISTORY.DOCUMENTS_STORE).put({ ...existing, pinned });
    });
    return true;
  } catch {
    return false;
  }
}

/** Consumption summary for the history screen. Metadata-only, like everything else here. */
export async function getUsage(): Promise<HistoryUsage> {
  const metas = await listDocuments();
  return {
    documentCount: metas.length,
    totalBytes: metas.reduce((sum, meta) => sum + meta.sizeBytes, 0),
    budgetBytes: HISTORY.BUDGET_BYTES,
  };
}

/** Test seam — clears the persistence-request latch between cases. */
export function resetPersistenceRequestForTests(): void {
  persistenceRequested = false;
}
