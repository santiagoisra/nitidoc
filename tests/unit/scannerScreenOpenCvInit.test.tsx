import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Group 6 / Slice F regression test for the bug found and fixed while
 * building the task 7.2 E2E fixture test: OpenCV was previously ONLY ever
 * initialized as a side effect of the live-detection loop starting
 * (`useDocumentDetection.start()`, which requires a granted camera
 * permission and a mounted <video>). When the import fallback is reached
 * WITHOUT the camera ever opening (permission denied, or no camera at all —
 * tasks 6.1/6.2), nothing ever called OpenCV `INIT`, so both the one-shot
 * DETECT (task 6.3.2) and the editor's later WARP call failed with
 * NOT_INITIALIZED every single time.
 *
 * Fix: ScannerScreen now calls `ensureOpenCvInit()` (exposed from
 * `useDocumentDetection`) as soon as `started` becomes true, regardless of
 * camera outcome. This test verifies that trigger fires even when
 * permission is denied (so the camera never opens and `start()` never
 * runs) — the exact scenario that was broken.
 */

const ensureOpenCvInitMock = vi.fn(async () => {});
const startDetectionMock = vi.fn();
const stopDetectionMock = vi.fn();

vi.mock('@/features/scanner/hooks/useCamera', () => ({
  useCamera: () => ({
    openCamera: vi.fn(async () => {}),
    switchCamera: vi.fn(async () => {}),
    setTorch: vi.fn(async () => {}),
  }),
}));

vi.mock('@/features/scanner/hooks/useDocumentDetection', () => ({
  useDocumentDetection: () => ({
    start: startDetectionMock,
    stop: stopDetectionMock,
    workerClient: {
      init: vi.fn(async () => {}),
      detect: vi.fn(),
      detectImageData: vi.fn(),
      warp: vi.fn(),
      isBusy: vi.fn(() => false),
      terminate: vi.fn(),
    },
    initState: { status: 'idle', progress: 0 },
    retryManualInit: vi.fn(),
    ensureOpenCvInit: ensureOpenCvInitMock,
  }),
}));

vi.mock('@/features/scanner/components/CameraView', () => ({
  CameraView: forwardRef<HTMLVideoElement, { overlay?: unknown }>((_props, ref) =>
    createElement('video', { ref, 'data-testid': 'camera-view-video' }),
  ),
}));

import { ScannerScreen } from '@/features/scanner/components/ScannerScreen';
import { ToastHost } from '@/shared/ui';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

describe('ScannerScreen ensures OpenCV init even without a camera (bug fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('calls ensureOpenCvInit() once the scanner starts, even when permission is denied (no camera ever opens)', async () => {
    useScannerStore.setState({ ...scannerStoreInitialState, permission: 'denied' });

    render(
      <ToastHost>
        <ScannerScreen />
      </ToastHost>,
    );
    fireEvent.click(screen.getByTestId('open-scanner'));

    await waitFor(() => {
      expect(ensureOpenCvInitMock).toHaveBeenCalledTimes(1);
    });

    // The live-detection loop's own start() must NOT have been invoked —
    // there is no granted permission / video element for it to run against.
    expect(startDetectionMock).not.toHaveBeenCalled();

    // The import fallback (task 6.1.1) must be visible, confirming this
    // exercised the exact broken scenario (no camera path at all).
    expect(screen.getByTestId('import-fallback')).toBeTruthy();
  });

  it('calls ensureOpenCvInit() once the scanner starts with a granted permission too (no double-init regression)', async () => {
    useScannerStore.setState({
      ...scannerStoreInitialState,
      permission: 'granted',
      stream: {
        getVideoTracks: () => [{ stop: vi.fn() }],
        getTracks: () => [{ stop: vi.fn() }],
      } as unknown as MediaStream,
    });

    render(
      <ToastHost>
        <ScannerScreen />
      </ToastHost>,
    );
    fireEvent.click(screen.getByTestId('open-scanner'));

    await waitFor(() => {
      expect(ensureOpenCvInitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not call ensureOpenCvInit() before the scanner is started (respects "no preload" gating)', () => {
    act(() => {
      useScannerStore.setState({ ...scannerStoreInitialState });
    });
    render(
      <ToastHost>
        <ScannerScreen />
      </ToastHost>,
    );

    // Still on the "Open scanner" button — `started` is false.
    expect(screen.getByTestId('open-scanner')).toBeTruthy();
    expect(ensureOpenCvInitMock).not.toHaveBeenCalled();
  });
});
