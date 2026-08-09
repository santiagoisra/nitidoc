import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyFilterResponse, FilterVariant, WorkerRequest } from '@/features/scanner/worker/messages';

/**
 * Group 3 / PR6 unit tests for `WorkerClient.applyFilter` (task 3.6),
 * verifying the RPC request/response protocol WITHOUT a real worker or
 * OpenCV — mirrors the fake-Worker pattern already used by
 * `workerClientProtocol.test.ts`/`workerClientSingleton.test.ts`.
 */

interface FakeWorkerInstance {
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly terminate: ReturnType<typeof vi.fn>;
  emitMessage(data: unknown): void;
}

let latestWorker: FakeWorkerInstance | null = null;

class FakeWorker {
  private messageListener: ((event: MessageEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() {
    const self = this;
    latestWorker = {
      postMessage: this.postMessage,
      terminate: this.terminate,
      emitMessage(data: unknown) {
        self.messageListener?.({ data } as MessageEvent);
      },
    };
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') {
      this.messageListener = listener;
    }
  }

  removeEventListener(): void {}
}

function makeImage(size: number) {
  return {
    width: size,
    height: size,
    data: new Uint8ClampedArray(size * size * 4),
  };
}

describe('WorkerClient.applyFilter (Group 3 / PR6, design section 4.1-4.5)', () => {
  beforeEach(() => {
    latestWorker = null;
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends one APPLY_FILTER request transferring image.data.buffer, batching 3 variants in one round-trip', async () => {
    const mod = await import('@/features/scanner/lib/workerClient');
    const client = mod.createWorkerClient();

    const image = makeImage(4);
    const variants: FilterVariant[] = [
      { preset: 'bw', brightness: 0, contrast: 0, sharpness: 0 },
      { preset: 'bw-high-contrast', brightness: 10, contrast: -5, sharpness: 0 },
      { preset: 'eco', brightness: 0, contrast: 0, sharpness: 0 },
    ];

    const applyPromise = client.applyFilter(image, variants, true);

    expect(latestWorker).not.toBeNull();
    const worker = latestWorker as FakeWorkerInstance;
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    const [sentRequest, transferList] = worker.postMessage.mock.calls[0] as [WorkerRequest, Transferable[]];
    expect(sentRequest.type).toBe('APPLY_FILTER');
    if (sentRequest.type !== 'APPLY_FILTER') {
      throw new Error('expected an APPLY_FILTER request');
    }
    expect(sentRequest.variants).toEqual(variants);
    expect(sentRequest.outputBitmap).toBe(true);
    // The buffer itself (not a copy) must be in the transfer list — zero-copy
    // contract (design section 4.2).
    expect(transferList).toContain(image.data.buffer);

    const response: ApplyFilterResponse = {
      id: sentRequest.id,
      type: 'APPLY_FILTER_RESULT',
      results: [
        { kind: 'imagedata', image: makeImage(4) },
        { kind: 'imagedata', image: makeImage(4) },
        { kind: 'imagedata', image: makeImage(4) },
      ],
    };
    worker.emitMessage(response);

    const resolved = await applyPromise;
    expect(resolved).toEqual(response);
    // Same order and length as request.variants (design section 4.1).
    expect(resolved.results).toHaveLength(3);

    client.terminate();
  });

  it('does NOT set isBusy() true while an applyFilter call is in flight (distinct from the DETECT drop-latest gate, design section 4.5)', async () => {
    const mod = await import('@/features/scanner/lib/workerClient');
    const client = mod.createWorkerClient();

    expect(client.isBusy()).toBe(false);

    const applyPromise = client.applyFilter(
      makeImage(2),
      [{ preset: 'bw', brightness: 0, contrast: 0, sharpness: 0 }],
      false,
    );
    expect(client.isBusy()).toBe(false);

    const worker = latestWorker as FakeWorkerInstance;
    const [sentRequest] = worker.postMessage.mock.calls[0] as [WorkerRequest];
    worker.emitMessage({
      id: sentRequest.id,
      type: 'APPLY_FILTER_RESULT',
      results: [{ kind: 'imagedata', image: makeImage(2) }],
    });

    await applyPromise;
    expect(client.isBusy()).toBe(false);

    client.terminate();
  });

  it('correlates an in-flight DETECT and an in-flight applyFilter independently via the shared id map', async () => {
    const mod = await import('@/features/scanner/lib/workerClient');
    const client = mod.createWorkerClient();

    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const detectPromise = client.detect(bitmap, false);
    const applyPromise = client.applyFilter(
      makeImage(2),
      [{ preset: 'eco', brightness: 0, contrast: 0, sharpness: 0 }],
      false,
    );

    const worker = latestWorker as FakeWorkerInstance;
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    const [detectRequest] = worker.postMessage.mock.calls[0] as [WorkerRequest];
    const [applyRequest] = worker.postMessage.mock.calls[1] as [WorkerRequest];
    expect(detectRequest.id).not.toBe(applyRequest.id);

    worker.emitMessage({
      id: applyRequest.id,
      type: 'APPLY_FILTER_RESULT',
      results: [{ kind: 'imagedata', image: makeImage(2) }],
    });
    worker.emitMessage({ id: detectRequest.id, type: 'DETECT_RESULT', corners: null, evidence: null, quality: null });

    const applyResult = await applyPromise;
    const detectResult = await detectPromise;
    expect(applyResult.type).toBe('APPLY_FILTER_RESULT');
    expect(detectResult.type).toBe('DETECT_RESULT');

    client.terminate();
  });
});
