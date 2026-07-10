# Tasks: multipage-filters (Fase 2 -- multipagina + filtros)

Depends on: `core-scanner` (F1, archived). Reads: `spec/document`, `spec/filters`, `spec/scanner` deltas + `design.md`.
Ground truth: worker dir is `src/features/scanner/worker/` (singular); `Toast`/`Sheet` already exist in
`src/shared/ui/` -- Fase 2 EXTENDS `Toast`, it does not create a new primitive.

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~3300-3600 (9 work units, see table) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 9 work units, PR1 -> PR9 (sequential, store migration first) |
| Delivery strategy | ask-on-risk (assumed default -- orchestrator must confirm) |
| Chain strategy | pending -- recommend `feature-branch-chain` (tracker = existing `feat/multipage-filters` branch; children target the previous child) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| # | Goal | Design group | Est. lines | Base (if feature-branch-chain) |
|---|---|---|---|---|
| PR1 | Filter types + recipe helpers (additive) | 1a | ~150 | `feat/multipage-filters` (tracker) |
| PR2 | `DocumentSlice` store, additive alongside `CaptureSlice` | 1b | ~450 | PR1 branch |
| PR3 | Rewire `ScannerScreen`/`CornerEditor`, remove `CaptureSlice` (breaking cut) | 1c | ~400 | PR2 branch |
| PR4 | Rewrite impacted F1 tests | 1d | ~650 | PR3 branch |
| PR5 | Layered-memory lifecycle (`pageResources.ts`, `useActivePage`) | 2 | ~400 | PR4 branch |
| PR6 | Worker `APPLY_FILTER` + `cvBindings` + `filterPipeline.ts` | 3 | ~500 | PR5 branch |
| PR7 | `FilterPanel` UI + preview routing + apply-to-all | 4 | ~400 | PR6 branch |
| PR8 | `CaptureTray` + `PageGrid` (`@dnd-kit`, lazy) + reorder | 5 | ~450 | PR7 branch |
| PR9 | Delete + undo (`Toast` ext, `ToastHost`, `usePageDeletion`) | 6 | ~350 | PR8 branch |

PR1-PR4 correspond to design section 7 Group 1 (the breaking migration), split here for reviewability. None
of these land on `main` independently mid-slice; the tracker (`feat/multipage-filters`) only merges once PR9
is integrated. ADR-010 ("direct migration, no compat wrapper") governs the FINAL shape on `main`, not the
intermediate PR granularity used to review it.

---

## Group 1a -- Filter types (PR1)

AC8. Spec: `filters` Req "FilterParams embebido en EditRecipe".
Start: `EditRecipe` has no `filter` field. Finish: `FilterParams`/`NEUTRAL_FILTER` exist, JSON-only, recipe
helpers seed the neutral filter. Rollback: revert the PR1 branch -- zero consumers yet, no blast radius.

- [x] 1a.1 `src/shared/types/scanner.ts`: add `FilterPreset`, `FilterParams`, `NEUTRAL_FILTER`, `EditRecipe.filter: FilterParams`.
- [x] 1a.2 `src/features/scanner/lib/editRecipe.ts`: `createInitialRecipe` seeds `filter: NEUTRAL_FILTER`; add `withFilter(recipe, filter)`.
- [x] 1a.3 New `src/features/scanner/lib/filterConstants.ts`: `FILTER` constants (design section 4.4) -- JPEG_QUALITY, THUMBNAIL_MAX_EDGE, PAGE_CAP, ENHANCED_SATURATION, BETA_SCALE, SLIDER_DEBOUNCE_MS, per-preset block/C, MORPH_KERNEL.
- [x] 1a.4 Extend `tests/unit/editRecipe.test.ts`: `withFilter`, neutral-filter seeding, JSON round-trip has no binaries (spec scenario "Receta con filtro se serializa sin binarios").
- [x] 1a.5 Verify: `tsc --noEmit` clean; `vitest run editRecipe`.

## Group 1b -- `DocumentSlice` store (PR2)

AC1, AC2, AC3, AC7, AC9. Spec: `document` Req "Modelo DocumentSlice y retencion por capas", "Bandeja de
captura continua" (cap), "Grilla de paginas con reorder" (order model), "Borrado de pagina con undo".
Start: only `CaptureSlice` exists. Finish: `documentSlice.ts` exists with full state/actions/hygiene from
design section 1.4-1.5, wired into `scannerStore.ts` ALONGSIDE `CaptureSlice` (additive -- no UI consumer yet).
Rollback: revert PR2 branch; `CaptureSlice` still governs the app, so this is a safe intermediate state.

- [x] 1b.1 New `src/features/scanner/store/documentSlice.ts`: `DocumentPage`, `ActivePageResources`, `DocumentPhase`, `DocumentSlice`, `DocumentActions` per design section 1.2-1.4.
- [x] 1b.2 Implement `addPage` (30-cap no-op guard), `setActivePageId`, `setActiveWorking` (close-before-overwrite on `originalBitmap`/`warpedBase`), `setActiveDirty`.
- [x] 1b.3 Implement `updateRecipe`, `updatePageWarpBase` (closes previous thumbnail), `applyFilterToAll` (pure recipe rewrite, no bitmap work).
- [x] 1b.4 Implement `reorderPages` (full re-index from ordered id list), `setSelectedPageIds`, `setPhase`.
- [x] 1b.5 Implement `deletePage`/`restorePage`/`hardReleaseDeletion` per the hygiene table (design section 1.5): active-page delete closes `activeWorking`; a second `deletePage` while one is pending hard-releases the older one first.
- [x] 1b.6 Implement `resetDocument` (closes `activeWorking`, every `page.thumbnail`, `pendingDeletion.thumbnail`).
- [x] 1b.7 Wire `DocumentSlice` into `scannerStore.ts`'s combined store type, alongside (not replacing yet) `CaptureSlice`.
- [x] 1b.8 New `tests/unit/documentSlice.test.ts`: cap-30 block, close-before-overwrite on `setActiveWorking`, delete->pendingDeletion->undo restores `order`, delete->expiry hard-releases, second-delete-while-pending supersedes, `reorderPages` produces dense 0..n-1 with no gaps/dupes (spec scenario "Reorder por drag-and-drop").
- [x] 1b.9 Verify: `tsc --noEmit` clean; `vitest run documentSlice`.

## Group 1c -- Rewire screen/editor, remove `CaptureSlice` (PR3)

AC1, AC7, AC9. Spec: `document` Req "Migracion desde CaptureSlice (F1)"; `scanner` Req "Continuidad de camara entre paginas".
Start: `ScannerScreen`/`CornerEditor` read `CaptureSlice`; `DocumentSlice` exists unused. Finish: both
components read/write the active page via `DocumentSlice`; `CaptureSlice` and its actions
(`setOriginalFrame`, `setWarpedImage`, `setRecipe`, `resetCaptureSlice`) are deleted from `scannerStore.ts`.
Rollback: revert PR3 branch back to PR2's state (DocumentSlice unused but present) -- app still builds because
PR4 (test rewrite) has not landed, so `sdd-apply` must land PR3+PR4 as one reviewable pair before merging past this point.

- [x] 1c.1 `src/features/scanner/components/ScannerScreen.tsx`: rewrite phase-driven render per design section 5.1 (`capturing`/`tray` -> camera+tray, `editing-corners` -> `CornerEditor`, `grid` -> `PageGrid` placeholder, `done` -> summary). Materialize-on-capture calls `addPage` + `setActiveWorking(null)`, resumes `startDetection` (reuses `handleEditorCancel` pattern) -- keeps camera open (spec `scanner` scenario "Confirmar una pagina no cierra la camara").
- [x] 1c.2 `src/features/scanner/components/CornerEditor.tsx`: source becomes `activeWorking.originalBitmap`; re-warp writes `setActiveWorking({...prev, warpedBase: fresh})` + `updateRecipe` + `setActiveDirty(true)`. Preserve the existing extract-once/clone-per-warp pattern (buffer detach on transfer).
- [x] 1c.3 `src/features/scanner/store/scannerStore.ts`: delete `CaptureSlice`, `initialCaptureSlice`, and its actions; remove from the combined store type.
- [x] 1c.4 Grep the repo for any remaining `CaptureSlice`/`setOriginalFrame`/`setWarpedImage`/`setRecipe`/`resetCaptureSlice` references outside tests; fix call sites.
- [x] 1c.5 Verify (build only, tests land in PR4): `tsc --noEmit` clean; `pnpm build` succeeds; manual smoke of capture->confirm->tray in dev.

## Group 1d -- Rewrite impacted F1 tests (PR4)

AC9. Spec: `document` Req "Migracion desde CaptureSlice (F1)", scenario "Migracion no rompe higiene de memoria existente".
Start: `tests/unit/*` reference `CaptureSlice` shape and fail to compile against PR3. Finish: full suite green
against `DocumentSlice`; no test references `CaptureSlice`; memory-hygiene coverage (close-before-overwrite,
16MP cap, single-OffscreenCanvas) preserved. Rollback: this PR is purely tests -- revert without touching `src/`.

- [x] 1d.1 Rewrite `tests/unit/scannerStore.test.ts`: replace all `CaptureSlice` assertions with `DocumentSlice` equivalents (may merge with `documentSlice.test.ts` from 1b.8 -- keep one source of truth, delete duplicates). Note: `scannerStore.test.ts` was kept as the COMBINED-store wiring test (proving `scannerStore.ts`'s adapter wires `DocumentSlice` actions correctly) rather than merged wholesale, since `documentSlice.test.ts` already owns the isolated slice contract.
- [x] 1d.2 Rewrite `tests/unit/cornerEditorWarp.test.tsx` against `activeWorking`-sourced bitmap + `updateRecipe`/`setActiveDirty` calls. Note: `CornerEditor` was redesigned as a store-agnostic controlled component (see design deviation note below), so this file asserts via `onConfirm` call args + `bitmap.close()` spies instead of reading the store directly -- same bugs (C1/C2/L2) covered with the same rigor.
- [x] 1d.3 Rewrite `tests/unit/scannerCaptureGuard.test.tsx`, `tests/unit/scannerScreenOpenCvInit.test.tsx`, `tests/unit/scannerScreenImportHang.test.tsx`, `tests/unit/scannerScreenImportDetect.test.tsx` against the phase-driven `ScannerScreen`. These 4 files needed NO changes -- their assertions target `ScannerScreen`-level behavior (phase transitions, `ensureOpenCvInit`, import DETECT/hang guards) which is preserved verbatim by the rewrite; `CornerEditor`'s prop rename (`frame` -> `originalBitmap`/`width`/`height`) doesn't affect their mocks (`initialCorners` prop name unchanged).
- [x] 1d.4 Confirm F1 memory-hygiene tests still pass unmodified in intent: close-before-overwrite, 16MP capture cap, single-OffscreenCanvas-per-operation (grep for their assertions across the rewritten files). Confirmed: close-before-overwrite lives in `documentSlice.test.ts` + `scannerStore.test.ts` (combined-store wiring) + `cornerEditorWarp.test.tsx` (local-state hygiene); 16MP cap lives in untouched `captureResize.test.ts`; single-OffscreenCanvas-per-operation lives in untouched worker/pageResources tests -- none of these were touched or weakened by this PR.
- [x] 1d.5 Verify: `vitest run` (full suite) green (21 files / 175 tests); `rg CaptureSlice tests/` returns no matches; `tsc --noEmit` clean.

---

## Group 2 -- Layered-memory lifecycle (PR5)

AC7. Spec: `document` Req "Modelo DocumentSlice y retencion por capas", scenarios "Reentrada al editor de una
pagina inactiva", "Cambio de pagina activa libera el full-res anterior".
Start: `DocumentSlice` has sync actions only; no controller drives activate/deactivate/compress/decode.
Finish: `pageResources.ts` pure helpers + `useActivePage` hook implement Materialize/Activate/Deactivate/
Re-warp per design section 2.2. Rollback: revert PR5 branch; grid/tray (PR8) simply has no activation path yet.

- [x] 2.1 New `src/features/scanner/lib/pageResources.ts`: `compressBitmapToJpeg(bitmap, quality)`, `decodeBlobToBitmap(blob)`, `makeThumbnail(bitmap, maxEdge)` -- DOM/OffscreenCanvas only, no OpenCV, unit-testable.
- [x] 2.2 New `src/features/scanner/hooks/useActivePage.ts`: Materialize-on-capture, Activate (decode + `setActiveWorking` + deactivate-previous-first), Deactivate (recompress if `activeDirty`, `updatePageWarpBase`, close bitmaps), Re-warp integration.
- [x] 2.3 Expose the 30-page cap guard (`isAtCap`/`canAddPage`) from `useActivePage`, derived from `pages.length` vs `FILTER.PAGE_CAP`, plus a defensive `blocked-cap` guard inside `materializeCapture` itself. NOT wired into `ScannerScreen`/the capture controller yet -- that lands with Group 1c/Group 5's capture controller, which is out of scope for this PR (build-order note: Group 2 landed BEFORE Group 1c on this branch).
- [x] 2.4 New `tests/unit/pageResources.test.ts`: compress/decode/thumbnail round-trip, dimension math.
- [x] 2.5 New `tests/unit/useActivePage.test.ts`: activate closes previous working set, deactivate recompresses only when dirty, cap-reached blocks capture with hint.
- [x] 2.6 Verify: `vitest run pageResources useActivePage`; manual iOS/low-memory smoke deferred to full-suite verify (empirical AC7 item, design section 8).

## Group 3 -- Worker `APPLY_FILTER` (PR6)

AC4, AC5. Spec: `filters` Req "Enrutamiento de render (Canvas2D vs worker)", "Preview de filtros sobre thumbnail".
Start: worker only handles INIT/DETECT/WARP. Finish: `APPLY_FILTER` RPC batches up to 3 adaptive-preset
variants in one call; `cvBindings.ts` typed for the new OpenCV calls. Rollback: revert PR6 branch; PR7 (UI)
simply has no worker path to call yet.

- [x] 3.1 `src/features/scanner/worker/messages.ts`: add `FilterVariant`, `ApplyFilterRequest`, `FilteredResult`, `ApplyFilterResponse`; extend `WorkerRequest`/`WorkerResponse`/`WorkerErrorCode` unions (design section 4.1). Note: `ApplyFilterRequest.outputBitmap`'s doc-comment in design.md section 4.1 has the polarity backwards (says `false` -> bitmap, `true` -> ImageDataLike); implemented with the natural, name-matching polarity (`true` -> bitmap, `false` -> ImageDataLike fallback, mirroring `WARP`'s `offscreenSupported` branch) and flagged in the type's own doc-comment.
- [x] 3.2 `src/features/scanner/worker/cvBindings.ts`: add `adaptiveThreshold`, `morphologyEx`, `getStructuringElement`, `filter2D`, `convertScaleAbs`, and the constants (`ADAPTIVE_THRESH_MEAN_C`, `ADAPTIVE_THRESH_GAUSSIAN_C`, `THRESH_BINARY`, `MORPH_RECT`, `MORPH_OPEN`, `COLOR_GRAY2RGBA`, `CV_32F`) -- narrow local typing, same pattern as existing bindings.
- [x] 3.3 `src/features/scanner/worker/opencv.worker.ts`: `APPLY_FILTER` handler -- decode `srcMat`/`grayMat` once, loop `variants` (design section 4.4 pipeline: B/C pre-gain via `convertScaleAbs` into a fresh Mat, adaptiveThreshold per preset, morphology for `bw-high-contrast`, sharpen via `filter2D` when `sharpness > 0`, `cvtColor` GRAY2RGBA for single-channel results), single reusable `filterCanvas` OffscreenCanvas, every Mat (incl. `getStructuringElement`/`matFromArray` kernels) `.delete()`'d in `finally` (F1 section 7 hygiene). `srcMat`/`grayMat` never mutated in place -- every stage writes into a dedicated fresh Mat so the shared base is reusable across a batched request's variants.
- [x] 3.4 `src/features/scanner/lib/workerClient.ts`: add `applyFilter(...)` method with its OWN latest-wins-per-target discipline, NOT sharing the DETECT `isBusy()`/drop-latest gate (design section 4.5). `applyFilter` never touches `detectInFlight`; the "latest-wins" policy itself is documented as owned by the future caller (a filter-preview controller), per design section 4.5's own wording.
- [x] 3.5 New `src/features/scanner/lib/filterPipeline.ts`: `needsWorker(filter): boolean` (adaptive presets or `sharpness > 0`), `buildCssFilter(filter): string` (design section 3.2), `filterSignature(filter): string`.
- [x] 3.6 New `tests/unit/applyFilterWorker.test.ts`: request/response shape, transfer list correctness (`image.data.buffer` in the transfer list), batching of 3 variants in one round-trip, `isBusy()` staying `false` during `applyFilter`, and DETECT/APPLY_FILTER correlating independently via the shared id map.
- [x] 3.7 New `tests/unit/filterPipeline.test.ts`: `needsWorker` truth table (6 presets x sharpness on/off), `buildCssFilter` mapping (spec `filters` scenarios "Preset Canvas2D no toca el worker", "Preset adaptativo enruta al worker", "Nitidez fuerza ruta de worker"), plus `filterSignature` stability/uniqueness checks.
- [x] 3.8 Verify: `npx vitest run filterPipeline workerClient applyFilter` (4 files / 32 tests green); `npx vitest run` full suite (23 files / 203 tests green); `npx tsc --noEmit` clean; zero `any` in new/modified worker code (`rg`-verified).

## Group 4 -- Filter UI (PR7)

AC4, AC5, AC6. Spec: `filters` Req "6 presets de filtro por pagina", "Aplicar filtro a todo el documento".
Start: no filter UI exists. Finish: `FilterPanel` renders 6 preset tiles + 3 sliders + apply-to-all, wired to
`updateRecipe`/`applyFilterToAll`, previews batch the 3 adaptive presets in one `APPLY_FILTER` call. Rollback:
revert PR7 branch; `CornerEditor` still functions without a filter panel.

- [ ] 4.1 New `src/features/scanner/components/FilterPanel.tsx` (may use existing `Sheet`): 6 preset tiles previewed on the active page's thumbnail via `filterPipeline.needsWorker`/`buildCssFilter` routing (design section 3.4).
- [ ] 4.2 Brightness/contrast/sharpness sliders mapped per design section 3.2/3.3; debounce worker calls at `FILTER.SLIDER_DEBOUNCE_MS` (~120ms).
- [ ] 4.3 Batch the 3 adaptive-preset thumbnail previews in a single `APPLY_FILTER` call (spec scenario "Preview de los 6 presets sin recompute full-res").
- [ ] 4.4 "Apply to all" button: confirmation step, then `applyFilterToAll(filter)` -- instant, no worker batch (spec scenario "Aplicar a todo el documento reescribe recetas sin renderizar").
- [ ] 4.5 Wire `FilterPanel` into `CornerEditor`/active-page view; writes go through `updateRecipe(activePageId, withFilter(recipe, filter))`. Confirm filter changes never call `runWarp`.
- [ ] 4.6 New `tests/unit/filterPanel.test.tsx`: preset selection calls `updateRecipe` not warp, slider debounce, apply-to-all confirmation writes every page's recipe instantly with zero worker calls.
- [ ] 4.7 Verify: `vitest run filterPanel`; `tsc --noEmit` clean.

## Group 5 -- Tray + grid (PR8)

AC1, AC2, AC9 (bundle budget). Spec: `document` Req "Bandeja de captura continua", "Grilla de paginas con reorder".
Start: no tray/grid UI; `@dnd-kit` not a dependency. Finish: `CaptureTray` renders thumbnails during capture;
`PageGrid` (lazy-loaded) supports drag-reorder; initial bundle stays under the 200KB gzip budget. Rollback:
revert PR8 branch; `ScannerScreen`'s `grid` phase falls back to its PR3 placeholder.

- [ ] 5.1 `package.json`: add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.
- [ ] 5.2 New `src/features/scanner/components/CaptureTray.tsx`: horizontal thumbnail strip, page counter, "Listo" button, blocks capture at the 30 cap with an inline hint (spec scenario "Cap duro de 30 paginas alcanzado"). Never renders full-res.
- [ ] 5.3 New `src/features/scanner/components/PageGrid.tsx` behind `React.lazy(() => import('./PageGrid'))`; tap-to-activate wires into `useActivePage` (Group 2); trash icon wires into Group 6's delete flow.
- [ ] 5.4 `onDragEnd` calls `reorderPages(newOrderedIds)` with the FULL id order (spec scenario "Reorder por drag-and-drop" -- no partial patch).
- [ ] 5.5 Wire `ScannerScreen`'s `grid` phase to lazy-load `PageGrid`; confirm `React.lazy` boundary keeps `@dnd-kit` out of the initial chunk.
- [ ] 5.6 New `tests/unit/captureTray.test.tsx`: cap-30 hint, thumbnail-only render (no full-res decode).
- [ ] 5.7 New `tests/unit/pageGrid.test.tsx`: `onDragEnd` produces dense 0..n-1 order, tap activates a page.
- [ ] 5.8 Verify: `vitest run captureTray pageGrid`; `pnpm build` + bundle-size check confirms initial chunk < 200KB gzip (design section 8 empirical item).

## Group 6 -- Delete + undo (PR9)

AC3. Spec: `document` Req "Borrado de pagina con undo por toast".
Start: `Toast` is presentational-only; `deletePage`/`restorePage`/`hardReleaseDeletion` exist in the store
(Group 1b) but nothing calls them from UI. Finish: deleting a page shows a 5s undo toast; expiry hard-releases
memory. Rollback: revert PR9 branch -- this is the final slice, tracker stays unmerged until it lands.

- [ ] 6.1 `src/shared/ui/Toast.tsx`: extend `ToastProps` with `action?: { label: string; onClick: () => void }` and `durationMs?: number`. Do NOT rebuild the primitive.
- [ ] 6.2 New `src/shared/ui/ToastHost.tsx`: renders a queue, owns per-toast auto-dismiss timers, exposes `useToast()`.
- [ ] 6.3 `src/shared/ui/index.ts`: export `ToastHost`, `useToast`.
- [ ] 6.4 New `src/features/scanner/hooks/usePageDeletion.ts`: calls `deletePage`, shows an undo toast (5s), cancels the timer + calls `restorePage()` on undo, calls `hardReleaseDeletion()` on timer expiry.
- [ ] 6.5 Wire `PageGrid`'s trash action to `usePageDeletion`.
- [ ] 6.6 Extend `tests/unit` for `Toast` (new props) and new `tests/unit/toastHost.test.tsx`, `tests/unit/usePageDeletion.test.ts`: undo-within-window restores at original `order` with resources intact (spec scenario "Undo dentro de la ventana de 5s"); expiry hard-releases (spec scenario "Expiracion sin undo libera memoria"); a second delete while one is pending supersedes the older one.
- [ ] 6.7 Verify: `vitest run` (full suite) green; `tsc --noEmit` clean; manual smoke of delete->undo->expiry in dev.

---

## Cross-cutting verification (run once at the end of PR9, before archive)

- [ ] V.1 Full acceptance-criteria pass against the proposal's AC1-AC9 checklist.
- [ ] V.2 `tsc --noEmit` strict, zero `any`, across the whole change.
- [ ] V.3 `vitest run` full suite green; `rg CaptureSlice src/ tests/` returns no matches.
- [ ] V.4 `pnpm build`; confirm initial bundle stays < 200KB gzip with `@dnd-kit` lazy-loaded.
- [ ] V.5 Manual empirical calibration (design section 8): `adaptiveThreshold`/morphology params on real docs, full-res `filter2D` sharpen cost, JPEG q0.85 re-warp perceived quality, page cap / debounce feel.
