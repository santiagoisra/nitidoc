/**
 * Size-capped LRU eviction suite (history design section 7).
 *
 * Asserts the CONTRACT — ordering, the pinned exemption, and the refusal to
 * loop when only pinned documents are left — never the literal budget value,
 * which `historyConstants.ts` marks as a calibratable starting value.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/scanner/lib/pageResources', () => ({
  compressBitmapToJpeg: vi.fn(async (bitmap: { readonly encodedSize: number }) =>
    Promise.resolve(new Blob([new Uint8Array(bitmap.encodedSize)])),
  ),
  decodeBlobToBitmap: vi.fn(async () => Promise.resolve({ close: vi.fn() })),
}));

import { resetHistoryDbForTests } from '@/features/history/lib/historyDb';
import { enforceBudget } from '@/features/history/lib/historyEviction';
import {
  listDocuments,
  loadDocumentPages,
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

/** Exactly 1000 bytes of blob per page, so budgets can be expressed in whole documents. */
function fakePage(): DocumentPage {
  return {
    id: 'page-0',
    order: 0,
    recipe: createInitialRecipe(CORNERS, 'unknown'),
    thumbnail: { encodedSize: 0, close: vi.fn() } as unknown as ImageBitmap,
    originalBlob: new Blob([new Uint8Array(5000)]),
    warpedBlob: new Blob([new Uint8Array(1000)]),
    originalWidth: 200,
    originalHeight: 300,
    warpedWidth: 100,
    warpedHeight: 150,
  };
}

/** Saves a 1000-byte document whose `lastOpenedAt` is exactly `openedAt`. */
async function seed(id: string, openedAt: number): Promise<void> {
  await saveDocument(id, id, [fakePage()], openedAt);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetHistoryDbForTests();
});

describe('enforceBudget', () => {
  it('does nothing when the history already fits', async () => {
    await seed('a', 1_000);
    await seed('b', 2_000);

    const result = await enforceBudget(10_000);

    expect(result.evictedIds).toEqual([]);
    expect(result.freedBytes).toBe(0);
    expect(await listDocuments()).toHaveLength(2);
  });

  it('evicts least-recently-opened first, and only as many as it must', async () => {
    await seed('oldest', 1_000);
    await seed('middle', 2_000);
    await seed('newest', 3_000);

    // Budget for two documents: exactly one has to go, and it must be the one
    // opened longest ago — NOT the one created first, which is a different
    // ordering the moment a user reopens an old scan.
    const result = await enforceBudget(2_000);

    expect(result.evictedIds).toEqual(['oldest']);
    expect(result.freedBytes).toBe(1_000);
    const remaining = (await listDocuments()).map((meta) => meta.id).sort();
    expect(remaining).toEqual(['middle', 'newest']);
  });

  it('deletes the evicted documents pages too, not just their metadata', async () => {
    await seed('oldest', 1_000);
    await seed('newest', 2_000);

    await enforceBudget(1_000);

    // Orphaned page rows would keep consuming the very space eviction was
    // called to reclaim, while being invisible to every later size calculation.
    expect(await loadDocumentPages('oldest')).toEqual([]);
    expect(await loadDocumentPages('newest')).toHaveLength(1);
  });

  it('never evicts a pinned document, even when it is the least recently opened', async () => {
    await seed('pinned-old', 1_000);
    await seed('loose-mid', 2_000);
    await seed('loose-new', 3_000);
    await setPinned('pinned-old', true);

    const result = await enforceBudget(2_000);

    expect(result.evictedIds).toEqual(['loose-mid']);
    const remaining = (await listDocuments()).map((meta) => meta.id).sort();
    expect(remaining).toEqual(['loose-new', 'pinned-old']);
  });

  it('stops rather than looping when only pinned documents remain over budget', async () => {
    await seed('pinned-a', 1_000);
    await seed('pinned-b', 2_000);
    await setPinned('pinned-a', true);
    await setPinned('pinned-b', true);

    // Being over budget is the better outcome here: the user explicitly asked
    // to keep these, and silently discarding them would be worse than the
    // overage.
    const result = await enforceBudget(500);

    expect(result.evictedIds).toEqual([]);
    expect(await listDocuments()).toHaveLength(2);
  });

  it('counts pinned documents toward the total when deciding what to evict', async () => {
    await seed('pinned-big', 1_000);
    await seed('loose-a', 2_000);
    await seed('loose-b', 3_000);
    await setPinned('pinned-big', true);

    // Total is 3000 with a 1000 budget. The pinned document occupies the whole
    // budget on its own, so BOTH loose documents have to go.
    const result = await enforceBudget(1_000);

    expect(result.evictedIds).toEqual(['loose-a', 'loose-b']);
    expect((await listDocuments()).map((meta) => meta.id)).toEqual(['pinned-big']);
  });
});
