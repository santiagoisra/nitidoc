/**
 * IndexedDB plumbing for the scan history (design section 4).
 *
 * THE ONE HAZARD THIS MODULE EXISTS TO CONTAIN: an IndexedDB transaction
 * auto-commits as soon as the microtask queue drains without a pending
 * request against it. `await`-ing anything that is not an IDB request from
 * inside a transaction therefore kills it silently — the next `store.put()`
 * throws `TransactionInactiveError`, and only sometimes, depending on timing.
 *
 * The defense is structural, not disciplinary: `runTransaction` below takes a
 * SYNCHRONOUS callback. It cannot be handed an `async` function that awaits a
 * blob conversion, because the type won't allow it. All async materialization
 * happens in `historyMapper.ts`, strictly before a transaction is opened.
 *
 * Raw IDB with no wrapper dependency — the surface is six operations, and the
 * project already prefers thin hand-written helpers (`pageResources.ts`,
 * `randomId.ts`). A promise wrapper would delete boilerplate but not this
 * hazard, which is the only part that actually bites.
 */

import { HISTORY } from '@/features/history/lib/historyConstants';

/** Resolves an `IDBRequest` to its result, rejecting with the request's own error. */
export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Resolves when the transaction COMMITS (not when the last request succeeds).
 * Callers must await this, not the individual requests, or they can observe a
 * "successful" write that a later abort rolled back.
 */
function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

/**
 * Additive, re-runnable schema creation. Written to upgrade from ANY older
 * version (including "no database at all") rather than assuming a step-by-step
 * migration chain, so a user who skipped versions still lands on a valid schema.
 */
function upgradeSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(HISTORY.DOCUMENTS_STORE)) {
    const documents = db.createObjectStore(HISTORY.DOCUMENTS_STORE, { keyPath: 'id' });
    documents.createIndex(HISTORY.INDEX_CREATED_AT, 'createdAt');
    documents.createIndex(HISTORY.INDEX_LAST_OPENED_AT, 'lastOpenedAt');
  }

  if (!db.objectStoreNames.contains(HISTORY.PAGES_STORE)) {
    // Composite keyPath: every page of a document forms one contiguous key
    // range, so reads and deletes scoped to a document need no secondary index
    // (design section 3).
    db.createObjectStore(HISTORY.PAGES_STORE, { keyPath: ['docId', 'order'] });
  }
}

/**
 * Cached open handle. `null` while closed; a pending promise while opening, so
 * concurrent callers share one `indexedDB.open` instead of racing.
 */
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * True when IndexedDB is reachable at all. Private-browsing modes and
 * storage-disabled configurations expose the global but throw on use, so the
 * history layer treats absence as a normal, non-fatal state — the scanner has
 * to stay fully usable without it (design section 8).
 */
export function isHistoryAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function openHistoryDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(HISTORY.DB_NAME, HISTORY.DB_VERSION);

    request.onupgradeneeded = () => upgradeSchema(request.result);

    request.onsuccess = () => {
      const db = request.result;
      // Another tab requested a version change and is blocked until this
      // connection closes. Closing (and dropping the cache) lets the upgrade
      // proceed; the next call to this function simply reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error ?? new Error('Could not open the history database'));
    // `onblocked` fires when an OLDER connection elsewhere holds the upgrade
    // back. There is nothing to do but surface it rather than hang forever.
    request.onblocked = () => reject(new Error('The history database is blocked by another tab'));
  }).catch((error: unknown) => {
    // Never cache a rejected promise — a transient failure (e.g. storage
    // momentarily unavailable) must not poison every later call.
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

/**
 * Runs `work` inside one transaction and resolves when it COMMITS.
 *
 * `work` is deliberately synchronous (see the module note): it may issue IDB
 * requests and read their results via `promisifyRequest` *after* this call
 * returns the commit promise, but it must never await unrelated async work
 * while the transaction is open.
 */
export async function runTransaction<T>(
  storeNames: string | readonly string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => T,
): Promise<Awaited<T>> {
  const db = await openHistoryDb();
  const tx = db.transaction(storeNames as string | string[], mode);
  // Subscribe to the outcome BEFORE issuing any request, so a transaction that
  // fails on its very first operation still rejects rather than hanging.
  const committed = promisifyTransaction(tx);
  const result = work(tx);
  await committed;
  // `work` may hand back promises over requests it issued synchronously; they
  // have all settled by the time the transaction commits.
  return (await result) as Awaited<T>;
}

/**
 * The key range covering every page of one document. Relies on IDB's type
 * ordering: arrays sort after every other key type, so `[docId, []]` is an
 * upper bound above `[docId, <any number>]` (design section 3).
 */
export function pageRangeFor(docId: string): IDBKeyRange {
  return IDBKeyRange.bound([docId], [docId, []]);
}

/** Test seam — drops the cached connection so a fresh `openHistoryDb` re-opens. */
export function resetHistoryDbForTests(): void {
  dbPromise = null;
}
