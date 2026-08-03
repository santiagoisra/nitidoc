/**
 * Persisted shapes for the scan history (design section 3). These are the
 * ONLY types that cross the IndexedDB boundary, so everything here must be
 * structured-cloneable *for storage*: plain JSON values and `Blob`s.
 *
 * Notably absent: `ImageBitmap`. It is structured-serializable (it can cross a
 * `postMessage`) but IndexedDB uses serialize-*for-storage*, which rejects it.
 * Thumbnails are therefore persisted as JPEG `Blob`s and converted at the
 * boundary by `historyMapper.ts`.
 */

import type { EditRecipe } from '@/shared/types/scanner';

/**
 * A row of the `documents` store — pure metadata plus one small cover image.
 * Deliberately a few KB: the history list reads this store and NOTHING else,
 * so scrolling a long history never deserializes a full-page blob (design
 * section 3, "metadata is cheap and always resident").
 */
export interface HistoryDocumentMeta {
  /** Mirrors `DocumentSlice.documentId`, which makes the history write an idempotent `put`. */
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  /** Drives LRU eviction; stamped on save and on every open. */
  readonly lastOpenedAt: number;
  readonly pageCount: number;
  /** Sum of every blob stored for this document — the unit the budget is enforced in. */
  readonly sizeBytes: number;
  /** Page 0's thumbnail, reused by reference (never re-encoded). */
  readonly cover: Blob;
  /** Pinned documents are exempt from budget eviction. */
  readonly pinned: boolean;
}

/**
 * A row of the `pages` store. The keyPath is the composite `['docId', 'order']`,
 * which makes every page of a document a contiguous key range — reading or
 * deleting one document needs no secondary index.
 *
 * `originalBlob` is deliberately NOT here: the history keeps the warp base and
 * the recipe, not the raw capture (design section 2).
 */
export interface StoredPage {
  readonly docId: string;
  readonly order: number;
  readonly recipe: EditRecipe;
  /** The UNFILTERED warp base — the export baseline, exactly as in memory. */
  readonly warpedBlob: Blob;
  /** ~150px JPEG; decoded back to an `ImageBitmap` on load. */
  readonly thumbnail: Blob;
  readonly warpedWidth: number;
  readonly warpedHeight: number;
  readonly needsReview?: boolean;
}

/** Storage consumption summary surfaced by the history screen. */
export interface HistoryUsage {
  readonly documentCount: number;
  readonly totalBytes: number;
  readonly budgetBytes: number;
}
