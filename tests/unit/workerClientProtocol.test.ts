import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectResponse, WorkerRequest } from '@/features/scanner/worker/messages';

/**
 * Group 6 / Slice F unit tests for `WorkerClient.detectImageData` (task
 * 6.7.1), verifying the RPC request/response protocol WITHOUT a real worker
 * or OpenCV — a fake `Worker` captures the `postMessage` payload and lets
 * the test simulate the corresponding `DETECT_RESULT` reply, mirroring the
 * fake-Worker pattern already used by `workerClientSingleton.test.ts`.
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

describe('WorkerClient.detectImageData (task 6.7.1)', () => {
  beforeEach(() => {
    latestWorker = null;
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a DETECT_IMAGEDATA request transferring image.data.buffer, and resolves with the DETECT_RESULT reply', async () => {
    const mod = await import('@/features/scanner/lib/workerClient');
    const client = mod.createWorkerClient();

    const image = {
      width: 4,
      height: 4,
      data: new Uint8ClampedArray(4 * 4 * 4),
    };

    const detectPromise = client.detectImageData(image, true);

    expect(latestWorker).not.toBeNull();
    const worker = latestWorker as FakeWorkerInstance;
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    const [sentRequest, transferList] = worker.postMessage.mock.calls[0] as [WorkerRequest, Transferable[]];
    expect(sentRequest.type).toBe('DETECT_IMAGEDATA');
    if (sentRequest.type !== 'DETECT_IMAGEDATA') {
      throw new Error('expected a DETECT_IMAGEDATA request');
    }
    expect(sentRequest.withQuality).toBe(true);
    expect(sentRequest.image.width).toBe(4);
    expect(sentRequest.image.height).toBe(4);
    // The buffer itself (not a copy) must be in the transfer list — zero-copy
    // contract (design section 1.2).
    expect(transferList).toContain(image.data.buffer);

    const response: DetectResponse = {
      id: sentRequest.id,
      type: 'DETECT_RESULT',
          corners: null,
          evidence: null,
      quality: null,
    };
    worker.emitMessage(response);

    await expect(detectPromise).resolves.toEqual(response);

    client.terminate();
  });

  it('marks isBusy() true while a detectImageData call is in flight and false once it resolves', async () => {
    const mod = await import('@/features/scanner/lib/workerClient');
    const client = mod.createWorkerClient();

    const image = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
    expect(client.isBusy()).toBe(false);

    const detectPromise = client.detectImageData(image, false);
    expect(client.isBusy()).toBe(true);

    const worker = latestWorker as FakeWorkerInstance;
    const [sentRequest] = worker.postMessage.mock.calls[0] as [WorkerRequest];
    worker.emitMessage({ id: sentRequest.id, type: 'DETECT_RESULT', corners: null, evidence: null, quality: null });

    await detectPromise;
    expect(client.isBusy()).toBe(false);

    client.terminate();
  });
});
