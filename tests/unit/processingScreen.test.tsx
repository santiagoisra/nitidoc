import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for a Fase 2.3 adversarial-review fix: `ProcessingScreen`'s
 * "all pages failed" toast used to compare `result.addedCount` against its
 * OWN `total` REACT STATE, read inside a mount-only effect's closure — that
 * closure captured `total` at its initial render value (`0`, before `run()`
 * ever updated it), so `total > 0` could never be true and the toast was dead
 * code. `useBatchProcess.run()` now resolves with `total` directly in its
 * `RunBatchResult`, and `ProcessingScreen` uses THAT instead of the stale
 * closure.
 *
 * `useBatchProcess` is mocked so this suite controls exactly what `run()`
 * resolves with, independent of the real detect/warp pipeline (already
 * covered by `useBatchProcess.test.ts`).
 */

const runMock = vi.fn();
const cancelMock = vi.fn();

vi.mock('@/features/scanner/hooks/useBatchProcess', () => ({
  useBatchProcess: () => ({
    processing: true,
    done: 0,
    total: 0,
    run: runMock,
    cancel: cancelMock,
  }),
}));

import { ProcessingScreen } from '@/features/scanner/components/ProcessingScreen';
import { ToastHost } from '@/shared/ui';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';
import type { WorkerClient } from '@/features/scanner/lib/workerClient';

function renderProcessingScreen() {
  const ensureOpenCvInit = vi.fn(async () => {});
  const retryManualInit = vi.fn();
  const workerClient = {} as WorkerClient;
  return render(
    <ToastHost>
      <ProcessingScreen
        ensureOpenCvInit={ensureOpenCvInit}
        workerClient={workerClient}
        retryManualInit={retryManualInit}
      />
    </ToastHost>,
  );
}

describe('ProcessingScreen — "all pages failed" toast uses run()\'s returned total (review fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the failedPages toast when run() resolves with addedCount 0 but a positive total', async () => {
    runMock.mockResolvedValue({ addedCount: 0, cancelled: false, total: 3 });

    await act(async () => {
      renderProcessingScreen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('toast-host').textContent).toContain('Could not process any page');
  });

  it('does NOT show the toast when run() resolves with total 0 (nothing was ever attempted — the old dead-code condition)', async () => {
    runMock.mockResolvedValue({ addedCount: 0, cancelled: false, total: 0 });

    await act(async () => {
      renderProcessingScreen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('toast-host').textContent ?? '').not.toContain('Could not process any page');
  });

  it('does NOT show the toast when the run was cancelled, even with a positive total', async () => {
    runMock.mockResolvedValue({ addedCount: 0, cancelled: true, total: 3 });

    await act(async () => {
      renderProcessingScreen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('toast-host').textContent ?? '').not.toContain('Could not process any page');
  });

  it('does NOT show the toast when at least one page was added', async () => {
    runMock.mockResolvedValue({ addedCount: 2, cancelled: false, total: 3 });

    await act(async () => {
      renderProcessingScreen();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('toast-host').textContent ?? '').not.toContain('Could not process any page');
  });
});
