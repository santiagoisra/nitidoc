import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Slice F review fix HIGH-1 + coverage MEDIUM-2: the import fallback must fall
 * through to the frame-completo editor when OpenCV init HANGS, WITHOUT leaking
 * the race timer or producing an unhandled promise rejection.
 *
 * Setup: `ensureOpenCvInit()` returns a promise that never settles (the hung
 * worker). `handleImportedFile` races it against `IMPORT_DETECT_TIMEOUT_MS`
 * (15s). After that window elapses the import must still store the imported
 * frame (opening CornerEditor with frame-completo corners) and clear its
 * `importing` state. A failing implementation (uncleared timer) would leave a
 * rejected timer promise with no `.catch`; this test installs an
 * `unhandledrejection` listener and asserts none fires.
 */

const IMPORT_DETECT_TIMEOUT_MS = 15_000;

// ensureOpenCvInit HANGS: never resolves nor rejects.
const ensureOpenCvInitMock = vi.fn(() => new Promise<void>(() => {}));

vi.mock('@/features/scanner/hooks/useCamera', () => ({
  useCamera: () => ({
    openCamera: vi.fn(async () => {}),
    switchCamera: vi.fn(async () => {}),
    setTorch: vi.fn(async () => {}),
  }),
}));

const detectMock = vi.fn();
const detectImageDataMock = vi.fn();

vi.mock('@/features/scanner/hooks/useDocumentDetection', () => ({
  useDocumentDetection: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    workerClient: {
      init: vi.fn(async () => {}),
      detect: detectMock,
      detectImageData: detectImageDataMock,
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
  CameraView: forwardRef<HTMLVideoElement, { overlay?: unknown }>((_props, ref) =>
    createElement('video', { ref, 'data-testid': 'camera-view-video' }),
  ),
}));

// The corner editor renders once a frame is stored; stub it so we can assert
// the fall-through happened without pulling in its full canvas machinery.
vi.mock('@/features/scanner/components/CornerEditor', () => ({
  CornerEditor: () => createElement('div', { 'data-testid': 'corner-editor' }),
}));

// Decode returns a fake CapturedFrameResult (no real ImageBitmap needed).
vi.mock('@/features/scanner/lib/captureFallback', async () => {
  const actual = await vi.importActual<typeof import('@/features/scanner/lib/captureFallback')>(
    '@/features/scanner/lib/captureFallback',
  );
  return {
    ...actual,
    decodeImportedFile: vi.fn(async () => ({
      bitmap: { close: vi.fn() } as unknown as ImageBitmap,
      width: 1200,
      height: 900,
    })),
  };
});

import { ScannerScreen } from '@/features/scanner/components/ScannerScreen';
import { ToastHost } from '@/shared/ui';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

describe('ScannerScreen import fallback with a HANGING OpenCV init (HIGH-1 / MEDIUM-2)', () => {
  let unhandled: PromiseRejectionEvent[] = [];
  const onUnhandled = (event: PromiseRejectionEvent): void => {
    unhandled.push(event);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    unhandled = [];
    window.addEventListener('unhandledrejection', onUnhandled);
    useScannerStore.setState({ ...scannerStoreInitialState, permission: 'denied' });
    // createImageBitmap for the one-shot DETECT downscale (never reached before
    // the timeout, but stub it so any code path is safe).
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() }) as unknown as ImageBitmap),
    );
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', onUnhandled);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it('falls through to the frame-completo editor after IMPORT_DETECT_TIMEOUT_MS with no pre-seed, no timer leak, no unhandled rejection', async () => {
    render(
      <ToastHost>
        <ScannerScreen />
      </ToastHost>,
    );
    fireEvent.click(screen.getByTestId('open-scanner'));

    // The import fallback is showing (permission denied). Trigger a file import.
    const input = screen.getByTestId('import-fallback-input') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'doc.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      // Let decodeImportedFile resolve and the race arm its timer.
      await Promise.resolve();
      await Promise.resolve();
    });

    // While within the race window, the frame is NOT yet stored (still waiting
    // on the hung init / timeout) — phase stays 'idle', editor not shown.
    expect(useScannerStore.getState().phase).toBe('idle');
    expect(screen.queryByTestId('corner-editor')).toBeNull();

    // Advance PAST the import race timeout: the race rejects, the catch falls
    // through with no pre-seed, and the frame is stored -> phase becomes
    // 'editing-corners' -> the (stubbed) CornerEditor renders.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMPORT_DETECT_TIMEOUT_MS + 1);
      // Flush the trailing microtasks after the rejection settles (no real-timer
      // `waitFor` here — it deadlocks under fake timers, see the sibling
      // useDocumentDetection test's `flushMicrotasks` note).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useScannerStore.getState().phase).toBe('editing-corners');
    expect(screen.getByTestId('corner-editor')).toBeTruthy();

    // No pre-seed: DETECT was never reached because the init race rejected first.
    expect(detectMock).not.toHaveBeenCalled();
    expect(detectImageDataMock).not.toHaveBeenCalled();

    // Critically: no unhandled rejection escaped (HIGH-1 — the race timer was
    // cleared and/or its rejection handled).
    expect(unhandled).toHaveLength(0);
  });
});
