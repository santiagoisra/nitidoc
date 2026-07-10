/**
 * Continuous-capture tray (design section 5.2, spec `document` Req "Bandeja
 * de captura continua"; Group 5 / PR8). Horizontal strip of the document's
 * already-cached ~150px thumbnails + a page counter + a "Done" button
 * (-> `ScannerScreen` flips `phase` to `'grid'`). NEVER renders full-res
 * (D6): every tile draws a page's cached `thumbnail` `ImageBitmap`, with the
 * page's `recipe.filter` applied as a `ctx.filter` CSS string (Fase 2.1
 * punch-list item 3 — an applied filter must be VISIBLE here, not just in
 * the editor) — this component never decodes a `Blob` or touches
 * `activeWorking`. Blocks new capture at the 30-page hard cap with an inline
 * hint (spec scenario "Cap duro de 30 paginas alcanzado").
 *
 * Replaces the inline `capture-tray-placeholder` `ScannerScreen` rendered
 * before this PR.
 *
 * Fase 2.2 punch-list item 4b: an "Export PDF" action lives directly on this
 * live-capture screen too (not only on the `grid`/`done` phases), so the
 * user can export in ONE tap without navigating tray -> grid first. Forwards
 * the SAME `exporting`/`onExportPdf` (`useExportPdf()`) the caller already
 * wires into `PageGrid`/`ScannerScreen`'s `done` phase — no separate export
 * logic here.
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 5): `PageThumbnail` moved out into
 * its own `PageThumbnail.tsx` module (this component is dead code post-Unit-3
 * and slated for deletion in Unit 6, but `PageThumbnail` itself is still
 * consumed live by `PageGrid` and the `done` summary strip).
 */

import type { ReactNode } from 'react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { PageThumbnail } from '@/features/scanner/components/PageThumbnail';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

export interface CaptureTrayProps {
  readonly pages: readonly DocumentPage[];
  /** True once `pages.length >= FILTER.PAGE_CAP` (design section 2.3 / D-MEM). */
  readonly isAtCap: boolean;
  readonly onDone: () => void;
  /** True while a PDF export is in flight (`useExportPdf()`, Fase 2.2 item 4b) — disables the export trigger. */
  readonly exporting: boolean;
  readonly onExportPdf: () => void;
}

export function CaptureTray({ pages, isAtCap, onDone, exporting, onExportPdf }: CaptureTrayProps): ReactNode {
  const { t } = useTranslation();
  if (pages.length === 0) {
    // Nothing captured yet this session — the tray only makes sense once at
    // least one page exists (design section 5.1).
    return null;
  }

  return (
    <div className="flex w-full flex-col gap-2" data-testid="capture-tray">
      <div className="flex w-full items-center gap-2 overflow-x-auto" data-testid="capture-tray-strip">
        {pages.map((page) => (
          <PageThumbnail
            key={page.id}
            bitmap={page.thumbnail}
            filter={page.recipe.filter}
            testId={`capture-tray-thumb-${page.id}`}
          />
        ))}
      </div>

      {isAtCap && (
        <p className="text-sm text-text-muted" data-testid="capture-tray-cap-hint">
          {t('common.documentLimitReached', { cap: FILTER.PAGE_CAP })}
        </p>
      )}

      <div className="flex w-full items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {t('capture.pagesCaptured', { n: pages.length })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onExportPdf}
            disabled={pages.length === 0 || exporting}
            data-testid="tray-export-pdf"
          >
            {exporting ? t('scanner.exporting') : t('scanner.exportPdf')}
          </Button>
          <Button type="button" variant="secondary" onClick={onDone} data-testid="tray-done">
            {t('capture.done')}
          </Button>
        </div>
      </div>
    </div>
  );
}
