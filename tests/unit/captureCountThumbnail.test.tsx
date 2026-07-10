import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureCountThumbnail } from '@/features/scanner/components/CaptureCountThumbnail';

/**
 * Fase 2.3 (capture-ux-redesign.md, Unit 3) unit tests for
 * `CaptureCountThumbnail` — the bottom-bar capture-count tile. Mirrors
 * `captureTray.test.tsx`'s canvas-shim pattern (D6, thumbnail-only draw).
 */

function makeBitmap(width = 150, height = 200): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

const drawImageSpy = vi.fn();

function installCanvasShims(): void {
  drawImageSpy.mockClear();
  const fakeCtx = { drawImage: drawImageSpy, clearRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
}

describe('CaptureCountThumbnail (Fase 2.3, capture-ux-redesign.md, Unit 3)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing at count <= 0', () => {
    installCanvasShims();
    const { container } = render(
      <CaptureCountThumbnail count={0} lastThumbnail={null} onRetakeLast={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows the count badge (aria-live) once count > 0', () => {
    installCanvasShims();
    render(<CaptureCountThumbnail count={3} lastThumbnail={null} onRetakeLast={vi.fn()} />);

    const badge = screen.getByTestId('capture-count-badge');
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-live')).toBe('polite');
  });

  it('draws the last thumbnail via drawImage when provided (D6, never decodes a Blob)', () => {
    installCanvasShims();
    const thumb = makeBitmap();
    render(<CaptureCountThumbnail count={1} lastThumbnail={thumb} onRetakeLast={vi.fn()} />);

    expect(screen.getByTestId('capture-count-canvas')).toBeTruthy();
    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    expect(drawImageSpy.mock.calls[0]?.[0]).toBe(thumb);
  });

  it('renders the badge without a canvas while the first capture is still in flight (no thumbnail yet)', () => {
    installCanvasShims();
    render(<CaptureCountThumbnail count={1} lastThumbnail={null} onRetakeLast={vi.fn()} />);

    expect(screen.getByTestId('capture-count-badge').textContent).toBe('1');
    expect(screen.queryByTestId('capture-count-canvas')).toBeNull();
    expect(drawImageSpy).not.toHaveBeenCalled();
  });

  it('retake-last button calls onRetakeLast', () => {
    installCanvasShims();
    const onRetakeLast = vi.fn();
    render(<CaptureCountThumbnail count={2} lastThumbnail={makeBitmap()} onRetakeLast={onRetakeLast} />);

    fireEvent.click(screen.getByTestId('capture-count-retake-last'));
    expect(onRetakeLast).toHaveBeenCalledTimes(1);
  });
});
