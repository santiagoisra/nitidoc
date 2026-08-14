import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fase 2.3 (capture-ux-redesign.md, Unit 3) unit tests for `CaptureScreen` —
 * the full-bleed, persistent capture screen. Covers the design brief's own
 * test list: "renders FAB/Next/count badge; Next gated on ≥1 capture;
 * in-flight guard; no-camera variant; cap disables capture."
 *
 * `CaptureScreen` receives `openCamera`/`switchCamera`/`setTorch` as PROPS
 * (the same `useCamera()` hook instance `ScannerScreen` owns) rather than
 * calling `useCamera()` itself — see that component's doc comment — so this
 * suite passes plain `vi.fn()` stubs instead of mocking `useCamera`.
 */

const materializeRawCaptureMock = vi.fn();
let isAtCapValue = false;

vi.mock('@/features/scanner/hooks/useActivePage', () => ({
  useActivePage: () => ({
    materializeRawCapture: materializeRawCaptureMock,
    isAtCap: isAtCapValue,
  }),
}));

const captureFullResFrameMock = vi.fn();
vi.mock('@/features/scanner/lib/captureFrame', () => ({
  captureFullResFrame: (...args: unknown[]) => captureFullResFrameMock(...args),
}));

const decodeImportedFileMock = vi.fn();

vi.mock('@/features/scanner/lib/captureFallback', async () => {
  const actual = await vi.importActual<typeof import('@/features/scanner/lib/captureFallback')>(
    '@/features/scanner/lib/captureFallback',
  );
  return {
    ...actual,
    decodeImportedFile: (...args: unknown[]) => decodeImportedFileMock(...args),
  };
});

// Mirrors the pattern used by the ScannerScreen test suite: a mocked
// CameraView that just forwards a bare <video> ref, so happy-dom never has
// to run the real srcObject-binding effect against a fake MediaStream.
vi.mock('@/features/scanner/components/CameraView', () => ({
  CameraView: forwardRef<HTMLVideoElement, { overlay?: unknown; fill?: boolean }>((_props, ref) =>
    createElement('video', { ref, 'data-testid': 'camera-view-video' }),
  ),
}));

import { CaptureScreen } from '@/features/scanner/components/CaptureScreen';
import { ToastHost } from '@/shared/ui';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { createInitialRecipe } from '@/features/scanner/lib/editRecipe';
import { paperSelection } from '@/features/scanner/lib/paperFormats';
import type { DocumentPage, RawCapture } from '@/features/scanner/store/documentSlice';
import type { Quad } from '@/shared/types/geometry';

function fakeBitmap(width = 3000, height = 4000): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function fakeRaw(id: string, order: number): RawCapture {
  return {
    id,
    order,
    originalBlob: {} as Blob,
    thumbnail: fakeBitmap(150, 200),
    originalWidth: 1000,
    originalHeight: 1400,
    paper: paperSelection('a4', 'manual'),
  };
}

const PAGE_CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

/** Confirmed-page fixture for the bug 5 regression tests below (mirrors `documentSlice.test.ts`/`useActivePage.test.ts`'s own `fakePage` convention). */
function fakePage(overrides: Partial<DocumentPage> = {}): DocumentPage {
  return {
    id: overrides.id ?? 'page-1',
    order: overrides.order ?? 0,
    recipe: overrides.recipe ?? createInitialRecipe(PAGE_CORNERS, 'a4'),
    thumbnail: overrides.thumbnail ?? fakeBitmap(150, 200),
    originalBlob: overrides.originalBlob ?? ({} as Blob),
    warpedBlob: overrides.warpedBlob ?? ({} as Blob),
    originalWidth: overrides.originalWidth ?? 1000,
    originalHeight: overrides.originalHeight ?? 1400,
    warpedWidth: overrides.warpedWidth ?? 800,
    warpedHeight: overrides.warpedHeight ?? 1200,
  };
}

function createFakeStream(): MediaStream {
  const track = { stop: vi.fn(), getSettings: () => ({}) } as unknown as MediaStreamTrack;
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

function renderCaptureScreen(props: Partial<{
  openCamera: () => Promise<void>;
  switchCamera: () => Promise<void>;
  setTorch: () => Promise<void>;
  onBack: () => void;
}> = {}) {
  return render(
    <ToastHost>
      <CaptureScreen
        openCamera={props.openCamera ?? vi.fn(async () => {})}
        switchCamera={props.switchCamera ?? vi.fn(async () => {})}
        setTorch={props.setTorch ?? vi.fn(async () => {})}
        onBack={props.onBack ?? vi.fn()}
      />
    </ToastHost>,
  );
}

describe('CaptureScreen (Fase 2.3, capture-ux-redesign.md, Unit 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAtCapValue = false;
    materializeRawCaptureMock.mockResolvedValue({ status: 'added' });
    useScannerStore.setState({
      ...scannerStoreInitialState,
      permission: 'granted',
      devices: [{ deviceId: 'a' } as MediaDeviceInfo],
      stream: createFakeStream(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the capture button; Next is hidden with zero captures', () => {
    renderCaptureScreen();

    expect(screen.getByTestId('capture-screen')).toBeTruthy();
    expect(screen.getByTestId('capture-button')).toBeTruthy();
    expect(screen.queryByTestId('capture-next')).toBeNull();
    expect(screen.queryByTestId('capture-count-thumbnail')).toBeNull();
  });

  it('Next appears once rawCaptures.length > 0, and shows the count badge', () => {
    useScannerStore.setState({ rawCaptures: [fakeRaw('r1', 0)] });
    renderCaptureScreen();

    expect(screen.getByTestId('capture-next')).toBeTruthy();
    expect(screen.getByTestId('capture-count-badge').textContent).toBe('1');
  });

  it('Next sets phase to "processing"', () => {
    useScannerStore.setState({ rawCaptures: [fakeRaw('r1', 0)] });
    renderCaptureScreen();

    fireEvent.click(screen.getByTestId('capture-next'));
    expect(useScannerStore.getState().phase).toBe('processing');
  });

  it('persists the capped full-source bitmap without preview cropping, staying in "capturing"', async () => {
    useScannerStore.setState({ phase: 'capturing' });
    const rawBitmap = fakeBitmap(3000, 4000);
    captureFullResFrameMock.mockResolvedValue({ bitmap: rawBitmap, width: 3000, height: 4000 });

    renderCaptureScreen();
    fireEvent.click(screen.getByTestId('capture-button'));

    await waitFor(() => {
      expect(materializeRawCaptureMock).toHaveBeenCalledTimes(1);
    });

    expect(captureFullResFrameMock).toHaveBeenCalledTimes(1);
    expect(materializeRawCaptureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        originalBitmap: rawBitmap,
        originalWidth: rawBitmap.width,
        paper: expect.objectContaining({ alias: 'a4', source: 'manual' }),
        originalHeight: rawBitmap.height,
      }),
    );
    expect(useScannerStore.getState().phase).toBe('capturing');
  });

  it('in-flight guard: a second tap while a capture is still resolving does not call captureFullResFrame again', async () => {
    let resolveCapture: ((value: { bitmap: ImageBitmap; width: number; height: number }) => void) | undefined;
    captureFullResFrameMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );

    renderCaptureScreen();
    const button = screen.getByTestId('capture-button');

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(captureFullResFrameMock).toHaveBeenCalledTimes(1);
    });

    // Resolve the in-flight capture and let materializeRawCapture settle.
    await act(async () => {
      resolveCapture?.({ bitmap: fakeBitmap(), width: 100, height: 100 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(captureFullResFrameMock).toHaveBeenCalledTimes(1);
  });

  it('queues a Next tapped mid-capture instead of dropping it, and honours it once the capture lands', async () => {
    let resolveCapture: ((value: { bitmap: ImageBitmap; width: number; height: number }) => void) | undefined;
    captureFullResFrameMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    useScannerStore.setState({ rawCaptures: [fakeRaw('r1', 0)] });

    renderCaptureScreen();
    fireEvent.click(screen.getByTestId('capture-button'));

    // capture-latency (bug 5): the button must stay TAPPABLE during a capture.
    // Disabling it swallowed the event outright, so on a slow device the user
    // tapped, nothing happened, and the app read as broken rather than busy.
    expect((screen.getByTestId('capture-next') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('capture-next'));

    // Still must not transition YET: `useBatchProcess` snapshots
    // `rawCaptures`, so advancing now would silently drop the capture that is
    // still materializing.
    expect(useScannerStore.getState().phase).not.toBe('processing');

    await act(async () => {
      resolveCapture?.({ bitmap: fakeBitmap(), width: 100, height: 100 });
      await Promise.resolve();
      await Promise.resolve();
    });

    // ...and the queued intent is honoured the moment the capture is safely in
    // the store — without the user having to tap a second time.
    expect(useScannerStore.getState().phase).toBe('processing');
  });

  it('cap disables the capture button', () => {
    isAtCapValue = true;
    renderCaptureScreen();

    const button = screen.getByTestId('capture-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('capture-cap-hint').textContent).toContain(String(FILTER.PAGE_CAP));
  });

  it('a capture failure shows a toast and stays in "capturing" (never strands the user)', async () => {
    captureFullResFrameMock.mockRejectedValue(new Error('boom'));
    renderCaptureScreen();

    fireEvent.click(screen.getByTestId('capture-button'));

    await waitFor(() => {
      expect(screen.getByTestId('toast-host').textContent).toContain('Could not capture the page');
    });
    expect(useScannerStore.getState().rawCaptures).toHaveLength(0);
  });

  it('retake-last removes the last raw capture', () => {
    useScannerStore.setState({ rawCaptures: [fakeRaw('r1', 0), fakeRaw('r2', 1)] });
    renderCaptureScreen();

    fireEvent.click(screen.getByTestId('capture-count-retake-last'));
    expect(useScannerStore.getState().rawCaptures).toHaveLength(1);
    expect(useScannerStore.getState().rawCaptures[0]?.id).toBe('r1');
  });

  describe('bug 5 fix: camera count reflects existing pages on "Capturar más" re-entry', () => {
    it('counts already-confirmed pages even though rawCaptures was cleared by the batch step', () => {
      // Mirrors `useBatchProcess.run()`'s end state: `rawCaptures` is empty
      // again (cleared into `pages`) once the user re-enters 'capturing' via
      // grid/adjust "Capturar más" — the counter must not drop to 0.
      useScannerStore.setState({ pages: [fakePage({ id: 'p1' })], rawCaptures: [] });
      renderCaptureScreen();

      expect(screen.getByTestId('capture-count-badge').textContent).toBe('1');
      expect(screen.getByTestId('capture-count-thumbnail')).toBeTruthy();
    });

    it('sums pages.length + rawCaptures.length once new shots accumulate on top of existing pages', () => {
      useScannerStore.setState({
        pages: [fakePage({ id: 'p1' }), fakePage({ id: 'p2', order: 1 })],
        rawCaptures: [fakeRaw('r1', 0)],
      });
      renderCaptureScreen();

      expect(screen.getByTestId('capture-count-badge').textContent).toBe('3');
    });

    it('prefers the newest raw-capture thumbnail over the last page thumbnail when both exist', () => {
      const drawImageSpy = vi.fn();
      const getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ drawImage: drawImageSpy, clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);

      const pageThumb = fakeBitmap(150, 200);
      const rawThumb = fakeBitmap(150, 200);
      useScannerStore.setState({
        pages: [fakePage({ id: 'p1', thumbnail: pageThumb })],
        rawCaptures: [{ ...fakeRaw('r1', 0), thumbnail: rawThumb }],
      });

      renderCaptureScreen();

      expect(screen.getByTestId('capture-count-badge').textContent).toBe('2');
      expect(drawImageSpy.mock.calls[0]?.[0]).toBe(rawThumb);

      getContextSpy.mockRestore();
    });

    it('falls back to the last page thumbnail when rawCaptures is empty', () => {
      const drawImageSpy = vi.fn();
      const getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ drawImage: drawImageSpy, clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);

      const lastPageThumb = fakeBitmap(150, 200);
      useScannerStore.setState({
        pages: [fakePage({ id: 'p1' }), fakePage({ id: 'p2', order: 1, thumbnail: lastPageThumb })],
        rawCaptures: [],
      });

      renderCaptureScreen();

      expect(drawImageSpy.mock.calls[0]?.[0]).toBe(lastPageThumb);

      getContextSpy.mockRestore();
    });
  });

  describe('no-camera variant (phase-gating decouple)', () => {
    it('permission denied: renders ImportFallback, never mounts a live CameraView', () => {
      useScannerStore.setState({ permission: 'denied' });
      renderCaptureScreen();

      expect(screen.getByTestId('capture-screen-no-camera')).toBeTruthy();
      expect(screen.queryByTestId('capture-screen')).toBeNull();
      expect(screen.queryByTestId('camera-view-video')).toBeNull();
      expect(screen.getByTestId('import-fallback')).toBeTruthy();
      expect(screen.getByTestId('permission-denied-instructions')).toBeTruthy();
    });

    it('no devices: renders the no-camera ImportFallback copy', () => {
      useScannerStore.setState({ devices: [] });
      renderCaptureScreen();

      expect(screen.getByTestId('capture-screen-no-camera')).toBeTruthy();
      expect(screen.getByTestId('no-camera-instructions')).toBeTruthy();
    });

    it('a camera error: renders the no-camera variant with a visible error', () => {
      useScannerStore.setState({ lastCameraError: 'NotReadableError' });
      renderCaptureScreen();

      expect(screen.getByTestId('capture-screen-no-camera')).toBeTruthy();
      expect(screen.getByTestId('camera-error')).toBeTruthy();
    });

    it('"Import another" decodes the file and materializes a raw capture (no DETECT, no CornerEditor)', async () => {
      useScannerStore.setState({ permission: 'denied' });
      const decodedBitmap = fakeBitmap(1200, 900);
      decodeImportedFileMock.mockResolvedValue({ bitmap: decodedBitmap, width: 1200, height: 900 });

      renderCaptureScreen();
      const input = screen.getByTestId('import-fallback-input') as HTMLInputElement;
      const file = new File([new Uint8Array([1, 2, 3])], 'doc.png', { type: 'image/png' });

      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(decodeImportedFileMock).toHaveBeenCalledTimes(1);
      expect(materializeRawCaptureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          originalBitmap: decodedBitmap,
          originalWidth: 1200,
          originalHeight: 900,
          paper: expect.objectContaining({ alias: 'a4', source: 'manual' }),
        }),
      );
      // Stays on the no-camera variant — the OLD DETECT/CornerEditor pipeline
      // is gone; this is now purely the lightweight raw-capture pipeline.
      expect(screen.queryByTestId('corner-editor')).toBeNull();
    });

    it('shows accumulated raw captures + "Siguiente" even without a camera', () => {
      useScannerStore.setState({ permission: 'denied', rawCaptures: [fakeRaw('r1', 0)] });
      renderCaptureScreen();

      expect(screen.getByTestId('capture-raw-thumb-r1')).toBeTruthy();
      expect(screen.getByTestId('capture-next')).toBeTruthy();
    });
  });
});
