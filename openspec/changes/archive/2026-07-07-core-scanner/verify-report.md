# Verification Report

**Change**: core-scanner (Fase 1 -- Core Scanner)
**Version**: N/A (openspec, no versioned spec numbering)
**Mode**: Standard (Strict TDD: false -- no runner configured at sdd-init time)
**Verified on**: 2026-07-07, branch feat/multipage-filters (contains all of Phase 1 + post-implementation fixes + Phase 2 scaffold)

## Summary

**PASS WITH WARNINGS**

All 7 task groups in tasks.md are marked [x] and the code backing every CAP-1..10 capability exists and is wired together. tsc --noEmit is clean, all 131 Vitest unit tests pass, the production build succeeds with the initial bundle at 60.14 KB gzip (budget: under 200 KB) and OpenCV.js correctly isolated as a lazy-loaded static asset (9.9 MB, not in any JS chunk). The 8 Playwright E2E specs pass. No CRITICAL issues were found against the spec/design/tasks contract. The WARNING-level items below are pre-existing, already-documented known limitations (dev-mode OpenCV, real-device calibration, headless E2E degradation), not undocumented regressions, but are listed because they still gate a fully confident production sign-off.

## Completeness

| Metric | Value |
|--------|-------|
| Task groups total | 7 (Scaffold, Worker OpenCV, Camara, Deteccion+auto-captura, Editor+warp, Casos borde/fallbacks, Tests) |
| Task groups complete | 7/7 -- every leaf checkbox in tasks.md is [x] |
| Leaf tasks total | ~85 (counted across 1.1-7.2) |
| Leaf tasks incomplete | 0 |

## Build & Tests Execution

**Type-check**: PASSED
```text
$ npx tsc --noEmit
(no output -- 0 errors)
```

**Tests**: PASSED -- 131/131
```text
$ npm run test -- --run
 Test Files  18 passed (18)
      Tests  131 passed (131)
   Duration  6.52s
```
Matches the count expected from apply-progress (131, including the regression test added in commit 6eceef2 for the import-detection bitmap-detach fix).

**Build**: PASSED
```text
$ npm run build
> tsc --noEmit && vite build
dist/index.html                        0.48 kB gzip 0.31 kB
dist/assets/opencv.worker-C2IqMdOo.js  7.19 kB
dist/assets/index-CAF5Ra-x.css        14.00 kB gzip 3.50 kB
dist/assets/index-CrtE6wYk.js        187.06 kB gzip 60.14 kB
built in 3.69s
```
Bundle composition verified directly on disk:
- dist/assets/index-CrtE6wYk.js -- 60.14 KB gzip = initial bundle. Well under the 200 KB gzip budget (proposal section 7 acceptance criterion, spec "Carga lazy de OpenCV.js").
- dist/assets/opencv.worker-C2IqMdOo.js -- 7.19 KB, a thin classic-worker wrapper (message dispatcher + importScripts bootstrap), not the OpenCV binary itself.
- dist/opencv/opencv.js -- 9.9 MB, copied as a static asset by scripts/copy-opencv.mjs (predev/prebuild hook) and loaded via self.importScripts("/opencv/opencv.js") inside the classic worker at runtime, NOT bundled into any Vite/Rollup JS chunk. Confirmed OpenCV is absent from index-CrtE6wYk.js by inspecting dist/assets/ contents -- there is no separate opencv-*.js Rollup chunk (this differs from an earlier engram note, #300, mentioning a 10.3MB lazy Rollup chunk -- this reflects the later architecture change in commits 615add8/4d11f7a that moved OpenCV to a static-asset + classic-worker-importScripts approach instead of a dynamic ES import chunk; the outcome -- OpenCV excluded from the initial bundle -- is unchanged and still verified true).

**E2E (Playwright)**: PASSED -- 8/8 (informational; run for completeness)
```text
$ npm run test:e2e -- --reporter=list
  ok 1 cornerEditor.spec.ts - backing out of the corner editor resumes the camera viewfinder
  ok 2 cornerEditor.spec.ts - manual capture opens the corner editor with 4 handles and a confirm button
  ok 3 camera.spec.ts - denying camera permission shows the import fallback with permission instructions
  ok 4 camera.spec.ts - opening the scanner starts the fake camera stream and renders video
  ok 5 detection.spec.ts - manual capture button triggers the capture sequence without a detected contour
  ok 6 smoke.spec.ts - app loads and renders the shell
  ok 7 detection.spec.ts - opening the scanner starts detection wiring without crashing
  ok 8 importFixture.spec.ts - Phase 1 acceptance: import fallback to detect to edit to warp (task 7.2)
  8 passed (7.8s)
```
importFixture.spec.ts (task 7.2, the Phase-1 acceptance E2E) passes, but by design it asserts the documented degraded contract in headless Chromium: OpenCV never finishes initializing inside the classic worker in this environment (see known-limitations below), so the test verifies import to decode to corner editor opens with frame-complete corners to a WARP request is sent to neither success nor error arrives within a bounded wait to Confirm correctly stays disabled to zero unhandled page errors. It does not assert a produced de-skewed image. This is consistent with engram #294/#300 and is not a new finding.

**Coverage**: Not configured (no --coverage script / threshold in this project) -- Not available.

## CAP-1..10 Coverage

| CAP | Requirement | Status | Evidence (files) |
|---|---|---|---|
| CAP-1 | Camara -- apertura y control | Compliant | hooks/useCamera.ts, components/CameraSelector.tsx, components/CameraView.tsx; tests tests/unit/useCamera.test.ts (3), E2E camera.spec.ts |
| CAP-2 | Deteccion en vivo (overlay, interpolacion) | Compliant | hooks/useDocumentDetection.ts, components/DetectionOverlay.tsx, lib/detectionMath.ts (lerp/interp); tests tests/unit/useDocumentDetection.test.ts (11), detectionMath.test.ts (20), E2E detection.spec.ts |
| CAP-3 | Auto-captura por estabilidad | Compliant | hooks/useDocumentDetection.ts (stability buffer + countdown), components/CaptureButton.tsx (manual FAB, toggle); covered by useDocumentDetection.test.ts |
| CAP-4 | Captura de frame full-res | Compliant | lib/captureFrame.ts, lib/captureResize.ts (16MP cap), lib/captureFeatureDetect.ts (ImageCapture/OffscreenCanvas detection); tests captureResize.test.ts (8), captureFeatureDetect.test.ts (4) |
| CAP-5 | Feedback de calidad en vivo | Compliant | components/QualityHints.tsx (aria-live region confirmed present), lib/detectionMath.ts (blur/dark/area math); covered by detectionMath.test.ts |
| CAP-6 | Editor de esquinas (handles, lupa, convexidad) | Compliant | components/CornerEditor.tsx, lib/geometry.ts (isConvex); tests tests/unit/cornerEditorWarp.test.tsx (4), geometry.test.ts (32) |
| CAP-7 | Warp / correccion de perspectiva | Compliant | worker/opencv.worker.ts (handleWarp/runDetectPipeline), lib/workerClient.ts (warp, detectImageData), lib/geometry.ts (orderCorners, outputSize, inferAspectRatio); tests workerClientProtocol.test.ts, geometry.test.ts, cornerEditorWarp.test.tsx, E2E importFixture.spec.ts (degraded but exercises the real request path) |
| CAP-8 | Rotacion / volteo post-warp | Compliant | lib/editRecipe.ts (non-destructive recipe: rotation, flipH); tests tests/unit/editRecipe.test.ts (21) |
| CAP-9 | Carga lazy de OpenCV.js | Compliant (build-verified); dev-mode caveat noted | lib/opencvLoader.ts, worker/opencv.worker.ts, worker/cvBindings.ts; build evidence above confirms OpenCV excluded from initial bundle; npm run dev limitation documented in README and in known-limitations below |
| CAP-10 | Casos borde / fallbacks | Compliant | components/ImportFallback.tsx (permission-denied / no-camera), components/OpenCvDegradedBanner.tsx (OPENCV_LOAD_FAILED degraded mode), lib/captureFallback.ts (decodeImportedFile); tests scannerScreenImportHang.test.tsx, scannerScreenOpenCvInit.test.tsx, scannerScreenImportDetect.test.tsx, scannerCaptureGuard.test.tsx, E2E camera.spec.ts (permission-denied) |

**Compliance summary**: 10/10 CAPs have implementing code and covering tests that pass. CAP-9's lazy-load contract is fully verified at build time; its dev-mode limitation is a tooling caveat, not a spec violation (spec requires lazy-load in the shipped app, which the production build satisfies).

## Spec Compliance Matrix (representative scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Apertura y control de camara | Permiso de camara denegado | camera.spec.ts "denying camera permission shows the import fallback..." | COMPLIANT |
| Deteccion de documento en vivo | Contorno no convexo / fuera de frame | geometry.test.ts (isConvex cases) + worker gating in opencv.worker.ts | COMPLIANT |
| Auto-captura por estabilidad | Esquinas estables to countdown to captura | useDocumentDetection.test.ts (stability/backoff suite) | COMPLIANT |
| Captura de frame full-res | Cap de 16MP | captureResize.test.ts | COMPLIANT |
| Feedback de calidad en vivo | Blur / oscuridad / distancia | detectionMath.test.ts | COMPLIANT |
| Carga lazy de OpenCV.js | Fallo de carga to backoff to degradado | useDocumentDetection.test.ts (init-hang/backoff describe block) | COMPLIANT |
| Fallback de import (desktop sin camara) | Import de imagen sin drag&drop/multiple | scannerScreenImportDetect.test.tsx, ImportFallback.tsx (no multiple, no drop handlers) | COMPLIANT |
| Editor manual de esquinas | Cuadrilatero no convexo bloquea confirmacion | cornerEditorWarp.test.tsx | COMPLIANT |
| Correccion de perspectiva (warp) | Warp corre en Web Worker sin bloquear UI | workerClientProtocol.test.ts + E2E importFixture.spec.ts (request sent, non-blocking main thread) | PARTIAL -- request/response protocol verified; pixel-correctness of the deskewed output is not verified in this environment (see known-limitations) |
| Rotacion y volteo post-warp | Ediciones no destructivas sobre el original | editRecipe.test.ts | COMPLIANT |

## Correctness (Static + Runtime Evidence)

| Requirement | Status | Notes |
|---|---|---|
| TS strict, no any | Implemented | tsc --noEmit clean; tsconfig.json has strict: true |
| Initial bundle under 200KB gzip | Implemented | 60.14 KB gzip, verified above |
| OpenCV not in initial bundle | Implemented | Verified via dist/ inspection |
| Non-destructive edit recipe | Implemented | EditRecipe never mutates CapturedFrame.source; editRecipe.test.ts covers this |
| Resource cleanup (ImageBitmap.close/revokeObjectURL) | Implemented | present in captureFrame.ts/mainThreadImageData.ts/ScannerScreen.tsx; exercised indirectly by unit tests, not directly leak-asserted |

## Coherence (Design)

| Decision | Followed? | Notes |
|---|---|---|
| ADR-001 (lazy dynamic-import OpenCV, single-thread build) | Partially -- outcome preserved, mechanism changed | Original design specified import() dynamic ESM loading (task 2.3.1). Post-implementation fixes (commits 615add8, 4d11f7a, e6ac1a6, e47e367) switched to a classic Worker + self.importScripts("/opencv/opencv.js") static asset because the ESM dynamic-import path hung in real browsers. The design intent (OpenCV excluded from initial bundle, loaded only on entering scanner mode, off the main thread) is preserved and verified; the literal mechanism in design section 3/4.3 (fetch+ReadableStream progress reporting via dynamic import()) was superseded. This is documented in engram (opencv-worker-init topic) and in the README, not silently done. |
| ADR-002 (WorkerClient RPC, drop-latest backpressure) | Yes | workerClient.ts + isBusy(), exercised by useDocumentDetection.ts loop |
| ADR-003 (WARP output via ImageBitmap transfer, not cv.imshow) | Yes | opencv.worker.ts handleWarp |
| ADR-005 (rotate/flip as non-destructive recipe, CSS transform only) | Yes | editRecipe.ts, no re-invocation of worker on rotate/flip |
| ADR-006 (import fallback feeds the same pipeline as camera capture) | Yes | captureFallback.ts returns the same CapturedFrameResult shape as captureFrame.ts |
| Section 7 resource-hygiene table (Mat .delete() in finally) | Yes (static review) | opencv.worker.ts handlers wrap Mat lifecycle in try/finally; not independently leak-tested at runtime |
| Section 11 R1/R5 calibration constants marked as "valor de partida" | Yes | detectionConstants.ts comments flag BLUR_THRESHOLD/DARK_THRESHOLD/STABILITY_MS/STABILITY_VARIANCE_PX as non-final; orderCorners R5 caveat carried into geometry.ts comments and geometry.test.ts (contract-only assertions, no exact-threshold asserts) |

## Issues Found

**CRITICAL**: None.

**WARNING**:
1. ADR-001 mechanism deviation (design coherence, not a spec break): the OpenCV loading mechanism changed from dynamic ESM import() to classic-worker importScripts after design was written. The behavioral contract (lazy-load, off-main-thread, excluded from initial bundle) still holds and is verified, but design.md section 3/4.3 now describes a superseded implementation detail. Recommend a design.md addendum or ADR-001 amendment before archive, so the artifact trail does not silently diverge from shipped code.
2. Real-camera-hardware path unverified: getUserMedia to live detection to auto-capture has never been exercised against a physical camera and a real photographed document in this verification pass (no device available). Covered by unit tests + Playwright fake-camera E2E only. This was already flagged in the original apply-progress "Next steps" and is explicitly out of automated-apply scope.
3. Empirical calibration constants unvalidated on real documents: BLUR_THRESHOLD, DARK_THRESHOLD, STABILITY_MS/STABILITY_VARIANCE_PX, and orderCorners's R5 sum/difference heuristic are all explicitly marked "valor de partida" in spec/design/tasks and remain unvalidated against real photographed/rotated documents -- task 6.8.1 covers only synthetic fixtures (0/30/45/90/170/180 degrees).
4. Headless E2E OpenCV degradation: importFixture.spec.ts (the Phase-1 acceptance E2E) cannot verify actual warp pixel output in this Playwright/Chromium headless environment because OpenCV.js never finishes initializing inside the worker there -- root-caused and documented in engram #294, not a product defect, but it means no automated test in this repository currently proves the warped image is visually correct end-to-end; that proof exists only via the manual browser+screenshot verification recorded in engram #301/#318.
5. Magnifier usability / HANDLE_HIT_SIZE=44 on real small touchscreens: not verified in this pass; carried over from Slice E per apply-progress.

**SUGGESTION**:
1. Consider adding a lightweight resource-leak regression test for the worker's finally-based Mat.delete() cleanup (e.g., asserting cv.Mat allocation count returns to baseline after N DETECT/WARP cycles) -- currently verified only by code review, not a runtime assertion.
2. Consider promoting the manual browser-verification steps recorded in engram (#301, #318) into a short, repeatable manual QA checklist file (e.g., openspec/changes/core-scanner/qa-checklist.md) so the real-device verification story is discoverable without searching engram.
3. This report's ADR-001 note above should be reconciled into design.md itself (not just this report) if the team wants the openspec artifact trail to stay authoritative post-archive.

## Known Limitations (pre-existing, documented, accepted -- not new CRITICAL findings)

- OpenCV does not initialize under npm run dev. Vite's dev server serves the worker as an ES module; the classic-worker importScripts OpenCV load path requires a classic (non-module) worker, which Vite dev does not bundle correctly. It does work in npm run build && npm run preview (confirmed by this verification's own build run and by prior browser-screenshot verification in engram #301/#318). Documented in README.md (OpenCV in npm run dev section).
- Live camera detection path not verified on real hardware. No physical device was available during implementation or this verification. Verified via types, unit tests, and Playwright fake-camera E2E only. Real-device detection accuracy and threshold calibration (R1, R5) remain open device QA.
- Playwright OpenCV E2E runs degraded in headless Chromium. This is an environment limitation (OpenCV.js WASM never completes worker initialization under headless Chromium in this setup), not a product bug -- importFixture.spec.ts explicitly asserts the degraded-but-safe behavior (no unhandled errors, Confirm stays disabled) rather than masking or ignoring it.

## Verdict

**PASS WITH WARNINGS**

Rationale: every task is complete, every CAP has real backing code and passing tests, tsc/test/build all succeed with real command output above, and the bundle-size acceptance criterion is met with hard evidence. Nothing here rises to CRITICAL -- there is no unimplemented requirement, no failing test, and no broken build. The WARNINGs are pre-existing, already-disclosed known limitations (dev-mode OpenCV, unverified real hardware, headless E2E degradation) plus one design-artifact/code coherence drift (ADR-001 mechanism) that should be reconciled in the design doc before or during archive, and should be explicitly carried forward as open follow-up items rather than silently closed.

**Recommendation**: proceed to sdd-archive, but carry WARNING items 1-5 forward into the archive report / roadmap as explicit follow-up items (device QA checklist, design.md ADR-001 amendment), so they are not lost once this change is closed.
