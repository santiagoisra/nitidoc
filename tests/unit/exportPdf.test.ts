import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { EditRecipe } from '@/shared/types/scanner';
import { NEUTRAL_FILTER } from '@/shared/types/scanner';
import type { AspectRatioName, Point, Quad } from '@/shared/types/geometry';
import type { ApplyFilterResponse } from '@/features/scanner/worker/messages';

/**
 * Fase 2.1 punch-list item 4 unit tests for `exportPagesToPdf` (full-res
 * export, filter baked via the SAME routing the on-screen editor uses,
 * rotation/flip applied as real pixel transforms, one jsPDF page per
 * document page). Mirrors the existing mocking style for `pageResources`/
 * `workerClient` (see `filterPanel.test.tsx`) and adds a `jspdf` mock via
 * `vi.hoisted` (new dependency for this test file — the established
 * "*Mock" naming hoisting trick doesn't apply to a class constructor).
 *
 * Does NOT assert real PDF bytes (hard constraint) — only the process
 * routing/ordering/hygiene contract: page order, worker-vs-CSS routing,
 * one `addPage` between pages (never before the first), and that every
 * decoded/worker-returned bitmap gets `close()`d.
 */

const { jsPdfConstructorMock, addPageMock, addImageMock, saveMock } = vi.hoisted(() => ({
  jsPdfConstructorMock: vi.fn(),
  addPageMock: vi.fn(),
  addImageMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock('jspdf', () => {
  class FakeJsPdf {
    constructor(options: unknown) {
      jsPdfConstructorMock(options);
    }
    addPage(...args: unknown[]): FakeJsPdf {
      addPageMock(...args);
      return this;
    }
    addImage(...args: unknown[]): FakeJsPdf {
      addImageMock(...args);
      return this;
    }
    save(...args: unknown[]): FakeJsPdf {
      saveMock(...args);
      return this;
    }
  }
  return { jsPDF: FakeJsPdf };
});

const decodeBlobToBitmapMock = vi.fn();
vi.mock('@/features/scanner/lib/pageResources', () => ({
  decodeBlobToBitmap: (...args: unknown[]) => decodeBlobToBitmapMock(...args),
}));

const applyFilterMock = vi.fn();
vi.mock('@/features/scanner/lib/workerClient', () => ({
  getSharedWorkerClient: () => ({
    applyFilter: (...args: unknown[]) => applyFilterMock(...args),
  }),
}));

import { exportPagesToPdf } from '@/features/scanner/lib/exportPdf';

function makeBitmap(width: number, height: number): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function makeQuad(): Quad {
  const p = (x: number, y: number): Point => ({ x, y });
  return [p(0, 0), p(1, 0), p(1, 1), p(0, 1)];
}

function makeRecipe(overrides: Partial<EditRecipe> = {}): EditRecipe {
  return {
    corners: makeQuad(),
    aspectRatio: 'a4' as AspectRatioName,
    rotation: 0,
    flipH: false,
    flipV: false,
    filter: NEUTRAL_FILTER,
    ...overrides,
  };
}

function makePage(id: string, order: number, recipe: EditRecipe = makeRecipe()): DocumentPage {
  return {
    id,
    order,
    recipe,
    thumbnail: makeBitmap(150, 200),
    originalBlob: { id } as unknown as Blob,
    warpedBlob: { id } as unknown as Blob,
    originalWidth: 1000,
    originalHeight: 1400,
    warpedWidth: 1000,
    warpedHeight: 1400,
  };
}

function fakeApplyFilterResponse(bitmap: ImageBitmap): ApplyFilterResponse {
  return {
    id: 1,
    type: 'APPLY_FILTER_RESULT',
    results: [{ kind: 'bitmap', bitmap }],
  };
}

function installCanvasShims(): void {
  const fakeCtx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    filter: 'none',
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function toDataURL(
    this: HTMLCanvasElement,
  ) {
    return `data:image/jpeg;base64,fake-${this.width}x${this.height}`;
  });
  vi.stubGlobal(
    'ImageData',
    class {
      width: number;
      height: number;
      data: Uint8ClampedArray;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
}

describe('exportPagesToPdf (Fase 2.1 punch-list item 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installCanvasShims();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a no-op when there are no pages (no jsPDF instance created, no save)', async () => {
    await exportPagesToPdf([]);

    expect(decodeBlobToBitmapMock).not.toHaveBeenCalled();
    expect(jsPdfConstructorMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('processes pages in `order`, not array position, and closes every decoded bitmap', async () => {
    const bitmapA = makeBitmap(100, 140);
    const bitmapB = makeBitmap(200, 280);
    const bitmapC = makeBitmap(300, 420);
    decodeBlobToBitmapMock.mockResolvedValueOnce(bitmapA);
    decodeBlobToBitmapMock.mockResolvedValueOnce(bitmapB);
    decodeBlobToBitmapMock.mockResolvedValueOnce(bitmapC);

    // Deliberately out of order: array position 0/1/2 holds order 2/0/1.
    const pageOrder2 = makePage('p-order-2', 2);
    const pageOrder0 = makePage('p-order-0', 0);
    const pageOrder1 = makePage('p-order-1', 1);

    await exportPagesToPdf([pageOrder2, pageOrder0, pageOrder1]);

    // decodeBlobToBitmap must be called in ORDER: page order 0, then 1, then 2
    // — i.e. warpedBlob of pageOrder0 first, pageOrder1 second, pageOrder2 third.
    expect(decodeBlobToBitmapMock).toHaveBeenNthCalledWith(1, pageOrder0.warpedBlob);
    expect(decodeBlobToBitmapMock).toHaveBeenNthCalledWith(2, pageOrder1.warpedBlob);
    expect(decodeBlobToBitmapMock).toHaveBeenNthCalledWith(3, pageOrder2.warpedBlob);

    // F1 hygiene: every decoded bitmap must be closed (CSS route, `original` preset).
    expect(bitmapA.close).toHaveBeenCalledTimes(1);
    expect(bitmapB.close).toHaveBeenCalledTimes(1);
    expect(bitmapC.close).toHaveBeenCalledTimes(1);

    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('routes worker-rendered-preset pages (e.g. enhanced) through workerClient.applyFilter, while `original` is drawn raw', async () => {
    const originalBitmap = makeBitmap(100, 140);
    const enhancedBitmap = makeBitmap(100, 140);
    const filteredBitmap = makeBitmap(100, 140);
    decodeBlobToBitmapMock.mockResolvedValueOnce(originalBitmap);
    decodeBlobToBitmapMock.mockResolvedValueOnce(enhancedBitmap);
    applyFilterMock.mockResolvedValueOnce(fakeApplyFilterResponse(filteredBitmap));

    const originalPage = makePage('p-original', 0, makeRecipe({ filter: { ...NEUTRAL_FILTER, preset: 'original' } }));
    const enhancedPage = makePage('p-enhanced', 1, makeRecipe({ filter: { ...NEUTRAL_FILTER, preset: 'enhanced' } }));

    await exportPagesToPdf([originalPage, enhancedPage]);

    // iOS/WebKit fix: `enhanced` now bakes its realce in the worker (the CSS
    // ctx.filter path was a silent no-op on WebKit). `original` stays raw.
    expect(applyFilterMock).toHaveBeenCalledTimes(1);
    const [, variants] = applyFilterMock.mock.calls[0] as [unknown, readonly { preset: string }[]];
    expect(variants).toEqual([{ preset: 'enhanced', brightness: 0, contrast: 0, sharpness: 0 }]);

    // The raw-route bitmap is drawn directly and closed; the worker-route
    // bitmap is closed once its pixels are extracted for the RPC, and the
    // worker's returned bitmap is closed after being drawn.
    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(enhancedBitmap.close).toHaveBeenCalledTimes(1);
    expect(filteredBitmap.close).toHaveBeenCalledTimes(1);
  });

  it('adds one jsPDF page per document page — the FIRST page via the constructor, subsequent pages via addPage (never addPage before the first)', async () => {
    decodeBlobToBitmapMock.mockResolvedValueOnce(makeBitmap(100, 140));
    decodeBlobToBitmapMock.mockResolvedValueOnce(makeBitmap(200, 100));
    decodeBlobToBitmapMock.mockResolvedValueOnce(makeBitmap(300, 300));

    const pages = [makePage('p1', 0), makePage('p2', 1), makePage('p3', 2)];

    await exportPagesToPdf(pages);

    expect(jsPdfConstructorMock).toHaveBeenCalledTimes(1);
    // 3 pages total: 1 via the constructor + 2 via addPage.
    expect(addPageMock).toHaveBeenCalledTimes(2);
    expect(addImageMock).toHaveBeenCalledTimes(3);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[0]).toMatch(/^nitidoc-\d+\.pdf$/);
  });

  it('sizes each PDF page to that page image aspect ratio, portrait/landscape auto-detected from the (possibly rotated) dimensions', async () => {
    // Portrait source, no rotation -> stays portrait.
    decodeBlobToBitmapMock.mockResolvedValueOnce(makeBitmap(100, 200));
    // Portrait source, rotated 90 -> becomes landscape (200x100).
    decodeBlobToBitmapMock.mockResolvedValueOnce(makeBitmap(100, 200));

    const portraitPage = makePage('portrait', 0, makeRecipe({ rotation: 0 }));
    const rotatedPage = makePage('rotated', 1, makeRecipe({ rotation: 90 }));

    await exportPagesToPdf([portraitPage, rotatedPage]);

    const constructorOptions = jsPdfConstructorMock.mock.calls[0]?.[0] as {
      orientation: string;
      format: readonly [number, number];
    };
    expect(constructorOptions.orientation).toBe('p');
    expect(constructorOptions.format).toEqual([100, 200]);

    const [addPageFormat, addPageOrientation] = addPageMock.mock.calls[0] as [readonly [number, number], string];
    expect(addPageFormat).toEqual([200, 100]);
    expect(addPageOrientation).toBe('l');
  });
});
