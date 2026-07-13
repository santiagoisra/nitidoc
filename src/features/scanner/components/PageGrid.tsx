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
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 5):
 *  - Empty state: `pages.length === 0` (every captured page skipped by the
 *    processing fallback or all deleted) renders a "Capturar" CTA instead of
 *    an empty/dead grid — reuses the same `onCaptureMore` -> `'capturing'`
 *    transition the populated grid's own button already wires.
 *  - `needsReview` badge: a tile whose page has `needsReview` (Unit 4's
 *    detect-fallback flag) shows a small badge so the user knows to
 *    double-check that page's corners before finishing.
 */

import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { DragEndEvent } from '@dnd-kit/core';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { PageThumbnail } from '@/features/scanner/components/PageThumbnail';
import { useExportPdf } from '@/features/scanner/hooks/useExportPdf';
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
  const { t } = useTranslation();
  // A bare `PointerSensor` with no activation constraint starts a drag on the
  // very first pointerdown anywhere on the tile — which captures the pointer
  // and SWALLOWS the `click` on the inner "tap-to-review" and trash buttons
  // (the reported "'Revisar' only tapped 1-in-100" + "delete never works"
  // bugs). Splitting into a MouseSensor with an 8px distance threshold (a tap
  // that never moves 8px is a click, not a drag) and a TouchSensor with a
  // 200ms long-press delay (a quick tap is a click; a short swipe scrolls the
  // grid; only a deliberate press-and-hold starts a reorder drag) makes both
  // inner buttons reliably tappable while keeping drag-to-reorder.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const { exporting, exportPdf } = useExportPdf();

  const handleExportPdf = useCallback(() => {
    exportPdf(pages);
  }, [exportPdf, pages]);

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

  if (pages.length === 0) {
    // Unit 5 "Empty-state PageGrid": nothing to reorder/export/finish yet
    // (every raw capture was skipped by the processing fallback, or every
    // page since deleted) — a dead grid (0 tiles, disabled export, a
    // pointless "Finish") is worse than routing straight back to capture.
    return (
      <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="page-grid-empty">
        <Button type="button" variant="primary" onClick={onCaptureMore} data-testid="grid-empty-cta">
          {t('grid.emptyCta')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="page-grid">
      <p className="text-sm text-text-muted">
        {t('grid.pagesCaptured', { n: pages.length })}
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
          {t('grid.captureMore')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={handleExportPdf}
          disabled={pages.length === 0 || exporting}
          data-testid="grid-export-pdf"
        >
          {exporting ? t('scanner.exporting') : t('scanner.exportPdf')}
        </Button>
        <Button type="button" variant="primary" onClick={onFinish} data-testid="grid-finish">
          {t('grid.finish')}
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
  const { t } = useTranslation();
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
        <PageThumbnail
          bitmap={page.thumbnail}
          filter={page.recipe.filter}
          testId={`page-grid-thumb-${page.id}`}
        />
      </button>
      {/* Action buttons, stacked in the top-right corner: edit above trash
          (bug 4b). The old illegible "Revisar" text-over-image badge is gone —
          a page that needs review now shows an AMBER edit button + alert dot,
          so the SAME control both signals "check this one" and opens the
          editor (the whole-tile tap still works as a shortcut). Both buttons
          stop the sensor activation events so a press never starts a reorder
          drag (same belt-and-suspenders as the trash button always had). */}
      <div className="absolute right-1 top-1 flex flex-col gap-1">
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onActivate();
          }}
          aria-label={page.needsReview ? t('grid.needsReview') : t('grid.editPage')}
          className={`relative flex h-9 w-9 items-center justify-center rounded-full bg-bg/80 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light ${
            page.needsReview ? 'text-warning' : 'text-primary-light'
          }`}
          data-testid={`page-grid-edit-${page.id}`}
        >
          <Pencil size={17} strokeWidth={1.5} aria-hidden="true" />
          {page.needsReview && (
            <span
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-bg"
              data-testid={`page-grid-review-dot-${page.id}`}
              aria-hidden="true"
            />
          )}
        </button>
        <button
          type="button"
          // Stop the sensor activation events from reaching the sortable drag
          // listeners spread on the <li>, so a press on the trash icon can never
          // start a reorder drag — the click then fires cleanly (belt-and-
          // suspenders alongside the sensor activation constraints above).
          // dnd-kit's MouseSensor activates on `mousedown` and TouchSensor on
          // `touchstart`, so those are the events to stop — a `pointerdown`
          // handler would NOT block them (pointer events dispatch separately).
          onMouseDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          aria-label={t('grid.deletePage')}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-bg/80 text-danger shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
          data-testid={`page-grid-delete-${page.id}`}
        >
          <Trash2 size={18} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
