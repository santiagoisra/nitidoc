import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fase 2.3 (capture-ux-redesign.md, Unit 3) REWRITE.
 *
 * Previously (F1/Fase 2) this test covered a bitmap-transfer regression in
 * the OLD `decode -> one-shot DETECT -> CornerEditor` import pipeline (task
 * 6.3.2 / ADR-006): `workerClient.detect` TRANSFERS (detaches) the
 * downscaled detection bitmap, and a prior bug read its `width` AFTER the
 * transfer (reading 0), swallowing a perfectly good detection.
 *
 * That whole pipeline no longer exists. Unit 3 replaced ScannerScreen's
 * permission-denied/no-camera/camera-error early-return branches with
 * `CaptureScreen`'s own no-camera variant, which imports via the
 * LIGHTWEIGHT `materializeRawCapture` path — no DETECT, no `CornerEditor` at
 * all; per-image corner detection is deferred to Unit 4's batch
 * `'processing'` step. This rewrite preserves the suite's INTENT (importing
 * an image still works when the camera is unusable — permission denied)
 * while dropping the now-inapplicable DETECT-transfer regression, and
 * additionally asserts the new pipeline never touches DETECT/`CornerEditor`
 * at all.
 *
 * Fase 2.3 Unit 6: `ensureOpenCvInit`/`workerClient` now come straight from
 * `useOpenCvInit` (mocked below) — `ScannerScreen` no longer goes through the
 * now-deleted `useDocumentDetection`.
 */

const detectMock = vi.fn();

const materializeRawCaptureMock = vi.fn(
  async ({
    id,
    originalBitmap,
  }: {
    id: string;
    originalBitmap: { width: number; height: number; close: () => void };
  }) => {
    originalBitmap.close();
    useScannerStore.getState().addRawCapture({
      id,
      order: useScannerStore.getState().rawCaptures.length,
      originalBlob: {} as Blob,
      thumbnail: { width: 100, height: 100, close: vi.fn() } as unknown as ImageBitmap,
      originalWidth: originalBitmap.width,
      originalHeight: originalBitmap.height,
    });
    return { status: 'added' as const };
  },
);

vi.mock('@/features/scanner/hooks/useActivePage', () => ({
  useActivePage: () => ({
    materializeRawCapture: materializeRawCaptureMock,
    isAtCap: false,
    canAddPage: true,
    activeWorking: null,
    activePageId: null,
    activeDirty: false,
    activatePage: vi.fn(),
    deactivateActivePage: vi.fn(),
    rewarpActivePage: vi.fn(),
  }),
}));

vi.mock('@/features/scanner/hooks/useCamera', () => ({
  useCamera: () => ({
    openCamera: vi.fn(async () => {}),
    switchCamera: vi.fn(async () => {}),
    setTorch: vi.fn(async () => {}),
  }),
}));

vi.mock('@/features/scanner/hooks/useOpenCvInit', () => ({
  useOpenCvInit: () => ({
    workerClient: {
      init: vi.fn(async () => {}),
      detect: detectMock,
      detectImageData: vi.fn(),
      warp: vi.fn(),
      isBusy: vi.fn(() => false),
      terminate: vi.fn(),
    },
    initState: { status: 'ready', progress: 1 },
    retryManualInit: vi.fn(),
    ensureOpenCvInit: vi.fn(async () => {}),
  }),
}));

vi.mock('@/features/scanner/components/CameraView', () => ({
  CameraView: forwardRef<HTMLVideoElement, { overlay?: unknown; fill?: boolean }>((_props, ref) =>
    createElement('video', { ref, 'data-testid': 'camera-view-video' }),
  ),
}));

vi.mock('@/features/scanner/lib/captureFallback', async () => {
  const actual = await vi.importActual<typeof import('@/features/scanner/lib/captureFallback')>(
    '@/features/scanner/lib/captureFallback',
  );
  return {
    ...actual,
    decodeImportedFile: vi.fn(async () => ({
      bitmap: { width: 1200, height: 900, close: vi.fn() } as unknown as ImageBitmap,
      width: 1200,
      height: 900,
    })),
  };
});

import { ScannerScreen } from '@/features/scanner/components/ScannerScreen';
import { ToastHost } from '@/shared/ui';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

describe('ScannerScreen import fallback (no-camera variant, Fase 2.3 Unit 3): permission denied', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useScannerStore.setState({ ...scannerStoreInitialState, permission: 'denied' });
  });

  afterEach(() => {
    cleanup();
  });

  it('decodes the imported file and adds a raw capture, WITHOUT running DETECT or opening a corner editor', async () => {
    render(
      <ToastHost>
        <ScannerScreen />
      </ToastHost>,
    );
    fireEvent.click(screen.getByTestId('open-scanner'));

    const input = await screen.findByTestId('import-fallback-input');
    const file = new File([new Uint8Array([1, 2, 3])], 'doc.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(materializeRawCaptureMock).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().rawCaptures).toHaveLength(1);
    expect(useScannerStore.getState().phase).toBe('capturing');

    // The OLD pipeline's DETECT/CornerEditor step is gone from this path —
    // this is the direct replacement for the old regression assertion.
    expect(detectMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('corner-editor')).toBeNull();

    // "Siguiente" becomes available once at least one raw capture exists.
    expect(screen.getByTestId('capture-next')).toBeTruthy();
  });
});
