// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { CvBindings, CvMat } from '@/features/scanner/worker/cvBindings';

const state = vi.hoisted(() => {
  const postMessage = vi.fn(), generic = { matFromImageData: vi.fn(), matFromArray: vi.fn(), filter2D: vi.fn() };
  let listener: ((event: MessageEvent) => void) | undefined;
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { addEventListener: (_: string, fn: (event: MessageEvent) => void) => { listener = fn; }, postMessage } });
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} } });
  return { postMessage, generic, get listener() { return listener; }, loadOpenCv: vi.fn(), applySauvolaTiled: vi.fn() };
});

vi.mock('@/features/scanner/lib/opencvLoader', () => ({ loadOpenCv: state.loadOpenCv }));
vi.mock('@/features/scanner/worker/applySauvolaTiled', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/features/scanner/worker/applySauvolaTiled')>()), applySauvolaTiled: state.applySauvolaTiled }));
import '@/features/scanner/worker/opencv.worker';

const run = async (data: unknown) => { state.listener?.({ data } as MessageEvent); await vi.waitFor(() => expect(state.postMessage).toHaveBeenCalled()); };
const cv = state.generic as unknown as CvBindings;
const mat = (data: Uint8Array): CvMat => ({ data, rows: 1, cols: data.length, data32F: new Float32Array(), data32S: new Int32Array(), data64F: new Float64Array(), delete: vi.fn(), isDeleted: () => false });

describe('opencv worker Sauvola route', () => {
  it('routes a singleton bw request through Sauvola without generic decode or unsharp work', async () => {
    const image = { width: 2, height: 1, data: new Uint8ClampedArray(8) }, output = mat(new Uint8Array([0, 255]));
    state.loadOpenCv.mockResolvedValue({ cv }); state.applySauvolaTiled.mockReturnValue(output);
    await run({ id: 1, type: 'INIT', assetUrl: '/cv' }); state.postMessage.mockClear();
    await run({ id: 2, type: 'APPLY_FILTER', image, variants: [{ preset: 'bw', brightness: -47, contrast: 15, sharpness: 60 }], outputBitmap: false });
    const [response, transfer] = state.postMessage.mock.calls[0] as [{ results: [{ image: typeof image }] }, Transferable[]];
    expect(state.applySauvolaTiled).toHaveBeenCalledWith(cv, image, -47, 15); expect(response.results[0].image).toBe(image); expect(transfer).toEqual([image.data.buffer]);
    expect([...image.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]); expect(output.delete).toHaveBeenCalledOnce(); expect(Object.values(state.generic).every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('returns FILTER_FAILED and releases the Sauvola Mat when its data read fails', async () => {
    const deleted = vi.fn(), failure = new Error('bad mat data'), broken = { ...mat(new Uint8Array()), get data(): Uint8Array { throw failure; }, delete: deleted } as CvMat;
    state.postMessage.mockClear(); state.applySauvolaTiled.mockReturnValue(broken);
    await run({ id: 3, type: 'APPLY_FILTER', image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, variants: [{ preset: 'bw', brightness: 0, contrast: 0, sharpness: 0 }], outputBitmap: false });
    expect(state.postMessage.mock.calls[0]?.[0]).toMatchObject({ id: 3, type: 'ERROR', code: 'FILTER_FAILED' }); expect(deleted).toHaveBeenCalledOnce(); expect(Object.values(state.generic).every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});
