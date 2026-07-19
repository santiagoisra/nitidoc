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
      // Review fix: use `result.total` (the attempted count `run()` itself
      // observed) rather than this hook's own `total` REACT STATE — that
      // state is captured by this mount-only effect's closure at its INITIAL
      // value (`0`, before `run()` ever set it), so `total > 0` here could
      // never be true and this toast was dead code.
      if (!result.cancelled && result.addedCount === 0 && result.total > 0) {
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
      // PWA safe area (iOS standalone, full-bleed screen): keep content clear of
      // the notch / home indicator.
      style={{
        paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)',
      }}
      data-testid="processing-screen"
    >
      {openCvDegraded && <OpenCvDegradedBanner lastError={opencvLastError} onRetry={retryManualInit} />}

      {/* "Developing" metaphor (design 5.3): a back page (rotated, stone) with a
          front warm-paper page swept by a teal scan line — replaces the plain
          spinner. Keeps `data-testid="processing-spinner"` so the loading state
          is still selectable. */}
      <div className="relative h-28 w-24" data-testid="processing-spinner" aria-hidden="true">
        <div className="absolute inset-0 rotate-[4deg] rounded-lg bg-surface shadow-[0_10px_30px_rgba(0,0,0,0.4)]" />
        <div className="absolute inset-0 overflow-hidden rounded-lg bg-surface-light shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
          <div className="flex h-full flex-col gap-2 p-3">
            <span className="h-1.5 w-3/4 rounded-full bg-bg/15" />
            <span className="h-1.5 w-full rounded-full bg-bg/10" />
            <span className="h-1.5 w-5/6 rounded-full bg-bg/10" />
            <span className="h-1.5 w-full rounded-full bg-bg/10" />
            <span className="h-1.5 w-2/3 rounded-full bg-bg/10" />
          </div>
          <span
            className="animate-scan-page absolute left-0 h-[3px] w-full"
            style={{
              top: '6%',
              background: 'linear-gradient(90deg, transparent, #0F8A78, #8CEBD9, transparent)',
              boxShadow: '0 0 12px rgba(46,196,173,0.8)',
            }}
          />
        </div>
      </div>

      <p className="text-base font-semibold text-text" data-testid="processing-title">
        {t('processing.title')}
      </p>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-surface-2"
        data-testid="processing-progress-bar"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary-dark to-primary-light transition-[width] duration-200 ease-out"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <p
        role="status"
        aria-live="polite"
        className="tabular-nums text-sm text-text-muted"
        data-testid="processing-progress-text"
      >
        {t('processing.progress', { done, total })}
      </p>

      <p className="max-w-xs text-center text-sm text-text-muted">{t('processing.subtitle')}</p>

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
