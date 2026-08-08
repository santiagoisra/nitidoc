/**
 * Boundary conversions between the in-memory page model and the persisted one
 * (design section 4 / section 6).
 *
 * This module is where ALL the async work of a save or a load happens —
 * encoding thumbnails, decoding them back — precisely so that no transaction
 * in `historyRepository.ts` ever has to await something that is not an IDB
 * request. The auto-commit hazard is designed out by module boundary, not by
 * remembering to be careful (see `historyDb.ts`'s module note).
 */

import { HISTORY } from '@/features/history/lib/historyConstants';
import { normalizeRecipe } from '@/features/scanner/lib/editRecipe';
import { compressBitmapToJpeg, decodeBlobToBitmap } from '@/features/scanner/lib/pageResources';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { StoredPage } from '@/shared/types/history';

/**
 * Encodes each page for storage. The `thumbnail` `ImageBitmap` becomes a JPEG
 * `Blob` (IndexedDB cannot store an `ImageBitmap` — see `shared/types/history.ts`);
 * `warpedBlob` is reused BY REFERENCE, never re-encoded, so saving costs one
 * small encode per page rather than a full re-compression of the document.
 *
 * Does NOT close any `thumbnail` — the pages remain live in the store and the
 * user is still looking at them. Ownership stays with `documentSlice`, matching
 * the same convention `pageResources.ts` documents.
 */
export async function toStoredPages(
  docId: string,
  pages: readonly DocumentPage[],
): Promise<StoredPage[]> {
  return Promise.all(
    pages.map(async (page): Promise<StoredPage> => {
      const thumbnail = await compressBitmapToJpeg(page.thumbnail, HISTORY.THUMBNAIL_QUALITY);
      return {
        docId,
        order: page.order,
        recipe: page.recipe,
        warpedBlob: page.warpedBlob,
        thumbnail,
        warpedWidth: page.warpedWidth,
        warpedHeight: page.warpedHeight,
        ...(page.needsReview === true ? { needsReview: true } : {}),
      };
    }),
  );
}

/**
 * Rebuilds live `DocumentPage`s from storage.
 *
 * The history deliberately does not keep `originalBlob` (design section 2), but
 * `DocumentPage` requires one and `useActivePage` decodes it to re-warp. Rather
 * than make the field optional — which would ripple a null check through every
 * consumer of a model that is currently total — a restored page sets
 * `originalBlob = warpedBlob` and its original dimensions to the warped ones.
 *
 * That is not a lie the code has to hide: for a restored page the warp base
 * genuinely IS the most original image available. `restoredFromHistory` marks
 * it so the UI can tell the user that re-cropping now cuts into the
 * already-straightened page instead of re-detecting the sheet.
 */
export async function toDocumentPages(stored: readonly StoredPage[]): Promise<DocumentPage[]> {
  const ordered = [...stored].sort((a, b) => a.order - b.order);

  return Promise.all(
    ordered.map(async (row, index): Promise<DocumentPage> => {
      const thumbnail = await decodeBlobToBitmap(row.thumbnail);
      return {
        // Page ids are not persisted: nothing outside a single session refers
        // to them, and minting fresh ones keeps them unique if the same
        // document is ever restored twice into one session.
        id: `${row.docId}:${row.order}`,
        // Re-index densely from the sorted array rather than trusting the
        // stored `order`, so a document saved from a partially-written state
        // can never produce gaps (the same invariant `reindex` enforces in
        // `documentSlice`).
        order: index,
        recipe: normalizeRecipe(row.recipe),
        thumbnail,
        originalBlob: row.warpedBlob,
        warpedBlob: row.warpedBlob,
        originalWidth: row.warpedWidth,
        originalHeight: row.warpedHeight,
        warpedWidth: row.warpedWidth,
        warpedHeight: row.warpedHeight,
        restoredFromHistory: true,
        ...(row.needsReview === true ? { needsReview: true } : {}),
      };
    }),
  );
}

/**
 * Total bytes a document occupies. Counts `thumbnail` and `warpedBlob` per
 * page; the cover is page 0's thumbnail reused by reference, so counting it
 * again would inflate every document by one thumbnail.
 */
export function computeSizeBytes(stored: readonly StoredPage[]): number {
  return stored.reduce((total, row) => total + row.warpedBlob.size + row.thumbnail.size, 0);
}
