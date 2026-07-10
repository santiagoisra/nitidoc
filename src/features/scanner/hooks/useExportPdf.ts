/**
 * `useExportPdf` — shared "Export PDF" action for the `grid` and `done`
 * phases (Fase 2.1 punch-list item 4). Both call sites need the exact same
 * busy/disabled/error-toast behavior around `exportPagesToPdf`, so this hook
 * is the single place that owns it instead of duplicating it in `PageGrid`
 * and `ScannerScreen`.
 */

import { useCallback, useState } from 'react';
import { useToast } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { exportPagesToPdf } from '@/features/scanner/lib/exportPdf';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

export interface UseExportPdfResult {
  /** True while a PDF is being generated — callers should disable their trigger button. */
  readonly exporting: boolean;
  /** No-op when `pages` is empty or an export is already in flight. */
  readonly exportPdf: (pages: readonly DocumentPage[]) => void;
}

export function useExportPdf(): UseExportPdfResult {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [exporting, setExporting] = useState(false);

  const exportPdf = useCallback(
    (pages: readonly DocumentPage[]) => {
      if (pages.length === 0 || exporting) {
        return;
      }
      setExporting(true);
      exportPagesToPdf(pages)
        .catch(() => {
          showToast({ message: t('scanner.exportPdfError'), variant: 'danger' });
        })
        .finally(() => {
          setExporting(false);
        });
    },
    [exporting, showToast, t],
  );

  return { exporting, exportPdf };
}
