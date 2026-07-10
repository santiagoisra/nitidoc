# Verify Report - multipage-filters (Fase 2)

**Verdict: PASS WITH WARNINGS**

Branch feat/mpf-filter-types, commit 6539b61 (HEAD), working tree clean. All 9 chained work units
(PR1-PR9 / Groups 1a-6) implemented and committed. Cross-cutting verification V.1-V.4 executed this
session; V.5 (empirical/manual calibration) explicitly deferred to the users manual browser test, per
design.md section 8.

## Raw check outputs

### V.2 npm run typecheck
tsc --noEmit
Result: 0 errors.

rg -n ": any or as any" src/features/scanner src/shared/ui -> no matches (zero any).

### V.3 npx vitest run
Test Files  29 passed (29)
Tests  233 passed (233)
Duration  7.02s

rg -l CaptureSlice src/ tests/ -> no matches (migration clean, no stale references).

### V.4 npm run build
dist/assets/opencv.worker-BmUpeNGH.js    9.87 kB
dist/assets/index-BQAQf3qJ.css          14.54 kB gzip 3.66 kB
dist/assets/PageGrid-Cd7DxXrJ.js        46.17 kB gzip 15.64 kB
dist/assets/index-BvNOWDa_.js          209.81 kB gzip 66.45 kB

Initial bundle gzip 66.45 kB, well under the 200KB budget. PageGrid chunk is separate, loaded via
dynamic import, so dnd-kit stays isolated out of the initial bundle.

## AC1-AC9 (proposal.md) - met/partial/not-met with evidence

| AC | Verdict | Evidence |
|---|---|---|
| AC1 - capture >=2 pages continuously, camera stays open | PARTIAL | Mechanism correct: ScannerScreen.handleDraftConfirm calls materializeCapture then addPage, setPhase(tray); phase-effect resumes startDetection automatically for tray/grid/etc (never calls track.stop()). Covered piecewise by documentSlice.test.ts (addPage/order) and useActivePage.test.ts. Gap: no ScannerScreen-level integration test or Playwright e2e drives Confirm to addPage to second-capture end to end proving camera stays open across 2 real captures - scannerCaptureGuard.test.tsx only tests the double-capture reentrancy guard, not continuity across pages. WARNING, not blocking. |
| AC2 - grid shows pages by order; DnD reorders without gaps/dupes | MET | documentSlice.ts reorderPages/reindex; PageGrid.tsx + reorderIds helper; pageGrid.test.tsx (8 tests), documentSlice.test.ts reorder test. |
| AC3 - delete shows 5s undo toast; undo restores position; expiry frees memory | MET | usePageDeletion.ts, ToastHost.tsx, documentSlice.ts deletePage/restorePage/hardReleaseDeletion; usePageDeletion.test.ts (4 tests, real store), toastHost.test.tsx (6 tests). |
| AC4 - 6 presets per page, previewed on thumbnail, adaptive via worker | MET | FilterPanel.tsx, filterPipeline.ts needsWorker/buildCssFilter, worker APPLY_FILTER handler (batches variants over one decoded srcMat/grayMat); filterPipeline.test.ts (25 tests, truth table), applyFilterWorker.test.ts, filterPanel.test.tsx. |
| AC5 - preset/slider change never re-invokes warp | MET | rewarpActivePage/filter writes are separate code paths; cornerEditorWarp.test.tsx, filterPanel.test.tsx assert onChange fires without a warp call. |
| AC6 - apply to all writes filter to every page, instant, no worker batch | MET | documentSlice.ts applyFilterToAll (pure recipe map, no bitmap work); filterPanel.test.tsx apply-to-all test asserts zero worker calls. |
| AC7 - live full-res memory ~1 page; 10+ pages no iOS crash | PARTIAL (structural MET / empirical DEFERRED) | Type-level enforcement via activeWorking: ActivePageResources or null (only one slot) + close-before-overwrite hygiene in setActiveWorking/deletePage/resetDocument; useActivePage.test.ts covers activate/deactivate hygiene. Empirical iOS/10+-page smoke explicitly deferred to manual test (design section 8) - correctly out of scope for this verify pass (V.5). |
| AC8 - EditRecipe stays JSON-serializable, no binaries | MET | editRecipe.test.ts - JSON.stringify/parse round-trip, regex assert serialized JSON does not match ImageBitmap or Blob or Mat. |
| AC9 - tsc clean/no any; F1 tests rewritten pass; bundle under 200KB gzip, dnd-kit lazy | MET | See raw outputs above: 0 tsc errors, 0 any, 233/233 tests, 0 CaptureSlice refs, 66.45kB gzip initial bundle, dnd-kit isolated in PageGrid chunk. |

## Spec scenario coverage (document/filters/scanner deltas)

All scenarios in the three spec deltas have a demonstrable, PASSING covering unit test EXCEPT:

- "Captura continua de multiples paginas" (document spec) - same gap as AC1 above: covered by code
  inspection plus piecewise unit tests, not a direct integration/e2e scenario test.
- "Confirmar una pagina no cierra la camara" (scanner spec) - same gap; ScannerScreens phase-effect
  logic supports it (never calls track.stop() on confirm), but no test asserts the MediaStream tracks
  stop() was NOT called across a confirm.
- Design section 8 empirical items (adaptiveThreshold/morphology calibration, full-res sharpen cost,
  JPEG q0.85 perceived quality, page-cap/debounce feel) - explicitly DEFERRED to manual test (V.5), not
  a gap.

All other scenarios (reorder, undo/expiry, 6-preset routing, apply-to-all, JSON round-trip,
migration/hygiene preservation) have passing unit tests demonstrably covering them.

## Design coherence

Spot-checked documentSlice.ts, useActivePage.ts, opencv.worker.ts (APPLY_FILTER handler),
filterPipeline.ts, CaptureTray.tsx, ToastHost.tsx, App.tsx, ScannerScreen.tsx, CornerEditor.tsx
testids - all faithfully implement design.md sections 1-5 and ADR-007 through ADR-011. Two documented,
non-breaking deviations noted in apply-progress:

1. ApplyFilterRequest.outputBitmap polarity is inverted vs design.md doc-comment (design said
   false maps to bitmap; code implements true maps to bitmap, matching WARPs existing convention) -
   flagged in the types own doc-comment. WARNING (doc/code mismatch in design.md itself; code behavior
   is internally consistent and tested).
2. FilterPanel is composed inside CornerEditor (controlled, local-state-until-confirm) rather than
   directly by ScannerScreen as design section 5.4 suggested - documented rationale (keeps
   CornerEditors discard-on-cancel contract uniform for corners+filter). Apply to all reaches the
   store via a passthrough onApplyToAll prop, preserving CornerEditors store-agnostic design. WARNING
   (deviation, not a spec violation).

## App boot integrity

src/app/App.tsx mounts ToastHost wrapping the entire app shell (header + ScannerScreen), so
useToast() resolves anywhere in the tree. All ScannerScreen phases have a render branch
(permission-denied/no-camera/error/editing-corners/grid/done/default-camera-view) - no missing branch
found. No obvious first-render crash path.

## Playwright e2e - STATIC inspection only (not run)

5 specs in tests/e2e/: smoke.spec.ts, camera.spec.ts, detection.spec.ts, cornerEditor.spec.ts,
importFixture.spec.ts. playwright.config.ts testDir correctly points at ./tests/e2e.

None are STALE / broken - every data-testid these specs reference (camera-view-video,
capture-button, corner-editor, corner-handle-{i}, aspect-ratio-selector, aspect-ratio-unknown,
corner-editor-cancel, corner-editor-confirm, warp-preview, warp-error, import-fallback*,
quality-hints, detection-overlay) still exists verbatim in the current component tree
(CornerEditor.tsx, ImportFallback.tsx, CameraView.tsx, QualityHints.tsx, DetectionOverlay.tsx,
CaptureButton.tsx). None of these specs click Confirm and assert a post-confirm phase, so none assume
the old confirm-to-done single-page flow that no longer exists.

Coverage GAP for the users manual test (not stale, but worth knowing before manual testing): none
of the 5 existing e2e specs exercise ANY of the Fase 2 surface - no spec drives continuous multi-page
capture, the tray, the grid/reorder, delete/undo, the FilterPanel, or apply to all. The users upcoming
manual browser test is effectively the FIRST end-to-end exercise of the entire Fase 2 feature set
(tray/grid/filters/delete-undo), since neither the unit suite (which mocks store/worker boundaries) nor
the e2e suite (which predates Fase 2) integration-tests the full multipage/filter flow together.

## CRITICAL issues

None.

## WARNING issues

1. AC1 / "Captura continua" scenario: no integration/e2e test proves camera-stays-open across 2+ real
   captures - code-reasoned, not test-proven.
2. No e2e coverage at all for tray/grid/reorder/delete-undo/filter-panel/apply-to-all - first real
   exercise is the users manual test.
3. ApplyFilterRequest.outputBitmap polarity: design.md doc-comment vs implementation disagree
   (implementation is internally consistent and tested; design doc is stale on this one field).
4. FilterPanel composition location deviates from design section 5.4 (documented, non-breaking).

## SUGGESTION issues

1. Consider adding one ScannerScreen-level integration test (mocked camera/worker, real store) that
   drives two full capture-confirm cycles and asserts pages.length === 2 and track.stop is never called
   - would close the AC1/continuity gap cheaply without needing Playwright.
2. Consider one Playwright e2e spec (post-manual-test, Fase 2 follow-up) exercising
   capture to tray to grid to filter to done, once the users manual pass has stabilized real-device behavior.

## Deferred (V.5, explicitly out of scope for this pass)

adaptiveThreshold/morphology blockSize/C calibration on real docs; full-res filter2D sharpen cost;
JPEG q0.85 re-warp perceived quality; page-cap-30/slider-debounce-120ms feel; real iOS multi-page memory
smoke (AC7 empirical half). All deferred to the users manual browser test per design.md section 8.
