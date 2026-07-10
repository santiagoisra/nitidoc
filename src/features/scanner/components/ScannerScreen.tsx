/**
 * Scanner screen wiring `useCamera` + `CaptureScreen` + `ProcessingScreen` +
 * `CornerEditor` + `PageGrid` together (Group 3 / Slice C camera lifecycle +
 * Group 5 / Slice E corner editor and warp).
 *
 * Phase-driven, active-page/multipage model (`DocumentSlice.phase` is the
 * SOLE phase owner, design section 5.1, ADR-010):
 *  - `idle`/`capturing` -> the full-bleed `CaptureScreen` (Fase 2.3,
 *    capture-ux-redesign.md, Unit 3): persistent camera, manual raw
 *    captures accumulate in `DocumentSlice.rawCaptures`, no per-frame
 *    DETECT. `CaptureScreen` owns its own permission/no-camera fallback
 *    internally (the "phase-gating decouple") — see that component's doc
 *    comment.
 *  - `processing` -> `ProcessingScreen` (Fase 2.3, Unit 4): sequential
 *    per-raw-capture detect->warp->thumbnail batch, degraded-fallback-safe,
 *    determinate progress + Cancel.
 *  - `editing-corners` -> `CornerEditor`, re-entered from the grid
 *    (`activatePage` populates `activeWorking`/`activePageId` before this
 *    phase is set).
 *  - `grid` -> `PageGrid` (design section 5.3, Group 5/PR8), lazy-loaded so
 *    `@dnd-kit` stays out of the initial bundle: drag-reorder, tap-to-edit,
 *    delete, "Capture more"/"Finish".
 *  - `done` -> a finish summary.
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 6 — final cleanup): the live-
 * detection loop (`useDocumentDetection.ts`), its overlay/quality-hint UI
 * (`DetectionOverlay`/`QualityHints`), the resting live-camera+tray view, and
 * the FRESH-capture `CornerEditor` branch (`draftCapture`/`materializeCapture`)
 * are ALL REMOVED — every one of them had already gone unreachable once
 * Unit 3's `CaptureScreen` cutover landed (`DocumentPhase` is a closed union
 * and every value is handled by an earlier branch or the defensive fallback
 * at the bottom of this component). OpenCV init (`ensureOpenCvInit`/
 * `retryManualInit`/`workerClient`) now comes directly from `useOpenCvInit`
 * (Unit 2) — this screen is that hook's single call site for the whole
 * scanner session (see `useOpenCvInit.ts`'s own doc comment on why a second
 * call site would risk a real double INIT).
 */

import type { ReactNode } from 'react';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { CaptureScreen } from '@/features/scanner/components/CaptureScreen';
import { CornerEditor, type CornerEditorConfirmResult } from '@/features/scanner/components/CornerEditor';
import { PageThumbnail } from '@/features/scanner/components/PageThumbnail';
import { ProcessingScreen } from '@/features/scanner/components/ProcessingScreen';
import { useActivePage } from '@/features/scanner/hooks/useActivePage';
import { useExportPdf } from '@/features/scanner/hooks/useExportPdf';
import { usePageDeletion } from '@/features/scanner/hooks/usePageDeletion';
import { useCamera } from '@/features/scanner/hooks/useCamera';
import { useOpenCvInit } from '@/features/scanner/hooks/useOpenCvInit';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

/**
 * Group 5 / PR8: lazy-loaded feature boundary for the reorderable page grid
 * (design section 5.3, section 8 empirical item). `@dnd-kit` is only pulled
 * into a chunk once `phase === 'grid'` actually renders `<PageGrid>` —
 * keeping it OUT of the initial bundle (F1's <200KB gzip budget).
 */
const PageGrid = lazy(() => import('@/features/scanner/components/PageGrid'));

export function ScannerScreen(): ReactNode {
  const { t } = useTranslation();
  const { openCamera, switchCamera, setTorch } = useCamera();

  const setPhase = useScannerStore((s) => s.setPhase);
  const phase = useScannerStore((s) => s.phase);
  const pages = useScannerStore((s) => s.pages);
  const resetDocument = useScannerStore((s) => s.resetDocument);
  const applyFilterToAll = useScannerStore((s) => s.applyFilterToAll);
  const reorderPages = useScannerStore((s) => s.reorderPages);
  // Group 6 / PR9: deletion + 5s undo toast (design section 5.5). Replaces
  // Group 5/PR8's minimal direct `DocumentSlice.deletePage` wiring.
  const { deletePage } = usePageDeletion();
  const { exporting, exportPdf } = useExportPdf();

  // Group 2 / PR5 controller: Activate/Deactivate, Re-warp (design section
  // 2.2) for the grid's re-entry corner-edit flow.
  const { activeWorking, activePageId, activatePage, deactivateActivePage, rewarpActivePage } = useActivePage();

  const [started, setStarted] = useState(false);

  // Fase 2.3 "Unit 2"/"Unit 6": the OpenCV INIT/backoff/`OpenCvSlice`-
  // mirroring machinery lives in `useOpenCvInit`, called EXACTLY ONCE here —
  // this screen is now the sole call site (previously `useDocumentDetection`
  // was, before Unit 6 removed it). `workerClient`/`ensureOpenCvInit` are
  // passed down to `ProcessingScreen` -> `useBatchProcess` for the deferred
  // per-page detect/warp step; `retryManualInit` backs the degraded-mode
  // banner `ProcessingScreen` renders.
  const { workerClient, retryManualInit, ensureOpenCvInit } = useOpenCvInit();

  // Bug fix found while building the task 7.2 E2E fixture test: OpenCV used
  // to only be initialized as a side effect of the (now-removed) live-
  // detection loop starting, which required a granted camera permission and
  // a mounted <video>. When the import fallback is reached WITHOUT the
  // camera ever opening (permission denied, or no camera at all), NOTHING
  // ever called `ensureOpenCvInit()`, so the later batch-processing WARP
  // call failed with NOT_INITIALIZED every time. Kicking it off here — as
  // soon as the scanner screen is entered, regardless of camera outcome
  // (matching design section 4.2's own trigger condition) — lets OpenCV load
  // in the BACKGROUND while the permission-denied/no-camera screen is
  // showing, so by the time the user taps "Siguiente" the worker is likely
  // already ready.
  useEffect(() => {
    if (!started) {
      return;
    }
    ensureOpenCvInit().catch(() => {
      // Load failure (even after exhausted retries) is already surfaced
      // reactively via `OpenCvSlice.status === 'error'` (the degraded-mode
      // banner `ProcessingScreen` renders) — nothing further to do with the
      // rejection here.
    });
  }, [started, ensureOpenCvInit]);

  const handleStart = useCallback(() => {
    setStarted(true);
    // Transitions: start -> 'capturing' (design "Phase model"). Doing this
    // alongside `setStarted` (rather than in a separate effect) means
    // `CaptureScreen` mounts with the right phase on its very first render —
    // no intermediate frame where `phase` is still the initial `'idle'`.
    setPhase('capturing');
  }, [setPhase]);

  /**
   * Re-entry (grid tap -> activatePage -> 'editing-corners') Confirm: writes
   * the fresh warp + recipe into the active page (design section 2.2
   * "Re-warp (active)") then deactivates (recompresses since now dirty,
   * closes the full-res bitmaps) and returns to the grid.
   */
  const handleActivePageConfirm = useCallback(
    (result: CornerEditorConfirmResult) => {
      if (!activePageId) return;
      rewarpActivePage({ pageId: activePageId, freshWarpedBase: result.warpedBase, recipe: result.recipe });
      setPhase('grid');
      void deactivateActivePage();
    },
    [activePageId, rewarpActivePage, deactivateActivePage, setPhase],
  );

  /**
   * Re-entry Cancel: no store write ever happened during interactive editing
   * (CornerEditor keeps LOCAL state until Confirm), so simply deactivating
   * discards this session's edits (`activeDirty` is still false) and returns
   * to the grid.
   */
  const handleActivePageCancel = useCallback(() => {
    setPhase('grid');
    void deactivateActivePage();
  }, [deactivateActivePage, setPhase]);

  /** Grid tile tap -> activatePage -> open the corner editor for that page (design section 5.3). */
  const handleActivatePageTap = useCallback(
    (pageId: string) => {
      void activatePage(pageId).then(() => setPhase('editing-corners'));
    },
    [activatePage, setPhase],
  );

  const handleGridCaptureMore = useCallback(() => {
    // Design "Phase model": grid "Capturar más" -> 'capturing'.
    // `CaptureScreen`'s own mount effect re-arms the camera on this
    // transition (design "Re-arm camera on entry to 'capturing'").
    setPhase('capturing');
  }, [setPhase]);

  const handleGridFinish = useCallback(() => {
    setPhase('done');
  }, [setPhase]);

  const handleExportPdf = useCallback(() => {
    exportPdf(pages);
  }, [exportPdf, pages]);

  const handleScanAgain = useCallback(() => {
    resetDocument();
    // Design "Phase model": done "Escanear otro" -> resetDocument -> 'capturing'.
    // `CaptureScreen` re-arms the camera itself on mount.
    setPhase('capturing');
  }, [resetDocument, setPhase]);

  if (!started) {
    return (
      <Button variant="primary" type="button" onClick={handleStart} data-testid="open-scanner">
        {t('scanner.openScanner')}
      </Button>
    );
  }

  // Fase 2.3 (capture-ux-redesign.md, Unit 3), "Phase-gating decouple
  // (critical)": `idle`/`capturing` both route to the full-bleed
  // `CaptureScreen`, which owns its own permission/no-camera/camera-error
  // fallback internally (`cameraUsable`). `openCamera`/`switchCamera`/
  // `setTorch` are the SAME `useCamera()` hook instance's functions, passed
  // down as props (see the doc comment above where that hook is
  // destructured).
  if (phase === 'idle' || phase === 'capturing') {
    return <CaptureScreen openCamera={openCamera} switchCamera={switchCamera} setTorch={setTorch} />;
  }

  // Fase 2.3 (capture-ux-redesign.md, Unit 4): the real deferred
  // batch-processing screen — sequential per-page detect->warp->thumbnail
  // over `rawCaptures`, degraded-fallback-safe, with a determinate
  // progress bar and a Cancel that returns to `'capturing'`.
  if (phase === 'processing') {
    return (
      <ProcessingScreen
        ensureOpenCvInit={ensureOpenCvInit}
        workerClient={workerClient}
        retryManualInit={retryManualInit}
      />
    );
  }

  // Re-entry: a page tapped in the grid was already activated (activeWorking
  // populated by `activatePage`) before `phase` flipped to 'editing-corners'
  // (design section 5.3/5.4).
  if (phase === 'editing-corners' && activeWorking && activePageId) {
    const activePage = pages.find((page) => page.id === activePageId);
    if (activePage) {
      return (
        <CornerEditor
          key={activePageId}
          pageId={activePageId}
          originalBitmap={activeWorking.originalBitmap}
          width={activeWorking.originalBitmap.width}
          height={activeWorking.originalBitmap.height}
          initialCorners={null}
          initialRecipe={activePage.recipe}
          onConfirm={handleActivePageConfirm}
          onCancel={handleActivePageCancel}
          onApplyToAll={pages.length > 1 ? applyFilterToAll : undefined}
        />
      );
    }
  }

  // Group 5 / PR8: real reorderable `PageGrid` (design section 5.3),
  // lazy-loaded so `@dnd-kit` stays out of the initial bundle.
  if (phase === 'grid') {
    return (
      <Suspense fallback={<p data-testid="page-grid-loading">{t('scanner.loading')}</p>}>
        <PageGrid
          pages={pages}
          onActivatePage={handleActivatePageTap}
          onDeletePage={deletePage}
          onReorder={reorderPages}
          onCaptureMore={handleGridCaptureMore}
          onFinish={handleGridFinish}
        />
      </Suspense>
    );
  }

  if (phase === 'done') {
    return (
      <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="scan-done">
        <p className="text-sm text-text-muted">
          {t('scanner.scanComplete', { n: pages.length })}
        </p>
        {pages.length > 0 && (
          // Fase 2.2 item 4a: the last screen before export previously showed
          // only a text count, so there was nothing to actually PREVIEW.
          // Reuses the shared `PageThumbnail` (already applies each page's
          // filter via `buildThumbnailCssFilter`) so the filtered pages are
          // visibly confirmed here, exactly like the grid strip.
          <div className="flex w-full items-center gap-2 overflow-x-auto" data-testid="scan-done-pages">
            {pages.map((page) => (
              <PageThumbnail
                key={page.id}
                bitmap={page.thumbnail}
                filter={page.recipe.filter}
                testId={`scan-done-thumb-${page.id}`}
              />
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="secondary"
          onClick={handleExportPdf}
          disabled={pages.length === 0 || exporting}
          data-testid="done-export-pdf"
        >
          {exporting ? t('scanner.exporting') : t('scanner.exportPdf')}
        </Button>
        <Button type="button" variant="primary" onClick={handleScanAgain} data-testid="scan-again">
          {t('scanner.scanAnother')}
        </Button>
      </div>
    );
  }

  // Defensive: unreachable in practice — `DocumentPhase` is a closed union
  // and every value is handled by an earlier branch above (idle/capturing,
  // processing, editing-corners re-entry, grid, done). Render nothing rather
  // than crash if this is ever reached (e.g. 'editing-corners' with no
  // active page materialized yet).
  return null;
}
