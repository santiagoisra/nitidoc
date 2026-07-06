import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Slice D adversarial review regression test for the double-capture guard (H1).
 *
 * runCaptureSequence must be a no-op while phase === 'capturing' so that an
 * auto-capture already in flight cannot be joined by a manual FAB tap, which
 * would run captureFullResFrame twice and leak the first full-res ImageBitmap.
 */

const captureFullResFrameMock = vi.fn();
const startDetectionMock = vi.fn();
const stopDetectionMock = vi.fn();

vi.mock('@/features/scanner/lib/captureFrame', () => ({
  captureFullResFrame: (...args: unknown[]) => captureFullResFrameMock(...args),
}));

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
  }),
}));

// Mock CameraView so it just forwards a bare <video> ref without running the
// real srcObject effect (happy-dom rejects a non-MediaStream fake, and that
// throw cascades into React's scheduler). runCaptureSequence reads the stream
// from the store via getState(), not from this component, so a plain video is
// sufficient to give videoRef.current a truthy element.
vi.mock('@/features/scanner/components/CameraView', () => ({
  CameraView: forwardRef<HTMLVideoElement, { overlay?: unknown }>((_props, ref) =>
    createElement('video', { ref, 'data-testid': 'camera-view-video' }),
  ),
}));

import { ScannerScreen } from '@/features/scanner/components/ScannerScreen';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

function createFakeStream(): MediaStream {
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

describe('ScannerScreen capture guard (H1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useScannerStore.setState({
      ...scannerStoreInitialState,
      permission: 'granted',
      stream: createFakeStream(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('a manual capture while phase === "capturing" is a no-op (does not call captureFullResFrame)', async () => {
    render(<ScannerScreen />);

    // Enter the scanner (started state) so the viewfinder + FAB render.
    fireEvent.click(screen.getByTestId('open-scanner'));

    // A capture sequence already owns the frame.
    act(() => {
      useScannerStore.setState({ phase: 'capturing' });
    });

    const captureButton = await screen.findByTestId('capture-button');
    fireEvent.click(captureButton);

    // Guard must short-circuit BEFORE captureFullResFrame runs.
    await waitFor(() => {
      expect(captureFullResFrameMock).not.toHaveBeenCalled();
    });
  });

  it('a manual capture while idle DOES run the capture sequence', async () => {
    captureFullResFrameMock.mockResolvedValue({
      bitmap: { close: vi.fn() } as unknown as ImageBitmap,
      width: 3000,
      height: 4000,
    });

    render(<ScannerScreen />);
    fireEvent.click(screen.getByTestId('open-scanner'));

    const captureButton = await screen.findByTestId('capture-button');
    fireEvent.click(captureButton);

    await waitFor(() => {
      expect(captureFullResFrameMock).toHaveBeenCalledTimes(1);
    });
  });
});
