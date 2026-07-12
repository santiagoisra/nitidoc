import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from '@/shared/ui';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import { NEUTRAL_FILTER } from '@/shared/types/scanner';

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
  MouseSensor: class {},
  TouchSensor: class {},
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

/** Captures the `ctx.filter` value in effect AT drawImage-call time (it is reset to 'none' right after). */
const drawnFilters: string[] = [];
let currentCtxFilter = 'none';
const drawImageSpy = vi.fn((..._args: unknown[]) => {
  drawnFilters.push(currentCtxFilter);
});

function installCanvasShims(): void {
  currentCtxFilter = 'none';
  drawnFilters.length = 0;
  const fakeCtx = {
    drawImage: drawImageSpy,
    clearRect: vi.fn(),
    get filter() {
      return currentCtxFilter;
    },
    set filter(value: string) {
      currentCtxFilter = value;
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
}

import { PageGrid, reorderIds } from '@/features/scanner/components/PageGrid';

function makeBitmap(width = 150, height = 200): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function makePage(id: string, order: number, filter = NEUTRAL_FILTER): DocumentPage {
  return {
    id,
    order,
    recipe: { ...({} as DocumentPage['recipe']), filter },
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
      <ToastHost>
        <PageGrid
          pages={pages}
          onActivatePage={vi.fn()}
          onDeletePage={vi.fn()}
          onReorder={onReorder}
          onCaptureMore={vi.fn()}
          onFinish={vi.fn()}
        />
      </ToastHost>,
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
      <ToastHost>
        <PageGrid
          pages={pages}
          onActivatePage={vi.fn()}
          onDeletePage={vi.fn()}
          onReorder={onReorder}
          onCaptureMore={vi.fn()}
          onFinish={vi.fn()}
        />
      </ToastHost>,
    );

    capturedOnDragEnd?.({ active: { id: 'p1' }, over: null });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('tapping a tile activates the page (design section 5.3, tap-to-activate)', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0), makePage('p2', 1)];
    const onActivatePage = vi.fn();

    render(
      <ToastHost>
        <PageGrid
          pages={pages}
          onActivatePage={onActivatePage}
          onDeletePage={vi.fn()}
          onReorder={vi.fn()}
          onCaptureMore={vi.fn()}
          onFinish={vi.fn()}
        />
      </ToastHost>,
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
      <ToastHost>
        <PageGrid
          pages={pages}
          onActivatePage={onActivatePage}
          onDeletePage={onDeletePage}
          onReorder={vi.fn()}
          onCaptureMore={vi.fn()}
          onFinish={vi.fn()}
        />
      </ToastHost>,
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
      <ToastHost>
        <PageGrid
          pages={pages}
          onActivatePage={vi.fn()}
          onDeletePage={vi.fn()}
          onReorder={vi.fn()}
          onCaptureMore={onCaptureMore}
          onFinish={onFinish}
        />
      </ToastHost>,
    );

    fireEvent.click(screen.getByTestId('grid-capture-more'));
    fireEvent.click(screen.getByTestId('grid-finish'));
    expect(onCaptureMore).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('applies each page recipe.filter to its grid tile thumbnail (Fase 2.1 item 3, shared PageThumbnail)', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0, { ...NEUTRAL_FILTER, preset: 'grayscale' })];

    render(
      <ToastHost>
        <PageGrid
          pages={pages}
          onActivatePage={vi.fn()}
          onDeletePage={vi.fn()}
          onReorder={vi.fn()}
          onCaptureMore={vi.fn()}
          onFinish={vi.fn()}
        />
      </ToastHost>,
    );

    // PageGrid reuses `PageThumbnail`, which draws with the page's filter
    // applied as a `ctx.filter` CSS string — 'grayscale' is CSS-routable, so
    // a real `grayscale()` filter must be visible at drawImage-call time (it
    // is reset to 'none' immediately afterward).
    expect(drawnFilters[0]).toContain('grayscale(1)');
  });

  it('empty state (Fase 2.3, Unit 5): 0 pages renders a "Capturar" CTA instead of a dead grid', () => {
    const onCaptureMore = vi.fn();
    const onFinish = vi.fn();

    render(
      <ToastHost>
        <PageGrid
          pages={[]}
          onActivatePage={vi.fn()}
          onDeletePage={vi.fn()}
          onReorder={vi.fn()}
          onCaptureMore={onCaptureMore}
          onFinish={onFinish}
        />
      </ToastHost>,
    );

    expect(screen.getByTestId('page-grid-empty')).toBeTruthy();
    expect(screen.queryByTestId('page-grid-list')).toBeNull();
    expect(screen.queryByTestId('grid-finish')).toBeNull();

    fireEvent.click(screen.getByTestId('grid-empty-cta'));
    expect(onCaptureMore).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('shows a needsReview badge only on tiles whose page has needsReview set (Fase 2.3, Unit 5)', () => {
    installCanvasShims();
    const pages = [
      { ...makePage('p1', 0), needsReview: true },
      makePage('p2', 1),
    ];

    render(
      <ToastHost>
        <PageGrid
          pages={pages}
          onActivatePage={vi.fn()}
          onDeletePage={vi.fn()}
          onReorder={vi.fn()}
          onCaptureMore={vi.fn()}
          onFinish={vi.fn()}
        />
      </ToastHost>,
    );

    expect(screen.getByTestId('page-grid-review-badge-p1')).toBeTruthy();
    expect(screen.queryByTestId('page-grid-review-badge-p2')).toBeNull();
  });
});
