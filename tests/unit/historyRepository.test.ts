/**
 * Scan history repository suite (history design section 8).
 *
 * Runs against `fake-indexeddb`, so the schema, the composite key range and the
 * transaction boundaries are all EXERCISED FOR REAL rather than mocked — those
 * are precisely the parts of this feature that can be subtly wrong. Only the
 * canvas-bound blob conversions are stubbed, because happy-dom has no real 2D
 * rasterizer and encoding a JPEG is not what these tests are about.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/scanner/lib/pageResources', () => ({
  // The thumbnail an in-memory page carries is an `ImageBitmap`; storage wants
  // a Blob. The fake bitmaps below carry the byte size they should encode to,
  // which keeps `sizeBytes` assertions meaningful without a real encoder.
  compressBitmapToJpeg: vi.fn(async (bitmap: { readonly encodedSize: number }) =>
    Promise.resolve(new Blob([new Uint8Array(bitmap.encodedSize)])),
  ),
  decodeBlobToBitmap: vi.fn(async (blob: Blob) =>
    Promise.resolve({ width: 10, height: 10, decodedFrom: blob.size, close: vi.fn() }),
  ),
}));

import { HISTORY } from '@/features/history/lib/historyConstants';
import { resetHistoryDbForTests } from '@/features/history/lib/historyDb';
import {
  deleteDocument,
  getUsage,
  listDocuments,
  loadDocumentPages,
  resetPersistenceRequestForTests,
  saveDocument,
  setPinned,
} from '@/features/history/lib/historyRepository';
import { createInitialRecipe } from '@/features/scanner/lib/editRecipe';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { Quad } from '@/shared/types/geometry';

const CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

/** A page whose blob sizes are exact, so `sizeBytes` can be asserted arithmetically. */
function fakePage(order: number, warpedBytes = 1000, thumbBytes = 100): DocumentPage {
  return {
    id: `page-${order}`,
    order,
    recipe: createInitialRecipe(CORNERS),
    thumbnail: { encodedSize: thumbBytes, close: vi.fn() } as unknown as ImageBitmap,
    originalBlob: new Blob([new Uint8Array(5000)]),
    warpedBlob: new Blob([new Uint8Array(warpedBytes)]),
    originalWidth: 200,
    originalHeight: 300,
    warpedWidth: 100,
    warpedHeight: 150,
  };
}

beforeEach(() => {
  // A brand-new factory per test is the only reliable way to get a clean
  // database: `deleteDatabase` races with the cached connection this module
  // holds, and a leaked connection blocks the next open forever.
  globalThis.indexedDB = new IDBFactory();
  resetHistoryDbForTests();
  resetPersistenceRequestForTests();
});

describe('saveDocument', () => {
  it('persists a document and its pages, and lists it back', async () => {
    const result = await saveDocument('doc-1', 'Scan 1', [fakePage(0), fakePage(1)]);
    expect(result.saved).toBe(true);

    const listed = await listDocuments();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('doc-1');
    expect(listed[0]?.title).toBe('Scan 1');
    expect(listed[0]?.pageCount).toBe(2);
    // 2 pages x (1000-byte warp + 100-byte thumbnail). The cover is page 0's
    // thumbnail reused by reference, so it must NOT be counted a second time.
    expect(listed[0]?.sizeBytes).toBe(2200);
  });

  it('refuses to save an empty document', async () => {
    const result = await saveDocument('doc-empty', 'Nothing', []);
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(await listDocuments()).toHaveLength(0);
  });

  it('is idempotent on id — re-saving updates one record instead of forking', async () => {
    await saveDocument('doc-1', 'First title', [fakePage(0)]);
    await saveDocument('doc-1', 'Second title', [fakePage(0), fakePage(1)]);

    const listed = await listDocuments();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe('Second title');
    expect(listed[0]?.pageCount).toBe(2);
  });

  it('preserves createdAt across re-saves while advancing lastOpenedAt', async () => {
    await saveDocument('doc-1', 'Scan', [fakePage(0)], 1_000);
    await saveDocument('doc-1', 'Scan', [fakePage(0)], 9_000);

    const [meta] = await listDocuments();
    expect(meta?.createdAt).toBe(1_000);
    expect(meta?.lastOpenedAt).toBe(9_000);
  });

  it('drops pages removed since the previous save instead of leaving a stale tail', async () => {
    await saveDocument('doc-1', 'Scan', [fakePage(0), fakePage(1), fakePage(2)]);
    expect(await loadDocumentPages('doc-1')).toHaveLength(3);

    // Re-saving a shorter document must clear the old key range: `put` alone
    // would only overwrite orders 0-1 and leave order 2 orphaned.
    await saveDocument('doc-1', 'Scan', [fakePage(0), fakePage(1)]);
    expect(await loadDocumentPages('doc-1')).toHaveLength(2);
  });

  it('orders the list newest-first', async () => {
    await saveDocument('old', 'Old', [fakePage(0)], 1_000);
    await saveDocument('new', 'New', [fakePage(0)], 5_000);

    const listed = await listDocuments();
    expect(listed.map((meta) => meta.id)).toEqual(['new', 'old']);
  });
});

describe('loadDocumentPages', () => {
  it('round-trips recipes and dimensions', async () => {
    const page = fakePage(0);
    await saveDocument('doc-1', 'Scan', [page]);

    const [restored] = await loadDocumentPages('doc-1');
    expect(restored?.recipe).toEqual(page.recipe);
    expect(restored?.warpedWidth).toBe(100);
    expect(restored?.warpedHeight).toBe(150);
  });

  it('marks restored pages and substitutes the warp base for the missing original', async () => {
    await saveDocument('doc-1', 'Scan', [fakePage(0)]);

    const [restored] = await loadDocumentPages('doc-1');
    expect(restored?.restoredFromHistory).toBe(true);
    // The history does not persist `originalBlob`; a restored page's most
    // original available image IS the warp base (history design section 6).
    expect(restored?.originalBlob).toBe(restored?.warpedBlob);
    expect(restored?.originalWidth).toBe(restored?.warpedWidth);
    expect(restored?.originalHeight).toBe(restored?.warpedHeight);
  });

  it('re-indexes restored pages densely from 0', async () => {
    await saveDocument('doc-1', 'Scan', [fakePage(0), fakePage(1), fakePage(2)]);

    const restored = await loadDocumentPages('doc-1');
    expect(restored.map((page) => page.order)).toEqual([0, 1, 2]);
  });

  it('keeps documents isolated — the composite key range never bleeds across ids', async () => {
    await saveDocument('doc-a', 'A', [fakePage(0), fakePage(1)]);
    await saveDocument('doc-b', 'B', [fakePage(0)]);

    expect(await loadDocumentPages('doc-a')).toHaveLength(2);
    expect(await loadDocumentPages('doc-b')).toHaveLength(1);
  });

  it('resolves empty for a document that is gone', async () => {
    expect(await loadDocumentPages('never-existed')).toEqual([]);
  });
});

describe('deleteDocument', () => {
  it('removes the metadata record and the whole page range', async () => {
    await saveDocument('doc-a', 'A', [fakePage(0), fakePage(1)]);
    await saveDocument('doc-b', 'B', [fakePage(0)]);

    expect(await deleteDocument('doc-a')).toBe(true);

    expect(await listDocuments()).toHaveLength(1);
    expect(await loadDocumentPages('doc-a')).toEqual([]);
    // The neighbouring document must survive untouched.
    expect(await loadDocumentPages('doc-b')).toHaveLength(1);
  });
});

describe('setPinned and getUsage', () => {
  it('marks a document pinned', async () => {
    await saveDocument('doc-1', 'Scan', [fakePage(0)]);
    expect(await setPinned('doc-1', true)).toBe(true);

    const [meta] = await listDocuments();
    expect(meta?.pinned).toBe(true);
  });

  it('preserves the pinned flag across a re-save', async () => {
    await saveDocument('doc-1', 'Scan', [fakePage(0)]);
    await setPinned('doc-1', true);
    await saveDocument('doc-1', 'Scan again', [fakePage(0)]);

    const [meta] = await listDocuments();
    expect(meta?.pinned).toBe(true);
  });

  it('reports consumption against the budget', async () => {
    await saveDocument('doc-1', 'A', [fakePage(0)]);
    await saveDocument('doc-2', 'B', [fakePage(0)]);

    const usage = await getUsage();
    expect(usage.documentCount).toBe(2);
    expect(usage.totalBytes).toBe(2200);
    expect(usage.budgetBytes).toBe(HISTORY.BUDGET_BYTES);
  });
});
