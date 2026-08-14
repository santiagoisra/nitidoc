# Manual Paper Framing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every camera or imported capture explicitly select its paper framing before capture, preserve that manual geometry through re-warp, and make crop sides directly draggable.

**Architecture:** Capture UI snapshots a manual `PaperSelection` into `RawCapture`; batch processing copies it into the page recipe and resolves that selection as the only new-capture warp geometry. `CropOverlay` stays a controlled, platform-neutral geometry component and expands its existing pointer model with four constrained midpoint handles.

**Tech Stack:** React 18, TypeScript 5.7, Zustand, Vite/Vitest with Testing Library and happy-dom, OpenCV worker, jsPDF, Capacitor Android.

**Spec:** `docs/superpowers/specs/2026-08-14-manual-paper-framing-design.md`

## Global Constraints

- Use strict TDD: each behavior starts with a focused failing Vitest assertion, then the smallest implementation that passes it.
- New captures use only manual provenance; do not call `classifyPaperRatio` or `automaticPaperSelection` during capture processing or re-warp.
- Keep document-edge/quad detection and its review fallback unchanged.
- Picker values are `a4`, `oficio`, `letter`, `legal`, `ticket`, and `original`; display them as A4/A3, Oficio, Carta, Legal, Tarjeta/DNI, and Forma libre.
- A4/A3 uses the ISO A-series portrait ratio and exports as provisional A4; Tarjeta/DNI uses the ISO/IEC 7810 ID-1 portrait ratio (53.98 / 85.60); Forma libre has measured, unconstrained geometry.
- Preserve B&W filtering, signed releases, deployment, and unrelated UI.
- Use shared TypeScript/React behavior for web and Capacitor Android; no native-only implementation.
- Keep all work in this worktree and branch; make one conventional commit per completed task.

---

## File Structure

- Modify: `src/shared/types/paper.ts` — document the manual six-value capture contract without changing canonical PDF families.
- Modify: `src/features/scanner/lib/paperFormats.ts` — expose capture-picker metadata and manual selection helpers; retain legacy readers only for persisted data.
- Modify: `src/features/scanner/store/documentSlice.ts` — persist a manual `PaperSelection` in `RawCapture`.
- Modify: `src/features/scanner/hooks/useActivePage.ts` — require and snapshot a selection when materializing raw capture.
- Modify: `src/features/scanner/hooks/useBatchProcess.ts` — propagate raw selection and stop classifying detected ratios.
- Modify: `src/features/scanner/components/CaptureScreen.tsx` — add the pre-shutter picker, live guide, and selection forwarding.
- Modify: `src/features/scanner/components/FilterPanel.tsx` and `src/features/scanner/components/AdjustScreen.tsx` — remove post-capture automatic-format controls while retaining selected geometry through Adjust Borders.
- Modify: `src/features/scanner/components/CropOverlay.tsx` — add constrained side handles to the controlled crop interaction.
- Modify: `src/features/scanner/components/CornerEditor.tsx` — consume the unchanged shared overlay callbacks and preserve manual paper on re-warp.
- Modify: `src/features/scanner/lib/exportPdf.ts` only if the focused tests expose a missing A4/A3/manual-MediaBox condition; its intended rules remain unchanged.
- Modify: `src/shared/i18n/en.ts` and `src/shared/i18n/es.ts` — add capture-picker and accessible-handle copy, remove unreachable auto-detection copy only after usages are gone.
- Create: `tests/unit/captureScreen.test.tsx` — picker, guide, and raw-capture selection snapshot tests.
- Create: `tests/unit/cropOverlay.test.tsx` — constrained side-handle, pointer, convexity, and touch-target tests.
- Modify: `tests/unit/paperFormats.test.ts`, `tests/unit/useBatchProcess.test.ts`, `tests/unit/adjustScreenCrop.test.tsx`, and `tests/unit/exportPdf.test.ts` — domain, processing, preservation, and PDF regressions.

### Task 1: Manual paper contract and deferred-processing propagation

**Files:**
- Modify: `src/shared/types/paper.ts`
- Modify: `src/features/scanner/lib/paperFormats.ts`
- Modify: `src/features/scanner/store/documentSlice.ts`
- Modify: `src/features/scanner/hooks/useActivePage.ts`
- Modify: `src/features/scanner/hooks/useBatchProcess.ts`
- Modify: `tests/unit/paperFormats.test.ts`
- Modify: `tests/unit/useBatchProcess.test.ts`
- Modify: `tests/unit/documentSlice.test.ts`

**Interfaces:**
- Consumes: `PaperFormatAlias`, `PaperSelection`, `paperSelection(alias, 'manual')`, `RawCapture`, and `materializeRawCapture`.
- Produces: `CAPTURE_PAPER_FORMAT_OPTIONS: readonly PaperFormatAlias[]`; `capturePaperSelection(alias: PaperFormatAlias): PaperSelection`; `RawCapture.paper: PaperSelection`; and `materializeRawCapture(input: { id: string; originalBitmap: ImageBitmap; originalWidth: number; originalHeight: number; paper: PaperSelection }): Promise<MaterializeRawCaptureResult>` where `MaterializeRawCaptureResult['status']` is `'added' | 'blocked-cap'`.

- [ ] **Step 1: Write failing domain and processing tests**

Add tests asserting the exact picker order and geometry contract:

```ts
expect(CAPTURE_PAPER_FORMAT_OPTIONS).toEqual(['a4', 'oficio', 'letter', 'legal', 'ticket', 'original']);
expect(capturePaperSelection('a4')).toMatchObject({ alias: 'a4', source: 'manual' });
expect(resolveWarpGeometry(capturePaperSelection('a4'))).toEqual({ mode: 'fixed', portraitRatio: 210 / 297 });
expect(resolveWarpGeometry(capturePaperSelection('ticket'))).toEqual({ mode: 'fixed', portraitRatio: 53.98 / 85.6 });
expect(resolveWarpGeometry(capturePaperSelection('original'))).toEqual({ mode: 'measured' });
```

Add a `useBatchProcess` test whose raw capture carries `paper: paperSelection('letter', 'manual')`; assert the worker receives `resolveWarpGeometry(raw.paper)` and `addPage` receives `recipe.paper === raw.paper`. Add a fallback test with `paperSelection('original', 'manual')` that still sets `needsReview: true` but never calls `classifyPaperRatio`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/unit/paperFormats.test.ts tests/unit/useBatchProcess.test.ts tests/unit/documentSlice.test.ts`

Expected: FAIL because capture metadata, `RawCapture.paper`, and the materializer argument do not exist; existing processor assertions still observe ratio classification.

- [ ] **Step 3: Implement the smallest manual-only propagation**

In `paperFormats.ts`, define:

```ts
export const CAPTURE_PAPER_FORMAT_OPTIONS = ['a4', 'oficio', 'letter', 'legal', 'ticket', 'original'] as const;
export function capturePaperSelection(alias: PaperFormatAlias): PaperSelection {
  return paperSelection(alias, 'manual');
}
```

Give the canonical `ticket` catalog entry the ID-1 `nominalMm: { width: 53.98, height: 85.6 }` and `portraitRatio: 53.98 / 85.6`; its UI label changes in Task 2, not its persisted ID. Add `readonly paper: PaperSelection` to `RawCapture`; make `useActivePage.materializeRawCapture` require it and store it unchanged. Replace both `classifyPaperRatio(measuredQuadRatio(corners))` assignments in `processOneRawCapture` with `raw.paper`, including the degraded identity fallback. Pass `resolveWarpGeometry(raw.paper)` to the warp and construct the initial recipe with `raw.paper`. Leave detection, `needsReview`, ordering, bitmap ownership, and legacy selection helpers intact.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/unit/paperFormats.test.ts tests/unit/useBatchProcess.test.ts tests/unit/documentSlice.test.ts`

Expected: PASS; normal and fallback pages preserve manual source/alias and continue producing one page per decodable raw capture.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/shared/types/paper.ts src/features/scanner/lib/paperFormats.ts src/features/scanner/store/documentSlice.ts src/features/scanner/hooks/useActivePage.ts src/features/scanner/hooks/useBatchProcess.ts tests/unit/paperFormats.test.ts tests/unit/useBatchProcess.test.ts tests/unit/documentSlice.test.ts
git commit -m "feat(scanner): persist manual capture paper format"
```

### Task 2: Pre-shutter picker, framing guide, and review persistence

**Files:**
- Modify: `src/features/scanner/components/CaptureScreen.tsx`
- Modify: `src/features/scanner/components/FilterPanel.tsx`
- Modify: `src/features/scanner/components/AdjustScreen.tsx`
- Modify: `src/features/scanner/components/CornerEditor.tsx`
- Modify: `src/shared/i18n/en.ts`
- Modify: `src/shared/i18n/es.ts`
- Create: `tests/unit/captureScreen.test.tsx`
- Modify: `tests/unit/adjustScreenCrop.test.tsx`

**Interfaces:**
- Consumes: `CAPTURE_PAPER_FORMAT_OPTIONS`, `capturePaperSelection`, and the required `materializeRawCapture(..., paper)` contract from Task 1.
- Produces: a capture `<select data-testid="capture-paper-format">`, guide `<div data-testid="capture-paper-guide">`, and raw captures whose manual paper is immutable after shutter/import.

- [ ] **Step 1: Write failing capture and preservation tests**

Render `CaptureScreen` with mocked camera/materializer and assert:

```tsx
expect(screen.getByTestId('capture-paper-format')).toHaveValue('original');
expect(screen.queryByTestId('capture-paper-guide')).not.toBeInTheDocument();
await user.selectOptions(screen.getByTestId('capture-paper-format'), 'a4');
expect(screen.getByTestId('capture-paper-guide')).toHaveStyle({ aspectRatio: `${210} / ${297}` });
await user.click(screen.getByRole('button', { name: /capture/i }));
expect(materializeRawCapture).toHaveBeenCalledWith(expect.objectContaining({ paper: expect.objectContaining({ alias: 'a4', source: 'manual' }) }));
```

Add an import-path test for the same snapshot behavior. Extend the Adjust Borders test so it changes crop geometry for a page with `paperSelection('oficio', 'manual')` and asserts re-warp receives `resolveWarpGeometry` for that manual selection and saves the same provenance. Assert `paper-selection-controls` and `paper-clear-auto` are absent from review.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/unit/captureScreen.test.tsx tests/unit/adjustScreenCrop.test.tsx`

Expected: FAIL because the capture selector/guide are absent, materialization has no paper argument, and review still exposes automatic-format controls.

- [ ] **Step 3: Implement picker, guide, and review cleanup**

In `CaptureScreen`, add `const [paperAlias, setPaperAlias] = useState<PaperFormatAlias>('original')`. Render its localized six-option selector in the camera controls before the shutter, and render a pointer-events-none guide only when `getPaperFormat(paperAlias).portraitRatio` exists. Size the guide with CSS `aspect-ratio` from the selected portrait ratio and contain it within the live camera frame. Pass `capturePaperSelection(paperAlias)` to both camera and import `materializeRawCapture` calls.

Remove `FilterPanel`'s `paper`, `onPaperChange`, automatic recommendation, clear-to-auto, and format `<select>` surface; remove its callers from `AdjustScreen`. Replace both uses of `paperSelectionAfterCornerEdit` in `AdjustScreen` and `CornerEditor` with the page/recipe's existing `paper` selection, then resolve geometry from that unchanged selection. This preserves both new manual provenance and legacy history without any reclassification. Add the English and Spanish labels for the picker, options, and guide description.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/unit/captureScreen.test.tsx tests/unit/adjustScreenCrop.test.tsx`

Expected: PASS; the guide changes live, each raw capture snapshots its manual choice, and Adjust Borders retains it after re-warp.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/features/scanner/components/CaptureScreen.tsx src/features/scanner/components/FilterPanel.tsx src/features/scanner/components/AdjustScreen.tsx src/features/scanner/components/CornerEditor.tsx src/shared/i18n/en.ts src/shared/i18n/es.ts tests/unit/captureScreen.test.tsx tests/unit/adjustScreenCrop.test.tsx
git commit -m "feat(scanner): add manual paper framing picker"
```

### Task 3: Shared side handles, PDF regression, and cross-platform verification

**Files:**
- Modify: `src/features/scanner/components/CropOverlay.tsx`
- Modify: `src/features/scanner/components/CornerEditor.tsx`
- Create: `tests/unit/cropOverlay.test.tsx`
- Modify: `tests/unit/exportPdf.test.ts`

**Interfaces:**
- Consumes: controlled `CropOverlayProps`, `Quad`, `isConvex`, `sourceToDisplay`, `displayToSource`, `onCornersChange`, and `onDragStateChange`.
- Produces: `data-testid="crop-side-handle-top|right|bottom|left"`; each dispatches an entire convex `Quad` and uses the existing pointer lifecycle.

- [ ] **Step 1: Write failing shared-overlay and PDF tests**

Render a `CropOverlay` with a rectangular source quad and dispatch pointer events to each side handle. Assert the exact constrained updates:

```ts
expect(onCornersChange).toHaveBeenLastCalledWith([
  { x: 10, y: 25 }, { x: 90, y: 25 }, { x: 90, y: 90 }, { x: 10, y: 90 },
]); // top drag: only top pair Y changes
```

Repeat for bottom, left, and right; assert corner handles still alter one point freely. Assert every side button has `width: 44px`, `height: 44px`, and `touchAction: 'none'`; verify pointer capture is called and `pointercancel` emits `onDragStateChange(false)`. Drag a side past the opposite pair and assert no non-convex quad is reported. Add/retain PDF assertions that a manual `a4` page uses a 210 x 297 mm MediaBox, manual `ticket` (Tarjeta/DNI) uses a 53.98 x 85.60 mm MediaBox, and `original` remains raster-sized.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/unit/cropOverlay.test.tsx tests/unit/exportPdf.test.ts`

Expected: FAIL because no side-handle controls or constrained geometry exist; the new Tarjeta/DNI nominal-MediaBox assertion fails until Task 1's catalog contract is present.

- [ ] **Step 3: Implement constrained side dragging**

Extend the overlay drag state from corner index to a discriminated target:

```ts
type DragTarget = 0 | 1 | 2 | 3 | 'top' | 'right' | 'bottom' | 'left';
```

Use one target-aware pointer handler that keeps pointer capture and source mapping. For a source point `p`, build a candidate by copying `corners`: top sets `next[0].y` and `next[1].y` to `p.y`; right sets `next[1].x` and `next[2].x`; bottom sets `next[2].y` and `next[3].y`; left sets `next[3].x` and `next[0].x`. Call `onCornersChange(candidate)` only when `isConvex(candidate)`; preserve the existing corner behavior and magnifier anchor. Render midpoint-positioned, localized 44px buttons with the four required test IDs. Do not add platform detection or native code. Update `CornerEditor` only if its type assumptions need the broader shared drag callback; preserve its one re-warp per moved gesture behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/unit/cropOverlay.test.tsx tests/unit/exportPdf.test.ts`

Expected: PASS; all four sides remain axis-constrained and convex, pointer/touch lifecycle remains intact, and PDF manual A4/A3 remains provisional A4 while Tarjeta/DNI uses ID-1 dimensions.

- [ ] **Step 5: Run integration, type, and production verification**

Run: `npm test -- tests/unit/paperFormats.test.ts tests/unit/useBatchProcess.test.ts tests/unit/documentSlice.test.ts tests/unit/captureScreen.test.tsx tests/unit/adjustScreenCrop.test.tsx tests/unit/cropOverlay.test.tsx tests/unit/exportPdf.test.ts`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `npm run build:native`

Expected: PASS; the same TypeScript/React bundle builds for Capacitor Android.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/features/scanner/components/CropOverlay.tsx src/features/scanner/components/CornerEditor.tsx tests/unit/cropOverlay.test.tsx tests/unit/exportPdf.test.ts
git commit -m "feat(scanner): add crop side handles"
```

## Review Workload Forecast

| Dimension | Forecast |
| --- | --- |
| Estimated changed production lines | 330–390 |
| Estimated changed test lines | 260–340 |
| Chained PRs recommended | No |
| 400-line budget risk | High if tests are counted with implementation; keep one branch and review by the three task commits |
| Decision needed before apply | No |
| Primary review risks | Raw selection must be snapshotted before async work; no automatic reclassification may survive; side drags must preserve convexity and pointer capture |

Use one worktree and one branch. Review each task commit independently, then review the full diff for invariant preservation before opening a single PR.
