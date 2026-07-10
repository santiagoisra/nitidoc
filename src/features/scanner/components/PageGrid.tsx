/**
 * Reorderable page grid (design section 5.3, spec `document` Req "Grilla de
 * paginas con reorder"; Group 5 / PR8). Lazy-loaded feature boundary
 * (`React.lazy(() => import('./PageGrid'))` in `ScannerScreen`) so
 * `@dnd-kit` stays OUT of the initial bundle (F1's <200KB gzip budget,
 * design section 8). Replaces the inline `page-grid-placeholder`
 * `ScannerScreen` rendered before this PR.
 *
 * Renders every page ordered by `order` using its cached thumbnail (no
 * full-res recompute — D6). Tap a tile -> `onActivatePage` (caller wires
 * this into `useActivePage.activatePage`, design section 2.2). Trash icon ->
 * `onDeletePage` (Group 6 replaces the wired handler with
 * `usePageDeletion` + undo toast; for now the caller wires a minimal
 * `DocumentSlice.deletePage`). Drag-and-drop reorder -> `onDragEnd` computes
 * the FULL new id order and calls `onReorder` (spec scenario "Reorder por
 * drag-and-drop" — no partial patch, so `DocumentSlice.reorderPages` can
 * re-index densely).
 */

import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import type { DragEndEvent } from '@dnd-kit/core';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/shared/ui';
import { PageThumbnail } from '@/features/scanner/components/CaptureTray';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

export interface PageGridProps {
  readonly pages: readonly DocumentPage[];
  readonly onActivatePage: (pageId: string) => void;
  readonly onDeletePage: (pageId: string) => void;
  /** onDragEnd hands the FULL new id order to the caller (spec scenario "Reorder por drag-and-drop"). */
  readonly onReorder: (orderedIds: readonly string[]) => void;
  readonly onCaptureMore: () => void;
  readonly onFinish: () => void;
}

/**
 * Pure reorder computation: moves `activeId` to the position `overId`
 * currently occupies, returning the FULL new id array (never a partial
 * patch). Returns the SAME array reference when either id is missing or
 * they are already equal, so callers can cheaply detect a no-op drag.
 */
export function reorderIds(
  ids: readonly string[],
  activeId: string,
  overId: string,
): readonly string[] {
  const oldIndex = ids.indexOf(activeId);
  const newIndex = ids.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
    return ids;
  }
  const next = [...ids];
  // Non-null: `oldIndex` was already validated against `ids` above, so
  // `splice` always removes exactly one element here.
  const [moved] = next.splice(oldIndex, 1) as [string];
  next.splice(newIndex, 0, moved);
  return next;
}

export function PageGrid({
  pages,
  onActivatePage,
  onDeletePage,
  onReorder,
  onCaptureMore,
  onFinish,
}: PageGridProps): ReactNode {
  const sensors = useSensors(useSensor(PointerSensor));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const ids = pages.map((page) => page.id);
      const next = reorderIds(ids, String(active.id), String(over.id));
      if (next !== ids) {
        onReorder(next);
      }
    },
    [pages, onReorder],
  );

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="page-grid">
      <p className="text-sm text-text-muted">
        {pages.length} page{pages.length === 1 ? '' : 's'} captured.
      </p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={pages.map((page) => page.id)} strategy={rectSortingStrategy}>
          <ul className="grid w-full grid-cols-3 gap-3" data-testid="page-grid-list">
            {pages.map((page) => (
              <SortableGridItem
                key={page.id}
                page={page}
                onActivate={() => onActivatePage(page.id)}
                onDelete={() => onDeletePage(page.id)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <div className="flex w-full items-center justify-between gap-3">
        <Button type="button" variant="secondary" onClick={onCaptureMore} data-testid="grid-capture-more">
          Capture more
        </Button>
        <Button type="button" variant="primary" onClick={onFinish} data-testid="grid-finish">
          Finish
        </Button>
      </div>
    </div>
  );
}

// React.lazy requires a default export.
export default PageGrid;

interface SortableGridItemProps {
  readonly page: DocumentPage;
  readonly onActivate: () => void;
  readonly onDelete: () => void;
}

function SortableGridItem({ page, onActivate, onDelete }: SortableGridItemProps): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: page.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="relative"
      data-testid={`page-grid-item-${page.id}`}
    >
      <button
        type="button"
        onClick={onActivate}
        className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
        data-testid={`page-grid-activate-${page.id}`}
      >
        <PageThumbnail bitmap={page.thumbnail} testId={`page-grid-thumb-${page.id}`} />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        aria-label="Delete page"
        className="absolute right-1 top-1 rounded-full bg-bg/80 p-1 text-danger"
        data-testid={`page-grid-delete-${page.id}`}
      >
        <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </li>
  );
}
