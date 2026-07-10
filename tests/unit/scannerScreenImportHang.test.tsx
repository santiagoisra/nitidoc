import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fase 2.3 (capture-ux-redesign.md, Unit 3) REWRITE.
 *
 * Previously (Slice F review fix HIGH-1 / MEDIUM-2) this test covered the
 * OLD import pipeline racing a HANGING `ensureOpenCvInit()` against
 * `IMPORT_DETECT_TIMEOUT_MS` before falling through to the frame-completo
 * `CornerEditor`. That race existed because the old pipeline AWAITED OpenCV
 * before running a one-shot DETECT.
 *
 * Unit 3's `CaptureScreen` no-camera-variant import handler does not touch
 * OpenCV at all (DETECT is deferred to Unit 4's batch `'processing'` step) —
 * there is nothing left to race against a hang. This rewrite preserves the
 * suite's INTENT (an import must never get stuck waiting on OpenCV) by
 * proving the NEW import path resolves promptly and adds a raw capture even
 * while `ensureOpenCvInit()` hangs forever in the background (the
 * `started`-effect's own best-effort load, unrelated to import), with no
 * unhandled promise rejection.
 *
 * Fase 2.3 Unit 6: `ensureOpenCvInit`/`workerClient` now come straight from
 * `useOpenCvInit` (mocked below) — `ScannerScreen` no longer goes through the
 * now-deleted `useDocumentDetection`.
 */

// ensureOpenCvInit HANGS: never resolves nor rejects. The NEW import path
// must not be blocked by this at all — it belongs to a completely separate,
// backgrounded effect.
const ensureOpenCvInitMock = vi.fn(() => new Promise<void>(() => {}));
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
    initState: { status: 'loading', progress: 0 },
    retryManualInit: vi.fn(),
    ensureOpenCvInit: ensureOpenCvInitMock,
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

describe('ScannerScreen import (no-camera variant, Fase 2.3 Unit 3) is decoupled from a HANGING OpenCV init', () => {
  let unhandled: PromiseRejectionEvent[] = [];
  const onUnhandled = (event: PromiseRejectionEvent): void => {
    unhandled.push(event);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    unhandled = [];
    window.addEventListener('unhandledrejection', onUnhandled);
    useScannerStore.setState({ ...scannerStoreInitialState, permission: 'denied' });
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', onUnhandled);
    cleanup();
  });

  it('adds a raw capture immediately, without waiting on ensureOpenCvInit — no DETECT, no unhandled rejection', async () => {
    render(
      <ToastHost>
        <ScannerScreen />
      </ToastHost>,
    );
    fireEvent.click(screen.getByTestId('open-scanner'));

    // The (backgrounded, unrelated) started-effect already kicked off the
    // hanging ensureOpenCvInit() — confirms this scenario really has OpenCV
    // stuck, exactly like the original regression's setup.
    expect(ensureOpenCvInitMock).toHaveBeenCalledTimes(1);

    const input = await screen.findByTestId('import-fallback-input');
    const file = new File([new Uint8Array([1, 2, 3])], 'doc.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    // The import resolved WITHOUT ever waiting on the hung init.
    expect(materializeRawCaptureMock).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().rawCaptures).toHaveLength(1);
    expect(detectMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('corner-editor')).toBeNull();

    expect(unhandled).toHaveLength(0);
  });
});
