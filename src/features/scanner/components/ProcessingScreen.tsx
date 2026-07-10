/**
 * Full-bleed, transient batch-processing screen (Fase 2.3, capture-ux-
 * redesign.md, "Unit 4"). Rendered by `ScannerScreen` for `phase ===
 * 'processing'`, REPLACING the temporary `common.processing` text
 * placeholder Unit 3 shipped so the app stayed buildable while "Siguiente"
 * could already reach this phase.
 *
 * Drives `useBatchProcess` (detect -> warp -> thumbnail per raw capture,
 * sequential, degraded-fallback-safe) via a mount-only effect — the hook's
 * own `ranRef` guard makes this safe under React 18 StrictMode's dev-only
 * double-invoke. Shows a determinate progress bar (`done`/`total`) + a
 * spinner + a Cancel button that aborts the batch back to `'capturing'`
 * (`rawCaptures` stay intact — Unit 4's "Edge cases" contract).
 *
 * Re-scopes `OpenCvDegradedBanner` here (Fase 2.3): the live-camera view
 * that used to render it is dead code post-Unit-3 (see `ScannerScreen`'s own
 * doc comment) — `'processing'` is now the only phase that actually invokes
 * OpenCV, so this is where a degraded-mode banner is actually relevant.
 *
 * `ensureOpenCvInit`/`workerClient`/`retryManualInit` are passed down as
 * props from `ScannerScreen`'s single `useOpenCvInit()` instance — see
 * `useBatchProcess.ts`'s own doc comment for why a second independent
 * `useOpenCvInit()` call site is avoided.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button, useToast } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { OpenCvDegradedBanner } from '@/features/scanner/components/OpenCvDegradedBanner';
import { useBatchProcess } from '@/features/scanner/hooks/useBatchProcess';
import type { WorkerClient } from '@/features/scanner/lib/workerClient';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

export interface ProcessingScreenProps {
  readonly ensureOpenCvInit: () => Promise<void>;
  readonly workerClient: WorkerClient;
  readonly retryManualInit: () => void;
}

export function ProcessingScreen({
  ensureOpenCvInit,
  workerClient,
  retryManualInit,
}: ProcessingScreenProps): ReactNode {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const opencvStatus = useScannerStore((s) => s.opencv.status);
  const opencvLastError = useScannerStore((s) => s.opencv.lastError);

  const { processing, done, total, run, cancel } = useBatchProcess({ ensureOpenCvInit, workerClient });

  useEffect(() => {
    void run().then((result) => {
      if (!result.cancelled && result.addedCount === 0 && total > 0) {
        showToast({ message: t('processing.failedPages'), variant: 'danger' });
      }
    });
    // `run` is stable across renders (memoized in the hook) and internally
    // run-once-guarded — this effect is intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancel = useCallback(() => {
    cancel();
  }, [cancel]);

  const openCvDegraded = opencvStatus === 'error';
  const progressPercent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-4 bg-bg p-6"
      data-testid="processing-screen"
    >
      {openCvDegraded && <OpenCvDegradedBanner lastError={opencvLastError} onRetry={retryManualInit} />}

      <Loader2
        className="animate-spin text-primary"
        size={32}
        strokeWidth={1.5}
        aria-hidden="true"
        data-testid="processing-spinner"
      />

      <p className="text-base font-medium text-text" data-testid="processing-title">
        {t('processing.title')}
      </p>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-surface"
        data-testid="processing-progress-bar"
      >
        <div
          className="h-full bg-primary transition-[width] duration-200 ease-out"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <p
        role="status"
        aria-live="polite"
        className="text-sm text-text-muted"
        data-testid="processing-progress-text"
      >
        {t('processing.progress', { done, total })}
      </p>

      <Button
        type="button"
        variant="ghost"
        onClick={handleCancel}
        disabled={!processing}
        data-testid="processing-cancel"
      >
        {t('processing.cancel')}
      </Button>
    </div>
  );
}
