/**
 * Calibratable constants for the scan history (design section 7). Mirrors the
 * `FILTER`/`DETECTION` convention: these are STARTING VALUES, not contractual
 * numbers, and tests must assert the surrounding behavior (eviction ordering,
 * pinned exemption) rather than the literals themselves.
 */
export const HISTORY = {
  /** IndexedDB database name. */
  DB_NAME: 'nitidoc-history',
  /**
   * Schema version. Bumping this runs `upgradeSchema` in `historyDb.ts`, which
   * is written to be additive and re-runnable from ANY older version.
   */
  DB_VERSION: 1,
  /** Metadata store — the only one the history list reads. */
  DOCUMENTS_STORE: 'documents',
  /** Page store, keyed by the composite `['docId', 'order']`. */
  PAGES_STORE: 'pages',
  /** Newest-first ordering for the list. */
  INDEX_CREATED_AT: 'by-createdAt',
  /** Ascending scan order for LRU eviction. */
  INDEX_LAST_OPENED_AT: 'by-lastOpenedAt',
  /**
   * Total blob budget for the whole history, in bytes. Above this, the oldest
   * non-pinned documents are evicted (design section 7). STARTING VALUE —
   * ~500MB sits well under Chrome's typical per-origin allowance while still
   * holding a meaningful number of documents.
   */
  BUDGET_BYTES: 500 * 1024 * 1024,
  /**
   * JPEG quality for thumbnails persisted to the history. Matches
   * `FILTER.JPEG_QUALITY` so a restored page's tile is visually identical to
   * the one it replaced. STARTING VALUE.
   */
  THUMBNAIL_QUALITY: 0.85,
} as const;
