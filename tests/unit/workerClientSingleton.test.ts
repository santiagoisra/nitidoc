import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Slice D adversarial review regression test for the worker singleton (C2).
 *
 * getSharedWorkerClient must construct the underlying Worker exactly ONCE per
 * module lifetime, no matter how many times it is called (e.g. a StrictMode
 * double-mount, or navigate-away-and-back). Before this fix the hook created a
 * worker per instance via useMemo + a per-instance ref, so StrictMode's
 * remount (fresh ref) built a second worker and downloaded OpenCV twice.
 *
 * We stub the global Worker constructor and count constructions. This asserts
 * the sharing contract without needing a real worker / OpenCV download.
 */

const workerConstructions: unknown[] = [];

class FakeWorker {
  constructor(url: unknown) {
    workerConstructions.push(url);
  }
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  postMessage = vi.fn();
  terminate = vi.fn();
}

describe('getSharedWorkerClient singleton (C2)', () => {
  beforeEach(() => {
    workerConstructions.length = 0;
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs the worker only once across many getSharedWorkerClient() calls', async () => {
    const mod = await import('@/features/scanner/lib/workerClient');

    const a = mod.getSharedWorkerClient();
    const b = mod.getSharedWorkerClient();
    const c = mod.getSharedWorkerClient();

    // Same instance every time (simulating StrictMode remount reusing it).
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Exactly one Worker was ever constructed.
    expect(workerConstructions).toHaveLength(1);

    mod.terminateSharedWorkerClient();
  });

  it('re-creates a fresh worker only after an explicit terminate', async () => {
    const mod = await import('@/features/scanner/lib/workerClient');

    const first = mod.getSharedWorkerClient();
    expect(workerConstructions).toHaveLength(1);

    mod.terminateSharedWorkerClient();

    const second = mod.getSharedWorkerClient();
    expect(second).not.toBe(first);
    expect(workerConstructions).toHaveLength(2);

    mod.terminateSharedWorkerClient();
  });
});
