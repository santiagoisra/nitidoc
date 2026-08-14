import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CropOverlay } from '@/features/scanner/components/CropOverlay';
import type { Quad } from '@/shared/types/geometry';

/**
 * Work Unit 1 (inline auto-crop) — focused coverage for the extracted,
 * bitmap-agnostic `CropOverlay`. `CornerEditor`'s own pointer-drag / warp
 * behavior stays covered end-to-end by `tests/unit/cornerEditorWarp.test.tsx`
 * (unchanged by this extraction, still green). These tests instead verify
 * `CropOverlay`'s OWN contract in isolation: it renders the 4 handles + the
 * quad polygon, reports drag moves via `onCornersChange` and drag start/end
 * via `onDragStateChange` WITHOUT deciding anything about warping itself,
 * and reflects the caller-supplied `valid` prop in handle/polygon color.
 *
 * happy-dom limits (honest note, mirrors cornerEditorWarp.test.tsx): happy-dom
 * has no real layout engine and no `ResizeObserver`, so `getBoundingClientRect`
 * is stubbed to a fixed box below rather than relying on actual CSS layout,
 * and the `ResizeObserver`-driven re-measure path in `setContainerRef` never
 * actually fires in this environment — only the synchronous initial
 * `measure()` call does (guarded by `typeof ResizeObserver !== 'undefined'`
 * in the component itself, so this is a silent no-op here, not a crash). The
 * canvas 2d context is stubbed too, since happy-dom doesn't implement one;
 * `createImageBitmap`/`ImageData` are NOT stubbed because, unlike
 * `CornerEditor`, `CropOverlay` never calls them (it doesn't warp).
 */

function installShims(): void {
  const fakeCtx = {
    drawImage: vi.fn(),
    clearRect: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
  // Chosen to EXACTLY match `WIDTH`/`HEIGHT` below (scale 1, zero offset), so
  // `toSourcePoint` reduces to a direct clientX/clientY -> source-point
  // identity mapping and the drag assertions can use plain expected coords.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 300,
    bottom: 400,
    width: 300,
    height: 400,
    toJSON: () => ({}),
  } as DOMRect);
}

function makeBitmap(): ImageBitmap {
  return { width: 300, height: 400, close: vi.fn() } as unknown as ImageBitmap;
}

const WIDTH = 300;
const HEIGHT = 400;

const CORNERS: Quad = [
  { x: 10, y: 10 },
  { x: 290, y: 10 },
  { x: 290, y: 390 },
  { x: 10, y: 390 },
];

/** happy-dom's pointer capture is a no-op on a detached-ish element; guard so the handlers under test still run (mirrors cornerEditorWarp.test.tsx). */
function armHandle(handle: HTMLElement): void {
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
}

describe('CropOverlay', () => {
  beforeEach(() => {
    installShims();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders 4 draggable corner handles', () => {
    render(
      <CropOverlay bitmap={makeBitmap()} width={WIDTH} height={HEIGHT} corners={CORNERS} onCornersChange={vi.fn()} />,
    );

    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`corner-handle-${i}`)).toBeInTheDocument();
    }
  });

  it('a pointerdown + pointermove + pointerup drag reports the moved quad via onCornersChange and start/end via onDragStateChange', () => {
    const onCornersChange = vi.fn();
    const onDragStateChange = vi.fn();
    render(
      <CropOverlay
        bitmap={makeBitmap()}
        width={WIDTH}
        height={HEIGHT}
        corners={CORNERS}
        onCornersChange={onCornersChange}
        onDragStateChange={onDragStateChange}
      />,
    );

    const handle = screen.getByTestId('corner-handle-0');
    armHandle(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40, clientY: 60 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 40, clientY: 60 });

    // The container box is stubbed to exactly match width/height (scale 1,
    // no offset), so the moved corner lands exactly at the pointer's client
    // coordinates; the other 3 corners are reported unchanged. CropOverlay
    // itself never decides whether this is convex or whether to warp — it
    // only reports the geometry.
    expect(onCornersChange).toHaveBeenCalledTimes(1);
    expect(onCornersChange).toHaveBeenCalledWith([{ x: 40, y: 60 }, CORNERS[1], CORNERS[2], CORNERS[3]]);

    // Drag start (true) then drag end (false) — exactly once each.
    expect(onDragStateChange.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it.each([
    ['top', { x: 50, y: 25 }, [{ x: 10, y: 25 }, { x: 90, y: 25 }, { x: 90, y: 90 }, { x: 10, y: 90 }]],
    ['right', { x: 75, y: 50 }, [{ x: 10, y: 10 }, { x: 75, y: 10 }, { x: 75, y: 90 }, { x: 10, y: 90 }]],
    ['bottom', { x: 50, y: 75 }, [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 75 }, { x: 10, y: 75 }]],
    ['left', { x: 25, y: 50 }, [{ x: 25, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 25, y: 90 }]],
  ] as const)('moves only the constrained %s edge pair', (side, point, expected) => {
    const onCornersChange = vi.fn();
    const onDragStateChange = vi.fn();
    const rectangularCorners: Quad = [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 90 },
      { x: 10, y: 90 },
    ];
    render(
      <CropOverlay
        bitmap={makeBitmap()}
        width={WIDTH}
        height={HEIGHT}
        corners={rectangularCorners}
        onCornersChange={onCornersChange}
        onDragStateChange={onDragStateChange}
      />,
    );

    const handle = screen.getByTestId(`crop-side-handle-${side}`);
    armHandle(handle);
    fireEvent.pointerDown(handle, { pointerId: 9, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(handle, { pointerId: 9, clientX: point.x, clientY: point.y });
    fireEvent.pointerUp(handle, { pointerId: 9, clientX: point.x, clientY: point.y });

    expect(onCornersChange).toHaveBeenLastCalledWith(expected);
    expect(onDragStateChange.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it('gives each side handle an accessible 44px Pointer Events target and ends its drag on cancellation', () => {
    const onDragStateChange = vi.fn();
    render(
      <CropOverlay
        bitmap={makeBitmap()}
        width={WIDTH}
        height={HEIGHT}
        corners={CORNERS}
        onCornersChange={vi.fn()}
        onDragStateChange={onDragStateChange}
      />,
    );

    for (const [side, label] of [
      ['top', 'Move top edge'],
      ['right', 'Move right edge'],
      ['bottom', 'Move bottom edge'],
      ['left', 'Move left edge'],
    ] as const) {
      const handle = screen.getByTestId(`crop-side-handle-${side}`);
      expect(handle).toHaveAccessibleName(label);
      expect(handle.style.width).toBe('44px');
      expect(handle.style.height).toBe('44px');
      expect(handle.style.touchAction).toBe('none');
    }

    const top = screen.getByTestId('crop-side-handle-top');
    armHandle(top);
    fireEvent.pointerDown(top, { pointerId: 8, clientX: 150, clientY: 10 });
    fireEvent.pointerCancel(top, { pointerId: 8, clientX: 150, clientY: 10 });

    expect(top.setPointerCapture).toHaveBeenCalledWith(8);
    expect(top.releasePointerCapture).toHaveBeenCalledWith(8);
    expect(onDragStateChange.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it('does not report a side drag that collapses the quad at the opposite edge', () => {
    const onCornersChange = vi.fn();
    const rectangularCorners: Quad = [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 90 },
      { x: 10, y: 90 },
    ];
    render(
      <CropOverlay
        bitmap={makeBitmap()}
        width={WIDTH}
        height={HEIGHT}
        corners={rectangularCorners}
        onCornersChange={onCornersChange}
      />,
    );

    const top = screen.getByTestId('crop-side-handle-top');
    armHandle(top);
    fireEvent.pointerDown(top, { pointerId: 10, clientX: 50, clientY: 10 });
    fireEvent.pointerMove(top, { pointerId: 10, clientX: 50, clientY: 90 });

    expect(onCornersChange).not.toHaveBeenCalled();
  });

  it('does not call onCornersChange for a bare tap (pointerdown + pointerup, no move)', () => {
    const onCornersChange = vi.fn();
    const onDragStateChange = vi.fn();
    render(
      <CropOverlay
        bitmap={makeBitmap()}
        width={WIDTH}
        height={HEIGHT}
        corners={CORNERS}
        onCornersChange={onCornersChange}
        onDragStateChange={onDragStateChange}
      />,
    );

    const handle = screen.getByTestId('corner-handle-0');
    armHandle(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 10 });

    // No pointermove happened, so no geometry change was ever reported —
    // it is the CALLER's job (CornerEditor) to skip a redundant warp here,
    // but CropOverlay's own contract is simply "no move, no report".
    expect(onCornersChange).not.toHaveBeenCalled();
    expect(onDragStateChange.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it('reflects the valid prop in handle and polygon color', () => {
    const { container, rerender } = render(
      <CropOverlay bitmap={makeBitmap()} width={WIDTH} height={HEIGHT} corners={CORNERS} onCornersChange={vi.fn()} valid />,
    );

    expect(screen.getByTestId('corner-handle-0')).toHaveClass('border-primary-light');
    expect(container.querySelector('polygon')).toHaveAttribute('stroke', 'var(--color-primary-light)');

    rerender(
      <CropOverlay
        bitmap={makeBitmap()}
        width={WIDTH}
        height={HEIGHT}
        corners={CORNERS}
        onCornersChange={vi.fn()}
        valid={false}
      />,
    );

    expect(screen.getByTestId('corner-handle-0')).toHaveClass('border-danger');
    expect(container.querySelector('polygon')).toHaveAttribute('stroke', 'var(--color-danger)');
  });

  it('defaults valid to true when the prop is omitted', () => {
    render(
      <CropOverlay bitmap={makeBitmap()} width={WIDTH} height={HEIGHT} corners={CORNERS} onCornersChange={vi.fn()} />,
    );

    expect(screen.getByTestId('corner-handle-0')).toHaveClass('border-primary-light');
  });
});
