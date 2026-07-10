import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

/**
 * Group 5 / PR8 unit tests for `PageGrid` (design section 5.3, spec
 * `document` "Grilla de paginas con reorder"). Covers task 5.7:
 *  - `onDragEnd` produces a dense 0..n-1 FULL id order (no partial patch),
 *    driven by invoking the REAL `onDragEnd` handler `PageGrid` wires into
 *    `<DndContext>` with a simulated `DragEndEvent` (mock active/over ids) —
 *    per the hard constraint, this test does not attempt to drive real
 *    pointer-based DnD in jsdom/happy-dom.
 *  - tapping a tile activates the page (`onActivatePage`).
 *
 * `@dnd-kit/core`/`@dnd-kit/sortable`/`@dnd-kit/utilities` are mocked so the
 * test can capture the `onDragEnd` prop `PageGrid` passes to `<DndContext>`
 * and invoke it directly, mirroring how `filterPanel.test.tsx` mocks
 * `workerClient`/`pageResources` to isolate the component under test.
 */

type DragEndHandler = (event: { active: { id: string }; over: { id: string } | null }) => void;

let capturedOnDragEnd: DragEndHandler | null = null;

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd: DragEndHandler }) => {
    capturedOnDragEnd = onDragEnd;
    return children;
  },
  PointerSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  rectSortingStrategy: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}));

const drawImageSpy = vi.fn();

function installCanvasShims(): void {
  const fakeCtx = { drawImage: drawImageSpy, clearRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
}

import { PageGrid, reorderIds } from '@/features/scanner/components/PageGrid';

function makeBitmap(width = 150, height = 200): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function makePage(id: string, order: number): DocumentPage {
  return {
    id,
    order,
    recipe: {} as DocumentPage['recipe'],
    thumbnail: makeBitmap(),
    originalBlob: {} as Blob,
    warpedBlob: {} as Blob,
    originalWidth: 1000,
    originalHeight: 1400,
    warpedWidth: 1000,
    warpedHeight: 1400,
  };
}

describe('PageGrid (Group 5 / PR8, design section 5.3)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    drawImageSpy.mockClear();
    capturedOnDragEnd = null;
  });

  it('reorderIds moves the active id to the over id position, returning the FULL order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const result = reorderIds(ids, 'e', 'a');
    expect(result).toEqual(['e', 'a', 'b', 'c', 'd']);
    // Dense, no gaps/dupes: same set of ids, same length.
    expect([...result].sort()).toEqual([...ids].sort());
  });

  it('reorderIds is a no-op (same reference) when active and over are equal', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorderIds(ids, 'b', 'b')).toBe(ids);
  });

  it('reorderIds is a no-op (same reference) when either id is missing', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorderIds(ids, 'z', 'b')).toBe(ids);
    expect(reorderIds(ids, 'a', 'z')).toBe(ids);
  });

  it('onDragEnd calls onReorder with the FULL dense id order (spec "Reorder por drag-and-drop")', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0), makePage('p2', 1), makePage('p3', 2), makePage('p4', 3), makePage('p5', 4)];
    const onReorder = vi.fn();

    render(
      <PageGrid
        pages={pages}
        onActivatePage={vi.fn()}
        onDeletePage={vi.fn()}
        onReorder={onReorder}
        onCaptureMore={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    expect(capturedOnDragEnd).not.toBeNull();
    // Drag the page at order 4 ('p5') onto the position occupied by order 0 ('p1').
    capturedOnDragEnd?.({ active: { id: 'p5' }, over: { id: 'p1' } });

    expect(onReorder).toHaveBeenCalledTimes(1);
    const orderedIds = onReorder.mock.calls[0]?.[0] as readonly string[];
    expect(orderedIds).toEqual(['p5', 'p1', 'p2', 'p3', 'p4']);
    // No gaps/dupes: the full original set, reordered.
    expect([...orderedIds].sort()).toEqual(pages.map((p) => p.id).sort());
  });

  it('onDragEnd is a no-op when there is no drop target (over is null)', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0), makePage('p2', 1)];
    const onReorder = vi.fn();

    render(
      <PageGrid
        pages={pages}
        onActivatePage={vi.fn()}
        onDeletePage={vi.fn()}
        onReorder={onReorder}
        onCaptureMore={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    capturedOnDragEnd?.({ active: { id: 'p1' }, over: null });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('tapping a tile activates the page (design section 5.3, tap-to-activate)', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0), makePage('p2', 1)];
    const onActivatePage = vi.fn();

    render(
      <PageGrid
        pages={pages}
        onActivatePage={onActivatePage}
        onDeletePage={vi.fn()}
        onReorder={vi.fn()}
        onCaptureMore={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('page-grid-activate-p2'));
    expect(onActivatePage).toHaveBeenCalledWith('p2');
    expect(onActivatePage).toHaveBeenCalledTimes(1);
  });

  it('the trash icon calls onDeletePage with the page id and does not also activate it', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0)];
    const onActivatePage = vi.fn();
    const onDeletePage = vi.fn();

    render(
      <PageGrid
        pages={pages}
        onActivatePage={onActivatePage}
        onDeletePage={onDeletePage}
        onReorder={vi.fn()}
        onCaptureMore={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('page-grid-delete-p1'));
    expect(onDeletePage).toHaveBeenCalledWith('p1');
    expect(onActivatePage).not.toHaveBeenCalled();
  });

  it('"Capture more" and "Finish" call their respective callbacks', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0)];
    const onCaptureMore = vi.fn();
    const onFinish = vi.fn();

    render(
      <PageGrid
        pages={pages}
        onActivatePage={vi.fn()}
        onDeletePage={vi.fn()}
        onReorder={vi.fn()}
        onCaptureMore={onCaptureMore}
        onFinish={onFinish}
      />,
    );

    fireEvent.click(screen.getByTestId('grid-capture-more'));
    fireEvent.click(screen.getByTestId('grid-finish'));
    expect(onCaptureMore).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
