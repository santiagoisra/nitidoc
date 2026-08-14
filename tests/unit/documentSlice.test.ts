import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import {
  createDocumentActions,
  initialDocumentSlice,
  type ActivePageResources,
  type DocumentActions,
  type DocumentPage,
  type DocumentSlice,
  type RawCapture,
} from '@/features/scanner/store/documentSlice';
import { createInitialRecipe } from '@/features/scanner/lib/editRecipe';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { Quad } from '@/shared/types/geometry';
import { paperSelection } from '@/features/scanner/lib/paperFormats';

/**
 * Isolated `DocumentSlice` store (Group 1b / PR2, design section 1.4-1.5),
 * built directly from `documentSlice.ts` — NOT the combined `ScannerStore`
 * (which excludes `phase`/`setPhase` for this transitional PR; see
 * `scannerStore.ts`'s `Omit<DocumentSlice, 'phase'>` comment). This keeps the
 * store's full contract (including `phase`/`setPhase`) testable now, ahead
 * of F1's legacy single-page capture slice's removal in Group 1c.
 */
type TestStore = DocumentSlice & DocumentActions;

function createTestStore() {
  return create<TestStore>((set, get) => ({
    ...initialDocumentSlice,
    ...createDocumentActions(set, get),
  }));
}

/**
 * `resetDocument` re-mints `documentId` on purpose (history design section 5),
 * so a whole-state equality check against the initial slice has to exclude it
 * and assert the identity separately.
 */
function omitDocumentId(slice: DocumentSlice): Omit<DocumentSlice, 'documentId'> {
  const { documentId: _ignored, ...rest } = slice;
  return rest;
}

const CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

function fakeBitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

function fakeBlob(): Blob {
  return new Blob(['fake'], { type: 'image/jpeg' });
}

let pageCounter = 0;

function fakePage(overrides: Partial<DocumentPage> = {}): DocumentPage {
  pageCounter += 1;
  return {
    id: overrides.id ?? `page-${pageCounter}`,
    order: overrides.order ?? 0,
    recipe: overrides.recipe ?? createInitialRecipe(CORNERS, 'a4'),
    thumbnail: overrides.thumbnail ?? fakeBitmap(),
    originalBlob: overrides.originalBlob ?? fakeBlob(),
    warpedBlob: overrides.warpedBlob ?? fakeBlob(),
    originalWidth: overrides.originalWidth ?? 1000,
    originalHeight: overrides.originalHeight ?? 1400,
    warpedWidth: overrides.warpedWidth ?? 800,
    warpedHeight: overrides.warpedHeight ?? 1200,
  };
}

function fakeActiveResources(pageId: string): ActivePageResources {
  return {
    pageId,
    originalBitmap: fakeBitmap(),
    warpedBase: fakeBitmap(),
  };
}

let rawCounter = 0;

function fakeRaw(overrides: Partial<RawCapture> = {}): RawCapture {
  rawCounter += 1;
  return {
    id: overrides.id ?? `raw-${rawCounter}`,
    order: overrides.order ?? 0,
    originalBlob: overrides.originalBlob ?? fakeBlob(),
    thumbnail: overrides.thumbnail ?? fakeBitmap(),
    originalWidth: overrides.originalWidth ?? 1000,
    originalHeight: overrides.originalHeight ?? 1400,
    paper: overrides.paper ?? paperSelection('a4', 'manual'),
  };
}

describe('documentSlice.addPage — 30-page cap (design section 2.3 / D-MEM)', () => {
  it('appends pages under the cap', () => {
    const useStore = createTestStore();
    const page = fakePage({ order: 0 });
    useStore.getState().addPage(page);
    expect(useStore.getState().pages).toEqual([page]);
  });

  it('no-ops when pages.length is already at the cap (defensive guard)', () => {
    const useStore = createTestStore();
    for (let i = 0; i < FILTER.PAGE_CAP; i += 1) {
      useStore.getState().addPage(fakePage({ order: i }));
    }
    expect(useStore.getState().pages).toHaveLength(FILTER.PAGE_CAP);

    const overflow = fakePage({ order: FILTER.PAGE_CAP });
    useStore.getState().addPage(overflow);

    expect(useStore.getState().pages).toHaveLength(FILTER.PAGE_CAP);
    expect(useStore.getState().pages).not.toContain(overflow);
  });
});

describe('documentSlice.addRawCapture — COMBINED cap (Fase 2.3, capture-ux-redesign.md)', () => {
  it('appends raw captures under the combined cap', () => {
    const useStore = createTestStore();
    const raw = fakeRaw({ order: 0 });
    useStore.getState().addRawCapture(raw);
    expect(useStore.getState().rawCaptures).toEqual([raw]);
  });

  it('retains the manual paper selection snapshot on a queued raw capture', () => {
    const useStore = createTestStore();
    const paper = paperSelection('letter', 'manual');
    const raw = fakeRaw({ order: 0, paper });

    useStore.getState().addRawCapture(raw);

    expect(useStore.getState().rawCaptures[0]?.paper).toBe(paper);
  });

  it('no-ops when pages.length + rawCaptures.length is already at the combined cap', () => {
    const useStore = createTestStore();
    // 20 pages + 10 raw captures = FILTER.PAGE_CAP (30).
    for (let i = 0; i < 20; i += 1) {
      useStore.getState().addPage(fakePage({ order: i }));
    }
    for (let i = 0; i < 10; i += 1) {
      useStore.getState().addRawCapture(fakeRaw({ order: i }));
    }
    expect(useStore.getState().pages).toHaveLength(20);
    expect(useStore.getState().rawCaptures).toHaveLength(10);

    const overflow = fakeRaw({ order: 10 });
    useStore.getState().addRawCapture(overflow);

    expect(useStore.getState().rawCaptures).toHaveLength(10);
    expect(useStore.getState().rawCaptures).not.toContain(overflow);
  });
});

describe('documentSlice raw capture hygiene — clearRawCaptures / removeLastRawCapture / removeRawCapture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clearRawCaptures closes every remaining thumbnail and empties rawCaptures', () => {
    const useStore = createTestStore();
    const rawA = fakeRaw({ id: 'a', order: 0 });
    const rawB = fakeRaw({ id: 'b', order: 1 });
    useStore.getState().addRawCapture(rawA);
    useStore.getState().addRawCapture(rawB);

    useStore.getState().clearRawCaptures();

    expect(rawA.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(rawB.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(useStore.getState().rawCaptures).toEqual([]);
  });

  it('clearRawCaptures on an already-empty list does not throw', () => {
    const useStore = createTestStore();
    expect(() => useStore.getState().clearRawCaptures()).not.toThrow();
    expect(useStore.getState().rawCaptures).toEqual([]);
  });

  it('removeLastRawCapture closes only the LAST thumbnail and pops it (retake-last)', () => {
    const useStore = createTestStore();
    const rawA = fakeRaw({ id: 'a', order: 0 });
    const rawB = fakeRaw({ id: 'b', order: 1 });
    useStore.getState().addRawCapture(rawA);
    useStore.getState().addRawCapture(rawB);

    useStore.getState().removeLastRawCapture();

    expect(rawB.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(rawA.thumbnail.close).not.toHaveBeenCalled();
    expect(useStore.getState().rawCaptures.map((r) => r.id)).toEqual(['a']);
  });

  it('removeLastRawCapture on an already-empty list is a no-op (does not throw)', () => {
    const useStore = createTestStore();
    expect(() => useStore.getState().removeLastRawCapture()).not.toThrow();
    expect(useStore.getState().rawCaptures).toEqual([]);
  });

  it('removeRawCapture(id) closes and removes a specific raw capture, re-indexing the rest densely', () => {
    const useStore = createTestStore();
    const rawA = fakeRaw({ id: 'a', order: 0 });
    const rawB = fakeRaw({ id: 'b', order: 1 });
    const rawC = fakeRaw({ id: 'c', order: 2 });
    useStore.getState().addRawCapture(rawA);
    useStore.getState().addRawCapture(rawB);
    useStore.getState().addRawCapture(rawC);

    useStore.getState().removeRawCapture('b');

    expect(rawB.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(rawA.thumbnail.close).not.toHaveBeenCalled();
    expect(rawC.thumbnail.close).not.toHaveBeenCalled();
    const remaining = useStore.getState().rawCaptures;
    expect(remaining.map((r) => r.id)).toEqual(['a', 'c']);
    expect(remaining.map((r) => r.order)).toEqual([0, 1]);
  });

  it('removeRawCapture with an unknown id is a no-op', () => {
    const useStore = createTestStore();
    const raw = fakeRaw({ id: 'a', order: 0 });
    useStore.getState().addRawCapture(raw);

    expect(() => useStore.getState().removeRawCapture('missing')).not.toThrow();
    expect(raw.thumbnail.close).not.toHaveBeenCalled();
    expect(useStore.getState().rawCaptures).toEqual([raw]);
  });
});

describe('documentSlice.setActiveWorking — close-before-overwrite (design section 1.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the previous originalBitmap and warpedBase before overwriting', () => {
    const useStore = createTestStore();
    const first = fakeActiveResources('page-1');
    const second = fakeActiveResources('page-1');

    useStore.getState().setActiveWorking(first);
    expect(useStore.getState().activeWorking).toBe(first);
    expect(first.originalBitmap.close).not.toHaveBeenCalled();
    expect(first.warpedBase.close).not.toHaveBeenCalled();

    useStore.getState().setActiveWorking(second);

    expect(first.originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(first.warpedBase.close).toHaveBeenCalledTimes(1);
    expect(second.originalBitmap.close).not.toHaveBeenCalled();
    expect(second.warpedBase.close).not.toHaveBeenCalled();
    expect(useStore.getState().activeWorking).toBe(second);
  });

  it('closes both bitmaps when deactivating (setActiveWorking(null))', () => {
    const useStore = createTestStore();
    const active = fakeActiveResources('page-1');
    useStore.getState().setActiveWorking(active);

    useStore.getState().setActiveWorking(null);

    expect(active.originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(active.warpedBase.close).toHaveBeenCalledTimes(1);
    expect(useStore.getState().activeWorking).toBeNull();
  });

  it('does not close when nothing was previously active', () => {
    const useStore = createTestStore();
    const active = fakeActiveResources('page-1');
    expect(() => useStore.getState().setActiveWorking(active)).not.toThrow();
    expect(useStore.getState().activeWorking).toBe(active);
  });
});

describe('documentSlice delete/undo/expiry (design section 1.5 / spec "Borrado de pagina con undo por toast")', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delete -> pendingDeletion -> undo (restorePage) restores the page at its original order', () => {
    const useStore = createTestStore();
    const pageA = fakePage({ id: 'a', order: 0 });
    const pageB = fakePage({ id: 'b', order: 1 });
    const pageC = fakePage({ id: 'c', order: 2 });
    useStore.getState().addPage(pageA);
    useStore.getState().addPage(pageB);
    useStore.getState().addPage(pageC);

    useStore.getState().deletePage('b');

    expect(useStore.getState().pages.map((p) => p.id)).toEqual(['a', 'c']);
    expect(useStore.getState().pages.map((p) => p.order)).toEqual([0, 1]);
    expect(useStore.getState().pendingDeletion?.id).toBe('b');
    // Resources retained during the undo window — thumbnail never closed.
    expect(pageB.thumbnail.close).not.toHaveBeenCalled();

    useStore.getState().restorePage();

    expect(useStore.getState().pendingDeletion).toBeNull();
    expect(useStore.getState().pages.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(useStore.getState().pages.map((p) => p.order)).toEqual([0, 1, 2]);
    expect(pageB.thumbnail.close).not.toHaveBeenCalled();
  });

  it('delete -> expiry (hardReleaseDeletion) releases resources and the page never reappears', () => {
    const useStore = createTestStore();
    const page = fakePage({ id: 'a', order: 0 });
    useStore.getState().addPage(page);

    useStore.getState().deletePage('a');
    useStore.getState().hardReleaseDeletion();

    expect(page.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingDeletion).toBeNull();
    expect(useStore.getState().pages).toEqual([]);
  });

  it('a second deletePage while one is pending hard-releases (supersedes) the older pending page', () => {
    const useStore = createTestStore();
    const pageA = fakePage({ id: 'a', order: 0 });
    const pageB = fakePage({ id: 'b', order: 1 });
    useStore.getState().addPage(pageA);
    useStore.getState().addPage(pageB);

    useStore.getState().deletePage('a');
    expect(useStore.getState().pendingDeletion?.id).toBe('a');
    expect(pageA.thumbnail.close).not.toHaveBeenCalled();

    useStore.getState().deletePage('b');

    // The older pending page ('a') is hard-released — its thumbnail closed —
    // since only one pendingDeletion slot exists.
    expect(pageA.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingDeletion?.id).toBe('b');
    expect(pageB.thumbnail.close).not.toHaveBeenCalled();
    expect(useStore.getState().pages).toEqual([]);
  });

  it('deleting the active page closes activeWorking and clears activePageId/activeDirty', () => {
    const useStore = createTestStore();
    const page = fakePage({ id: 'a', order: 0 });
    useStore.getState().addPage(page);
    const active = fakeActiveResources('a');
    useStore.getState().setActiveWorking(active);
    useStore.getState().setActivePageId('a');
    useStore.getState().setActiveDirty(true);

    useStore.getState().deletePage('a');

    expect(active.originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(active.warpedBase.close).toHaveBeenCalledTimes(1);
    expect(useStore.getState().activeWorking).toBeNull();
    expect(useStore.getState().activePageId).toBeNull();
    expect(useStore.getState().activeDirty).toBe(false);
  });
});

describe('documentSlice.reorderPages — dense re-index, no gaps/dupes (spec "Reorder por drag-and-drop")', () => {
  it('re-indexes order 0..n-1 densely from the full ordered id list', () => {
    const useStore = createTestStore();
    const pages = [
      fakePage({ id: 'p0', order: 0 }),
      fakePage({ id: 'p1', order: 1 }),
      fakePage({ id: 'p2', order: 2 }),
      fakePage({ id: 'p3', order: 3 }),
      fakePage({ id: 'p4', order: 4 }),
    ];
    pages.forEach((p) => useStore.getState().addPage(p));

    // Drag the last page (order 4) to the front.
    useStore.getState().reorderPages(['p4', 'p0', 'p1', 'p2', 'p3']);

    const result = useStore.getState().pages;
    expect(result.map((p) => p.id)).toEqual(['p4', 'p0', 'p1', 'p2', 'p3']);
    expect(result.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);

    // No gaps or duplicates.
    const orders = result.map((p) => p.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(Math.max(...orders)).toBe(orders.length - 1);
    expect(Math.min(...orders)).toBe(0);
  });

  it('drops ids absent from the pages array (defensive) without leaving gaps', () => {
    const useStore = createTestStore();
    useStore.getState().addPage(fakePage({ id: 'p0', order: 0 }));
    useStore.getState().addPage(fakePage({ id: 'p1', order: 1 }));

    useStore.getState().reorderPages(['p1', 'unknown-id', 'p0']);

    const result = useStore.getState().pages;
    expect(result.map((p) => p.id)).toEqual(['p1', 'p0']);
    expect(result.map((p) => p.order)).toEqual([0, 1]);
  });
});

describe('documentSlice.updateRecipe / updatePageWarpBase / applyFilterToAll', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updateRecipe replaces only the target page recipe', () => {
    const useStore = createTestStore();
    const pageA = fakePage({ id: 'a' });
    const pageB = fakePage({ id: 'b' });
    useStore.getState().addPage(pageA);
    useStore.getState().addPage(pageB);

    const newRecipe = createInitialRecipe(CORNERS, 'letter');
    useStore.getState().updateRecipe('a', newRecipe);

    expect(useStore.getState().pages.find((p) => p.id === 'a')?.recipe).toBe(newRecipe);
    expect(useStore.getState().pages.find((p) => p.id === 'b')?.recipe).toBe(pageB.recipe);
  });

  it('updatePaperSelection only changes the targeted persisted recipe selection', () => {
    const useStore = createTestStore();
    useStore.getState().addPage(fakePage({ id: 'a' }));
    useStore.getState().addPage(fakePage({ id: 'b' }));

    useStore.getState().updatePaperSelection('a', paperSelection('oficio', 'manual'));

    expect(useStore.getState().pages.find((page) => page.id === 'a')?.recipe.paper).toMatchObject({
      id: 'legal',
      alias: 'oficio',
      source: 'manual',
    });
    expect(useStore.getState().pages.find((page) => page.id === 'b')?.recipe.paper.alias).toBe('a4');
  });

  it('updatePageWarpBase closes the previous thumbnail before assigning the new one', () => {
    const useStore = createTestStore();
    const page = fakePage({ id: 'a' });
    useStore.getState().addPage(page);

    const newThumbnail = fakeBitmap();
    useStore.getState().updatePageWarpBase('a', {
      warpedBlob: fakeBlob(),
      thumbnail: newThumbnail,
      warpedWidth: 900,
      warpedHeight: 1300,
    });

    expect(page.thumbnail.close).toHaveBeenCalledTimes(1);
    const updated = useStore.getState().pages.find((p) => p.id === 'a');
    expect(updated?.thumbnail).toBe(newThumbnail);
    expect(updated?.warpedWidth).toBe(900);
    expect(updated?.warpedHeight).toBe(1300);
  });

  it('applyFilterToAll rewrites every page recipe filter, instantly, no bitmap work', () => {
    const useStore = createTestStore();
    useStore.getState().addPage(fakePage({ id: 'a' }));
    useStore.getState().addPage(fakePage({ id: 'b' }));

    const filter = { preset: 'grayscale' as const, brightness: 10, contrast: -5, sharpness: 0 };
    useStore.getState().applyFilterToAll(filter);

    for (const page of useStore.getState().pages) {
      expect(page.recipe.filter).toEqual(filter);
    }
  });
});

describe('documentSlice.setPhase / setSelectedPageIds', () => {
  it('setPhase writes the DocumentPhase value directly', () => {
    const useStore = createTestStore();
    useStore.getState().setPhase('processing');
    expect(useStore.getState().phase).toBe('processing');
    useStore.getState().setPhase('grid');
    expect(useStore.getState().phase).toBe('grid');
  });

  it('setSelectedPageIds replaces the selection', () => {
    const useStore = createTestStore();
    useStore.getState().setSelectedPageIds(['a', 'b']);
    expect(useStore.getState().selectedPageIds).toEqual(['a', 'b']);
  });
});

describe('documentSlice.resetDocument — full teardown (design section 1.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes activeWorking, every page thumbnail, every raw capture thumbnail, and pendingDeletion thumbnail, then resets to initial', () => {
    const useStore = createTestStore();
    const pageA = fakePage({ id: 'a', order: 0 });
    const pageB = fakePage({ id: 'b', order: 1 });
    const pageC = fakePage({ id: 'c', order: 2 });
    useStore.getState().addPage(pageA);
    useStore.getState().addPage(pageB);
    useStore.getState().addPage(pageC);

    const rawA = fakeRaw({ id: 'raw-a', order: 0 });
    const rawB = fakeRaw({ id: 'raw-b', order: 1 });
    useStore.getState().addRawCapture(rawA);
    useStore.getState().addRawCapture(rawB);

    const active = fakeActiveResources('b');
    useStore.getState().setActiveWorking(active);
    useStore.getState().setActivePageId('b');

    useStore.getState().deletePage('c');
    expect(useStore.getState().pendingDeletion?.id).toBe('c');

    const previousDocumentId = useStore.getState().documentId;
    useStore.getState().resetDocument();

    expect(active.originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(active.warpedBase.close).toHaveBeenCalledTimes(1);
    expect(pageA.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(pageB.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(pageC.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(rawA.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(rawB.thumbnail.close).toHaveBeenCalledTimes(1);
    // Everything resets to the initial shape EXCEPT `documentId`, which is
    // deliberately re-minted so the next document writes its own scan-history
    // record instead of overwriting the one just finished (history design
    // section 5).
    const { documentId, ...rest } = useStore.getState();
    expect(rest).toMatchObject(omitDocumentId(initialDocumentSlice));
    expect(documentId).not.toBe(previousDocumentId);
    expect(documentId).not.toBe('');
  });

  it('does not throw when resetting an already-empty document', () => {
    const useStore = createTestStore();
    expect(() => useStore.getState().resetDocument()).not.toThrow();
    const { documentId, ...rest } = useStore.getState();
    expect(rest).toMatchObject(omitDocumentId(initialDocumentSlice));
    expect(documentId).not.toBe('');
  });
});

describe('documentSlice initial state', () => {
  beforeEach(() => {
    pageCounter = 0;
  });

  it('starts empty/idle', () => {
    const useStore = createTestStore();
    expect(useStore.getState().pages).toEqual([]);
    expect(useStore.getState().rawCaptures).toEqual([]);
    expect(useStore.getState().activePageId).toBeNull();
    expect(useStore.getState().activeWorking).toBeNull();
    expect(useStore.getState().activeDirty).toBe(false);
    expect(useStore.getState().selectedPageIds).toEqual([]);
    expect(useStore.getState().pendingDeletion).toBeNull();
    expect(useStore.getState().phase).toBe('welcome');
  });
});
