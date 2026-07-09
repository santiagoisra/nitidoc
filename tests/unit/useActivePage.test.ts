import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quad } from '@/shared/types/geometry';
import { createInitialRecipe } from '@/features/scanner/lib/editRecipe';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

/**
 * Group 2 / PR5 unit tests for `useActivePage` (design section 2.2). The
 * pure async helpers (`compressBitmapToJpeg`/`decodeBlobToBitmap`/
 * `makeThumbnail`) are mocked so this suite exercises ONLY the
 * orchestration/ownership contract (who closes what, when recompression
 * happens, the cap guard) — `pageResources.test.ts` already covers the real
 * canvas/OffscreenCanvas math.
 *
 * Build-order note: this hook lands BEFORE Group 1c
 * (`ScannerScreen`/`CornerEditor` rewrite), so it is exercised directly
 * against `scannerStore.ts`'s already-wired `DocumentSlice` fields (Group
 * 1b) — no UI consumer exists yet.
 */

const compressBitmapToJpegMock = vi.fn();
const decodeBlobToBitmapMock = vi.fn();
const makeThumbnailMock = vi.fn();

vi.mock('@/features/scanner/lib/pageResources', () => ({
  compressBitmapToJpeg: (...args: unknown[]) => compressBitmapToJpegMock(...args),
  decodeBlobToBitmap: (...args: unknown[]) => decodeBlobToBitmapMock(...args),
  makeThumbnail: (...args: unknown[]) => makeThumbnailMock(...args),
}));

import { useActivePage } from '@/features/scanner/hooks/useActivePage';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

function fakeBitmap(width = 100, height = 100): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function fakeBlob(): Blob {
  return new Blob(['fake'], { type: 'image/jpeg' });
}

const CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

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

beforeEach(() => {
  pageCounter = 0;
  useScannerStore.setState({ ...scannerStoreInitialState });
  compressBitmapToJpegMock.mockReset().mockResolvedValue(fakeBlob());
  decodeBlobToBitmapMock.mockReset().mockResolvedValue(fakeBitmap());
  makeThumbnailMock.mockReset().mockResolvedValue(fakeBitmap(150, 150));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useActivePage.materializeCapture (design section 2.2 "Materialize on capture")', () => {
  it('compresses+thumbnails, appends the page, and closes the live bitmaps', async () => {
    const { result } = renderHook(() => useActivePage());
    const originalBitmap = fakeBitmap(2000, 3000);
    const warpedBase = fakeBitmap(1600, 2400);
    const recipe = createInitialRecipe(CORNERS, 'a4');

    let outcome: { status: string } | undefined;
    await act(async () => {
      outcome = await result.current.materializeCapture({
        pageId: 'p1',
        recipe,
        originalBitmap,
        warpedBase,
        originalWidth: 2000,
        originalHeight: 3000,
        warpedWidth: 1600,
        warpedHeight: 2400,
      });
    });

    expect(outcome).toEqual({ status: 'added' });
    expect(useScannerStore.getState().pages).toHaveLength(1);
    expect(useScannerStore.getState().pages[0]?.id).toBe('p1');
    expect(useScannerStore.getState().pages[0]?.order).toBe(0);
    expect(makeThumbnailMock).toHaveBeenCalledWith(warpedBase, FILTER.THUMBNAIL_MAX_EDGE);
    expect(compressBitmapToJpegMock).toHaveBeenCalledWith(originalBitmap, FILTER.JPEG_QUALITY);
    expect(compressBitmapToJpegMock).toHaveBeenCalledWith(warpedBase, FILTER.JPEG_QUALITY);
    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(warpedBase.close).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().activeWorking).toBeNull();
  });

  it('cap-reached blocks capture: no page added, live bitmaps released, hint exposed via isAtCap/canAddPage', async () => {
    for (let i = 0; i < FILTER.PAGE_CAP; i += 1) {
      useScannerStore.getState().addPage(fakePage({ order: i }));
    }

    const { result } = renderHook(() => useActivePage());
    expect(result.current.isAtCap).toBe(true);
    expect(result.current.canAddPage).toBe(false);

    const originalBitmap = fakeBitmap();
    const warpedBase = fakeBitmap();

    let outcome: { status: string } | undefined;
    await act(async () => {
      outcome = await result.current.materializeCapture({
        pageId: 'overflow',
        recipe: createInitialRecipe(CORNERS, 'a4'),
        originalBitmap,
        warpedBase,
        originalWidth: 100,
        originalHeight: 100,
        warpedWidth: 100,
        warpedHeight: 100,
      });
    });

    expect(outcome).toEqual({ status: 'blocked-cap' });
    expect(useScannerStore.getState().pages).toHaveLength(FILTER.PAGE_CAP);
    expect(useScannerStore.getState().pages.some((p) => p.id === 'overflow')).toBe(false);
    // Live bitmaps must never leak even when the capture is blocked.
    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(warpedBase.close).toHaveBeenCalledTimes(1);
    // No compress/thumbnail work should be wasted on a blocked capture.
    expect(compressBitmapToJpegMock).not.toHaveBeenCalled();
    expect(makeThumbnailMock).not.toHaveBeenCalled();
  });
});

describe('useActivePage.activatePage (design section 2.2 "Activate")', () => {
  it('decodes both blobs, sets activeWorking/activePageId, clears activeDirty', async () => {
    const page = fakePage({ id: 'a' });
    useScannerStore.getState().addPage(page);

    const decodedOriginal = fakeBitmap(500, 700);
    const decodedWarped = fakeBitmap(400, 600);
    decodeBlobToBitmapMock
      .mockResolvedValueOnce(decodedOriginal)
      .mockResolvedValueOnce(decodedWarped);

    const { result } = renderHook(() => useActivePage());

    await act(async () => {
      await result.current.activatePage('a');
    });

    expect(decodeBlobToBitmapMock).toHaveBeenCalledWith(page.originalBlob);
    expect(decodeBlobToBitmapMock).toHaveBeenCalledWith(page.warpedBlob);
    expect(useScannerStore.getState().activePageId).toBe('a');
    expect(useScannerStore.getState().activeWorking).toEqual({
      pageId: 'a',
      originalBitmap: decodedOriginal,
      warpedBase: decodedWarped,
    });
    expect(useScannerStore.getState().activeDirty).toBe(false);
  });

  it('activating a different page closes the previously active working set first (deactivate-previous-first)', async () => {
    const pageA = fakePage({ id: 'a' });
    const pageB = fakePage({ id: 'b' });
    useScannerStore.getState().addPage(pageA);
    useScannerStore.getState().addPage(pageB);

    const { result } = renderHook(() => useActivePage());

    const firstOriginal = fakeBitmap(1, 1);
    const firstWarped = fakeBitmap(1, 1);
    decodeBlobToBitmapMock.mockResolvedValueOnce(firstOriginal).mockResolvedValueOnce(firstWarped);
    await act(async () => {
      await result.current.activatePage('a');
    });
    expect(useScannerStore.getState().activePageId).toBe('a');

    const secondOriginal = fakeBitmap(2, 2);
    const secondWarped = fakeBitmap(2, 2);
    decodeBlobToBitmapMock.mockResolvedValueOnce(secondOriginal).mockResolvedValueOnce(secondWarped);
    await act(async () => {
      await result.current.activatePage('b');
    });

    // Page A's decoded bitmaps must have been closed by the implicit
    // deactivate (design section 1.5 close-before-overwrite / 2.2 Activate step 1).
    expect(firstOriginal.close).toHaveBeenCalledTimes(1);
    expect(firstWarped.close).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().activePageId).toBe('b');
    expect(useScannerStore.getState().activeWorking).toEqual({
      pageId: 'b',
      originalBitmap: secondOriginal,
      warpedBase: secondWarped,
    });
    // Page A was NOT dirty, so no recompress should have happened on the implicit deactivate.
    expect(compressBitmapToJpegMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the requested page is already active', async () => {
    const page = fakePage({ id: 'a' });
    useScannerStore.getState().addPage(page);
    const { result } = renderHook(() => useActivePage());

    await act(async () => {
      await result.current.activatePage('a');
    });
    decodeBlobToBitmapMock.mockClear();

    await act(async () => {
      await result.current.activatePage('a');
    });

    expect(decodeBlobToBitmapMock).not.toHaveBeenCalled();
  });

  it('throws when the requested page id does not exist', async () => {
    const { result } = renderHook(() => useActivePage());
    await expect(
      act(async () => {
        await result.current.activatePage('missing');
      }),
    ).rejects.toThrow();
  });
});

describe('useActivePage.deactivateActivePage (design section 2.2 "Deactivate")', () => {
  it('recompresses (updatePageWarpBase) ONLY when activeDirty is true', async () => {
    const page = fakePage({ id: 'a' });
    useScannerStore.getState().addPage(page);
    const originalBitmap = fakeBitmap(10, 10);
    const warpedBase = fakeBitmap(20, 30);
    useScannerStore.getState().setActiveWorking({ pageId: 'a', originalBitmap, warpedBase });
    useScannerStore.getState().setActivePageId('a');
    useScannerStore.getState().setActiveDirty(true);

    const newThumbnail = fakeBitmap(15, 15);
    const newWarpedBlob = fakeBlob();
    makeThumbnailMock.mockResolvedValueOnce(newThumbnail);
    compressBitmapToJpegMock.mockResolvedValueOnce(newWarpedBlob);

    const { result } = renderHook(() => useActivePage());
    await act(async () => {
      await result.current.deactivateActivePage();
    });

    expect(makeThumbnailMock).toHaveBeenCalledWith(warpedBase, FILTER.THUMBNAIL_MAX_EDGE);
    expect(compressBitmapToJpegMock).toHaveBeenCalledWith(warpedBase, FILTER.JPEG_QUALITY);
    const updatedPage = useScannerStore.getState().pages.find((p) => p.id === 'a');
    expect(updatedPage?.thumbnail).toBe(newThumbnail);
    expect(updatedPage?.warpedBlob).toBe(newWarpedBlob);
    expect(updatedPage?.warpedWidth).toBe(20);
    expect(updatedPage?.warpedHeight).toBe(30);
    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(warpedBase.close).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().activeWorking).toBeNull();
    expect(useScannerStore.getState().activePageId).toBeNull();
    expect(useScannerStore.getState().activeDirty).toBe(false);
  });

  it('does NOT recompress when activeDirty is false — just closes bitmaps', async () => {
    const page = fakePage({ id: 'a' });
    useScannerStore.getState().addPage(page);
    const originalBitmap = fakeBitmap();
    const warpedBase = fakeBitmap();
    useScannerStore.getState().setActiveWorking({ pageId: 'a', originalBitmap, warpedBase });
    useScannerStore.getState().setActivePageId('a');
    useScannerStore.getState().setActiveDirty(false);

    const { result } = renderHook(() => useActivePage());
    await act(async () => {
      await result.current.deactivateActivePage();
    });

    expect(makeThumbnailMock).not.toHaveBeenCalled();
    expect(compressBitmapToJpegMock).not.toHaveBeenCalled();
    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(warpedBase.close).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().activeWorking).toBeNull();
    expect(useScannerStore.getState().activePageId).toBeNull();
  });

  it('is a no-op when nothing is active', async () => {
    const { result } = renderHook(() => useActivePage());
    await act(async () => {
      await result.current.deactivateActivePage();
    });
    expect(makeThumbnailMock).not.toHaveBeenCalled();
    expect(compressBitmapToJpegMock).not.toHaveBeenCalled();
  });
});

describe('useActivePage.rewarpActivePage (design section 2.2 "Re-warp (active)")', () => {
  it('swaps warpedBase (closing the old one), marks dirty, and writes the recipe — synchronously, no re-decode', () => {
    const page = fakePage({ id: 'a' });
    useScannerStore.getState().addPage(page);
    const originalBitmap = fakeBitmap();
    const staleWarpedBase = fakeBitmap();
    useScannerStore.getState().setActiveWorking({ pageId: 'a', originalBitmap, warpedBase: staleWarpedBase });
    useScannerStore.getState().setActivePageId('a');
    useScannerStore.getState().setActiveDirty(false);

    const { result } = renderHook(() => useActivePage());
    const freshWarpedBase = fakeBitmap();
    const newRecipe = { ...page.recipe, corners: CORNERS };

    act(() => {
      result.current.rewarpActivePage({ pageId: 'a', freshWarpedBase, recipe: newRecipe });
    });

    expect(staleWarpedBase.close).toHaveBeenCalledTimes(1);
    expect(originalBitmap.close).not.toHaveBeenCalled();
    expect(useScannerStore.getState().activeWorking).toEqual({
      pageId: 'a',
      originalBitmap,
      warpedBase: freshWarpedBase,
    });
    expect(useScannerStore.getState().activeDirty).toBe(true);
    expect(useScannerStore.getState().pages.find((p) => p.id === 'a')?.recipe).toBe(newRecipe);
    expect(decodeBlobToBitmapMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the given pageId does not match the active page', () => {
    const { result } = renderHook(() => useActivePage());
    const freshWarpedBase = fakeBitmap();

    act(() => {
      result.current.rewarpActivePage({
        pageId: 'not-active',
        freshWarpedBase,
        recipe: createInitialRecipe(CORNERS, 'a4'),
      });
    });

    expect(useScannerStore.getState().activeWorking).toBeNull();
    expect(freshWarpedBase.close).not.toHaveBeenCalled();
  });
});
