import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quad } from '@/shared/types/geometry';

/**
 * Regression: `workerClient.detect` TRANSFERS (detaches) the downscaled
 * detection bitmap to the worker, after which `detectionBitmap.width` reads 0.
 * The import path used to read that width AFTER the detect() call and feed the
 * 0 to `scaleCornersToFullRes`, which threw — so a perfectly good detection was
 * swallowed and the editor fell back to frame-complete corners. The fix captures
 * the width BEFORE the transfer. This test simulates the detach (detect sets the
 * bitmap width to 0) and asserts the editor still receives the SCALED detected
 * corners rather than a null pre-seed.
 */

// ensureOpenCvInit resolves immediately so the import path reaches DETECT.
const ensureOpenCvInitMock = vi.fn(async () => {});

// Capture the corners the editor is seeded with.
let capturedInitialCorners: Quad | null | undefined;

vi.mock('@/features/scanner/hooks/useCamera', () => ({
  useCamera: () => ({
    openCamera: vi.fn(async () => {}),
    switchCamera: vi.fn(async () => {}),
    setTorch: vi.fn(async () => {}),
  }),
}));

// DETECT returns real corners AND detaches the bitmap (width -> 0), exactly like
// a real transferring postMessage would.
const detectMock = vi.fn(async (bitmap: { width: number }) => {
  bitmap.width = 0;
  return {
    id: 1,
    type: 'DETECT_RESULT' as const,
    corners: [
      { x: 85, y: 107 },
      { x: 554, y: 107 },
      { x: 554, y: 746 },
      { x: 85, y: 746 },
    ] as Quad,
    quality: null,
  };
});

vi.mock('@/features/scanner/hooks/useDocumentDetection', () => ({
  useDocumentDetection: () => ({
    start: vi.fn(),
    stop: vi.fn(),
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
    ensureOpenCvInit: ensureOpenCvInitMock,
  }),
}));

vi.mock('@/features/scanner/components/CameraView', () => ({
  CameraView: forwardRef<HTMLVideoElement, { overlay?: unknown }>((_props, ref) =>
    createElement('video', { ref, 'data-testid': 'camera-view-video' }),
  ),
}));

// Stub the editor and record the `initialCorners` prop it is handed.
vi.mock('@/features/scanner/components/CornerEditor', () => ({
  CornerEditor: (props: { initialCorners: Quad | null }) => {
    capturedInitialCorners = props.initialCorners;
    return createElement('div', { 'data-testid': 'corner-editor' });
  },
}));

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

describe('ScannerScreen import DETECT survives the bitmap being detached on transfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedInitialCorners = undefined;
    useScannerStore.setState({
      ...scannerStoreInitialState,
      permission: 'denied',
      offscreenSupported: true,
    });
    // The downscaled detection bitmap: width 640 UNTIL detect() detaches it.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() }) as unknown as ImageBitmap),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it('seeds the editor with the SCALED detected corners, not a frame-complete fallback', async () => {
    render(
      <ToastHost>
        <ScannerScreen />
      </ToastHost>,
    );
    fireEvent.click(screen.getByTestId('open-scanner'));

    const input = screen.getByTestId('import-fallback-input') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'doc.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(useScannerStore.getState().phase).toBe('editing-corners');
    expect(detectMock).toHaveBeenCalledTimes(1);

    // The editor was seeded with a real convex quad (scaled to full-res), NOT
    // null. Against the pre-fix code (reading the detached width = 0), the scale
    // helper threw and this would be null. Scaled by 1200/640 = 1.875.
    expect(capturedInitialCorners).not.toBeNull();
    expect(capturedInitialCorners).toHaveLength(4);
    const tl = capturedInitialCorners?.[0];
    expect(tl?.x).toBeCloseTo(85 * (1200 / 640), 0);
    expect(tl?.y).toBeCloseTo(107 * (1200 / 640), 0);
  });
});
