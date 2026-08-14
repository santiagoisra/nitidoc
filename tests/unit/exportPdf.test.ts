import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'jpeg-js';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { EditRecipe } from '@/shared/types/scanner';
import { NEUTRAL_FILTER } from '@/shared/types/scanner';
import type { AspectRatioName, Point, Quad } from '@/shared/types/geometry';
import type { ApplyFilterResponse } from '@/features/scanner/worker/messages';
import { classifyPaperRatio, paperSelection } from '@/features/scanner/lib/paperFormats';

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

const deliverPdfMock = vi.fn();
vi.mock('@/features/scanner/lib/savePdf', () => ({
  deliverPdf: (...args: unknown[]) => deliverPdfMock(...args),
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
    paper: paperSelection('a4', 'auto'),
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
  return { id: 1, type: 'APPLY_FILTER_RESULT', results: [{ kind: 'bitmap', bitmap }] };
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
  const jpeg = encode({ data: Buffer.alloc(4), width: 1, height: 1 }, 80).data;
  const dataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl);
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

interface GeneratedPdf {
  output(type: 'arraybuffer'): ArrayBuffer;
  getNumberOfPages(): number;
}

function deliveredPdf(): GeneratedPdf {
  return deliverPdfMock.mock.calls[0]?.[0] as GeneratedPdf;
}

function mediaBoxesInPoints(pdf: GeneratedPdf): readonly [number, number][] {
  const bytes = new Uint8Array(pdf.output('arraybuffer'));
  const text = new TextDecoder('latin1').decode(bytes);
  return [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ] as const);
}

function expectMm(mediaBox: readonly [number, number], width: number, height: number): void {
  const pointsPerMm = 72 / 25.4;
  expect(mediaBox[0]).toBeCloseTo(width * pointsPerMm, 5);
  expect(mediaBox[1]).toBeCloseTo(height * pointsPerMm, 5);
}

describe('exportPagesToPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installCanvasShims();
    deliverPdfMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a no-op when there are no pages', async () => {
    await exportPagesToPdf([]);
    expect(decodeBlobToBitmapMock).not.toHaveBeenCalled();
    expect(deliverPdfMock).not.toHaveBeenCalled();
  });

  it('processes pages sequentially in document order and closes every decoded bitmap', async () => {
    const bitmapA = makeBitmap(100, 140);
    const bitmapB = makeBitmap(200, 280);
    const bitmapC = makeBitmap(300, 420);
    decodeBlobToBitmapMock.mockResolvedValueOnce(bitmapA).mockResolvedValueOnce(bitmapB).mockResolvedValueOnce(bitmapC);
    const pageOrder2 = makePage('p-order-2', 2);
    const pageOrder0 = makePage('p-order-0', 0);
    const pageOrder1 = makePage('p-order-1', 1);

    await exportPagesToPdf([pageOrder2, pageOrder0, pageOrder1]);

    expect(decodeBlobToBitmapMock).toHaveBeenNthCalledWith(1, pageOrder0.warpedBlob);
    expect(decodeBlobToBitmapMock).toHaveBeenNthCalledWith(2, pageOrder1.warpedBlob);
    expect(decodeBlobToBitmapMock).toHaveBeenNthCalledWith(3, pageOrder2.warpedBlob);
    expect(bitmapA.close).toHaveBeenCalledTimes(1);
    expect(bitmapB.close).toHaveBeenCalledTimes(1);
    expect(bitmapC.close).toHaveBeenCalledTimes(1);
    expect(deliveredPdf().getNumberOfPages()).toBe(3);
  });

  it('routes worker-rendered presets through the worker while original remains raw', async () => {
    const originalBitmap = makeBitmap(100, 140);
    const enhancedBitmap = makeBitmap(100, 140);
    const filteredBitmap = makeBitmap(100, 140);
    decodeBlobToBitmapMock.mockResolvedValueOnce(originalBitmap).mockResolvedValueOnce(enhancedBitmap);
    applyFilterMock.mockResolvedValueOnce(fakeApplyFilterResponse(filteredBitmap));

    await exportPagesToPdf([
      makePage('p-original', 0, makeRecipe({ filter: { ...NEUTRAL_FILTER, preset: 'original' } })),
      makePage('p-enhanced', 1, makeRecipe({ filter: { ...NEUTRAL_FILTER, preset: 'enhanced' } })),
    ]);

    expect(applyFilterMock).toHaveBeenCalledTimes(1);
    expect(originalBitmap.close).toHaveBeenCalledTimes(1);
    expect(enhancedBitmap.close).toHaveBeenCalledTimes(1);
    expect(filteredBitmap.close).toHaveBeenCalledTimes(1);
  });

  it('writes an A4 MediaBox from catalog millimeters regardless of portrait camera pixel size', async () => {
    decodeBlobToBitmapMock.mockResolvedValue(makeBitmap(3024, 4032));
    await exportPagesToPdf([makePage('a4', 0, makeRecipe({ paper: paperSelection('a4', 'manual') }))]);
    expectMm(mediaBoxesInPoints(deliveredPdf())[0]!, 210, 297);
  });

  it('writes the manual Tarjeta/DNI MediaBox from its ID-1 catalog millimeters', async () => {
    decodeBlobToBitmapMock.mockResolvedValue(makeBitmap(3024, 4032));
    await exportPagesToPdf([makePage('ticket', 0, makeRecipe({ paper: paperSelection('ticket', 'manual') }))]);
    expectMm(mediaBoxesInPoints(deliveredPdf())[0]!, 53.98, 85.6);
  });

  it('keeps automatic probabilistic A4 on raster geometry without claiming nominal millimeters', async () => {
    decodeBlobToBitmapMock.mockResolvedValue(makeBitmap(764, 540));
    await exportPagesToPdf([
      makePage('a4-probable', 0, makeRecipe({ paper: classifyPaperRatio(210 / 297) })),
    ]);

    const mediaBox = mediaBoxesInPoints(deliveredPdf())[0]!;
    expectMm(mediaBox, 764 * (25.4 / 54), 540 * (25.4 / 54));
    expect(mediaBox[0] / mediaBox[1]).toBeCloseTo(764 / 540, 5);
  });

  it('uses final rendered orientation for a landscape known format even when recipe rotation is zero', async () => {
    decodeBlobToBitmapMock.mockResolvedValue(makeBitmap(4032, 3024));
    await exportPagesToPdf([
      makePage('a4-landscape', 0, makeRecipe({ paper: paperSelection('a4', 'manual'), rotation: 0 })),
    ]);
    expectMm(mediaBoxesInPoints(deliveredPdf())[0]!, 297, 210);
  });

  it('rotates Letter MediaBox to landscape from recipe orientation', async () => {
    decodeBlobToBitmapMock.mockResolvedValue(makeBitmap(3024, 4032));
    await exportPagesToPdf([
      makePage('letter', 0, makeRecipe({ paper: paperSelection('letter', 'manual'), rotation: 90 })),
    ]);
    expectMm(mediaBoxesInPoints(deliveredPdf())[0]!, 279.4, 215.9);
  });

  it('writes the Oficio alias as the Legal-family 216 x 356 mm MediaBox', async () => {
    decodeBlobToBitmapMock.mockResolvedValue(makeBitmap(1200, 1800));
    await exportPagesToPdf([
      makePage('oficio', 0, makeRecipe({ paper: paperSelection('oficio', 'manual') })),
    ]);
    expectMm(mediaBoxesInPoints(deliveredPdf())[0]!, 216, 356);
  });

  it('keeps ordered MediaBoxes for mixed known nominal formats', async () => {
    decodeBlobToBitmapMock
      .mockResolvedValueOnce(makeBitmap(3000, 4200))
      .mockResolvedValueOnce(makeBitmap(3000, 4200))
      .mockResolvedValueOnce(makeBitmap(1800, 3000));
    await exportPagesToPdf([
      makePage('a4', 0, makeRecipe({ paper: paperSelection('a4', 'manual') })),
      makePage('letter', 1, makeRecipe({ paper: paperSelection('letter', 'auto'), rotation: 90 })),
      makePage('oficio', 2, makeRecipe({ paper: paperSelection('oficio', 'manual') })),
    ]);

    const mediaBoxes = mediaBoxesInPoints(deliveredPdf());
    expect(mediaBoxes).toHaveLength(3);
    expectMm(mediaBoxes[0]!, 210, 297);
    expectMm(mediaBoxes[1]!, 279.4, 215.9);
    expectMm(mediaBoxes[2]!, 216, 356);
  });

  it('keeps mixed known and legacy pages in one mm document with explicit raster fallback', async () => {
    decodeBlobToBitmapMock.mockResolvedValueOnce(makeBitmap(1000, 1400)).mockResolvedValueOnce(makeBitmap(540, 1080));
    await exportPagesToPdf([
      makePage('a4', 0, makeRecipe({ paper: paperSelection('a4', 'manual') })),
      makePage('original', 1, makeRecipe({ paper: paperSelection('original', 'legacy'), aspectRatio: 'unknown' })),
    ]);
    const mediaBoxes = mediaBoxesInPoints(deliveredPdf());
    expect(mediaBoxes).toHaveLength(2);
    expectMm(mediaBoxes[0]!, 210, 297);
    expectMm(mediaBoxes[1]!, 540 * (25.4 / 54), 1080 * (25.4 / 54));
  });
});
