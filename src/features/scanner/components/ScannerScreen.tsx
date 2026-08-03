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
import { Check } from 'lucide-react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { CaptureScreen } from '@/features/scanner/components/CaptureScreen';
import { CornerEditor, type CornerEditorConfirmResult } from '@/features/scanner/components/CornerEditor';
import { PageThumbnail } from '@/features/scanner/components/PageThumbnail';
import { ProcessingScreen } from '@/features/scanner/components/ProcessingScreen';
import { WelcomeScreen } from '@/features/scanner/components/WelcomeScreen';
import { useSaveToHistory } from '@/features/history/hooks/useSaveToHistory';
import { decodeImportedFile } from '@/features/scanner/lib/captureFallback';
import { useActivePage } from '@/features/scanner/hooks/useActivePage';
import { useExportPdf } from '@/features/scanner/hooks/useExportPdf';
import { usePageDeletion } from '@/features/scanner/hooks/usePageDeletion';
import { useCamera } from '@/features/scanner/hooks/useCamera';
import { useOpenCvInit } from '@/features/scanner/hooks/useOpenCvInit';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import { randomId } from '@/shared/lib/randomId';

/**
 * Group 5 / PR8: lazy-loaded feature boundary for the reorderable page grid
 * (design section 5.3, section 8 empirical item). `@dnd-kit` is only pulled
 * into a chunk once `phase === 'grid'` actually renders `<PageGrid>` —
 * keeping it OUT of the initial bundle (F1's <200KB gzip budget).
 */
const PageGrid = lazy(() => import('@/features/scanner/components/PageGrid'));

/**
 * Per-page CamScanner-style review screen (filter strip + crop/rotate/retake
 * toolbar + "add more"), shown for `phase === 'adjust'` between `processing`
 * and `grid`. Lazy-loaded like `PageGrid` so its lucide icons + preview code
 * stay out of the initial bundle (only reached after the capture flow).
 */
const AdjustScreen = lazy(() => import('@/features/scanner/components/AdjustScreen'));

export interface ScannerScreenProps {
  /**
   * Opens the scan history (history design section 6). Optional so the many
   * existing tests that render `<ScannerScreen />` bare keep compiling — when
   * absent, the welcome screen simply omits the entry point.
   */
  readonly onOpenHistory?: () => void;
}

export function ScannerScreen({ onOpenHistory }: ScannerScreenProps = {}): ReactNode {
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
  // Scan history (history design section 6): the grid's "Listo" transition is
  // the non-export way to finish a document, so it owns its own save call.
  const { saveToHistory } = useSaveToHistory();

  // Group 2 / PR5 controller: Activate/Deactivate, Re-warp (design section
  // 2.2) for the grid's re-entry corner-edit flow.
  const { activeWorking, activePageId, activatePage, deactivateActivePage, rewarpActivePage, materializeRawCapture } =
    useActivePage();

  const [startedManually, setStarted] = useState(false);

  /**
   * The welcome screen is the "no document in play" state, not an explicit
   * flag. Deriving it from `pages` as well as the button press is what lets a
   * document restored from the history (history design section 6) land
   * straight on its grid — `loadDocumentFromHistory` fills `pages` without ever
   * routing through `handleStart`, so a purely manual flag would bounce the
   * user back to the welcome screen with their restored document invisible
   * behind it.
   */
  const started = startedManually || pages.length > 0;

  // Where the corner editor (`editing-corners`) should return on Confirm/
  // Cancel — the grid re-entry returns to `'grid'`, but the new `'adjust'`
  // screen's "Recortar" returns to `'adjust'` (on the same page). Tracked here
  // since a single CornerEditor instance serves both callers.
  const [editReturnPhase, setEditReturnPhase] = useState<'grid' | 'adjust'>('grid');
  // The page currently shown in `'adjust'`, so a crop round-trip re-enters the
  // SAME page instead of snapping back to the first.
  const [adjustPageId, setAdjustPageId] = useState<string | null>(null);

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
   * Welcome-screen "Importar imagen" (design section 5.1): decode the picked
   * file → materialize it as a raw capture (the LIGHTWEIGHT path, no detect)
   * → jump straight to the deferred `processing` batch, entirely skipping the
   * live camera. `setPhase('processing')` is set BEFORE `setStarted(true)` so
   * the first render past the welcome gate already lands on `ProcessingScreen`
   * — never a transient `idle`/`capturing` frame that would pop the camera
   * permission prompt for a user who explicitly chose to import instead.
   * Rejects on decode/materialize failure so `WelcomeScreen` can surface the
   * error inline and stay put.
   */
  const handleImportFromWelcome = useCallback(
    async (file: File) => {
      const decoded = await decodeImportedFile(file);
      await materializeRawCapture({
        id: randomId(),
        originalBitmap: decoded.bitmap,
        originalWidth: decoded.width,
        originalHeight: decoded.height,
      });
      setPhase('processing');
      setStarted(true);
    },
    [materializeRawCapture, setPhase],
  );

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
      setPhase(editReturnPhase);
      void deactivateActivePage();
    },
    [activePageId, rewarpActivePage, deactivateActivePage, setPhase, editReturnPhase],
  );

  /**
   * Re-entry Cancel: no store write ever happened during interactive editing
   * (CornerEditor keeps LOCAL state until Confirm), so simply deactivating
   * discards this session's edits (`activeDirty` is still false) and returns
   * to the grid.
   */
  const handleActivePageCancel = useCallback(() => {
    setPhase(editReturnPhase);
    void deactivateActivePage();
  }, [deactivateActivePage, setPhase, editReturnPhase]);

  /** Grid tile tap -> activatePage -> open the corner editor for that page (design section 5.3). Returns to the grid on confirm/cancel. */
  const handleActivatePageTap = useCallback(
    (pageId: string) => {
      setEditReturnPhase('grid');
      void activatePage(pageId).then(() => setPhase('editing-corners'));
    },
    [activatePage, setPhase],
  );

  // ── Adjust screen (phase 'adjust') wiring ──────────────────────────────
  /** "Recortar" in the adjust screen: open the corner editor for this page, returning to 'adjust' on confirm/cancel. */
  const handleAdjustCrop = useCallback(
    (pageId: string) => {
      setEditReturnPhase('adjust');
      setAdjustPageId(pageId);
      void activatePage(pageId).then(() => setPhase('editing-corners'));
    },
    [activatePage, setPhase],
  );

  const handleAdjustNext = useCallback(() => {
    setPhase('grid');
  }, [setPhase]);

  const handleAdjustAddMore = useCallback(() => {
    // Same transition as the grid's "Capturar más" — re-arm the camera.
    setPhase('capturing');
  }, [setPhase]);

  const handleGridCaptureMore = useCallback(() => {
    // Design "Phase model": grid "Capturar más" -> 'capturing'.
    // `CaptureScreen`'s own mount effect re-arms the camera on this
    // transition (design "Re-arm camera on entry to 'capturing'").
    setPhase('capturing');
  }, [setPhase]);

  const handleGridFinish = useCallback(() => {
    // The second of the two "document is finished" moments (history design
    // section 6). Idempotent with the export path: both key off the same
    // `documentId`, so whichever fires second updates one record.
    void saveToHistory(pages);
    setPhase('done');
  }, [pages, saveToHistory, setPhase]);

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
      <WelcomeScreen
        onStart={handleStart}
        onImportFile={handleImportFromWelcome}
        onOpenHistory={onOpenHistory}
      />
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

  // Per-page CamScanner-style review (Task 2): filter strip + crop/rotate/
  // retake toolbar + "add more", reached from `processing` and leading into
  // the overview `grid`. Lazy-loaded (its own chunk).
  if (phase === 'adjust') {
    return (
      <Suspense fallback={<p data-testid="adjust-loading">{t('scanner.loading')}</p>}>
        <AdjustScreen
          initialPageId={adjustPageId}
          onPageChange={setAdjustPageId}
          onCrop={handleAdjustCrop}
          onNext={handleAdjustNext}
          onAddMore={handleAdjustAddMore}
        />
      </Suspense>
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
      <div className="flex w-full max-w-md flex-col items-center gap-6" data-testid="scan-done">
        {/* Success check (design section 5.6): a 92px teal-gradient circle that
            pops in, wrapped by an expanding ripple ring. */}
        <div className="relative flex h-[92px] w-[92px] items-center justify-center">
          <span
            className="animate-ripple pointer-events-none absolute inset-0 rounded-full border-2 border-primary"
            aria-hidden="true"
          />
          <div
            className="animate-check-pop flex h-[92px] w-[92px] items-center justify-center rounded-full text-white shadow-[0_12px_34px_rgba(15,138,120,0.5)]"
            style={{ backgroundImage: 'linear-gradient(140deg, #3AD6BD, #0F8A78)' }}
          >
            <Check size={44} strokeWidth={2.5} aria-hidden="true" />
          </div>
        </div>

        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-extrabold tracking-tight text-text">{t('done.title')}</h1>
          <p className="text-sm text-text-muted">{t('done.pagesScanned', { n: pages.length })}</p>
        </div>

        {pages.length > 0 && (
          // Fase 2.2 item 4a: the last screen before export previously showed
          // only a text count, so there was nothing to actually PREVIEW.
          // Reuses the shared `PageThumbnail` (already applies each page's
          // filter via `buildThumbnailCssFilter`) so the filtered pages are
          // visibly confirmed here — now fanned (design section 5.6): a slight
          // per-page rotation off center + a staggered `rise` entrance.
          <div className="flex w-full items-center justify-center gap-2 overflow-x-auto py-2" data-testid="scan-done-pages">
            {pages.map((page, index) => {
              const rotation = Math.max(-8, Math.min(8, (index - (pages.length - 1) / 2) * 4));
              return (
                // Two wrappers on purpose: the `rise` keyframe animates
                // `transform` (translateY), so a rotation on the SAME element
                // would be overwritten once the animation lands. Outer = rise
                // (delay-staggered), inner = the static fan rotation.
                <div key={page.id} className="animate-rise shrink-0" style={{ animationDelay: `${index * 70}ms` }}>
                  <div style={{ transform: `rotate(${rotation}deg)` }}>
                    <PageThumbnail
                      bitmap={page.thumbnail}
                      filter={page.recipe.filter}
                      testId={`scan-done-thumb-${page.id}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex w-full flex-col items-stretch gap-3">
          <Button
            type="button"
            variant="primary"
            onClick={handleExportPdf}
            disabled={pages.length === 0 || exporting}
            data-testid="done-export-pdf"
          >
            {exporting ? t('scanner.exporting') : t('scanner.exportPdf')}
          </Button>
          <Button type="button" variant="ghost" onClick={handleScanAgain} data-testid="scan-again">
            {t('scanner.scanAnother')}
          </Button>
        </div>
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
