# Capture UX Redesign — deferred processing, full-bleed no-scroll (Fase 2.3)

> Post-manual-test redesign requested by the user (a UXer). The flaky LIVE auto-detection is REMOVED from
> the capture path and DEFERRED: manual capture accumulates raw shots; edge detection + warp + filter run
> ONCE per full-res image at "Siguiente". This both fixes detection (full-res beats live 640px) and delivers
> a native, no-scroll mobile capture experience. Design synthesized + adversarially critiqued via workflow.

## Decisions (locked)
- **D-1 Review shape:** grid-first. After processing → `grid` phase (reuse PageGrid/CornerEditor/useExportPdf unchanged). No per-page swipe editor.
- **D-2 Default filter at processing:** `NEUTRAL`. User picks the document filter once in review via FilterPanel "apply to all". No adaptive worker bake during processing.
- **D-3 No-scroll scope:** `capturing` + `processing` are truly full-bleed no-scroll. `grid`/`editing-corners`/`done`/import scroll INTERNALLY inside a pinned `100dvh overflow-hidden` shell (the page/document itself never scrolls). Reason: 30 thumbnails can't fit without internal scroll.
- **D-4 WYSIWYG:** camera is full-bleed `object-cover`; the captured full-res frame is CROPPED to the visible object-cover rect so "what you frame is what you capture" (and what detection runs on).

## Phase model (`documentSlice.ts` `DocumentPhase`)
Rename `'warping'`→`'processing'`, drop `'tray'`. New set:
`'idle' | 'capturing' | 'processing' | 'grid' | 'editing-corners' | 'done'`.
- `capturing`: PERSISTENT full-bleed camera; manual raw captures accumulate; NO per-frame DETECT.
- `processing`: transient batch step (per-page detect→warp→filter→thumbnail→addPage) with progress + cancel.
- `grid`: review (reorder/delete/tap-to-edit/apply-to-all/export).
- `editing-corners`: per-page re-entry from grid (existing CornerEditor two-step).
- `done`: summary + export.

Transitions: start→`capturing`. Capture tap→stays `capturing`, appends RawCapture. "Siguiente" (enabled ≥1 raw)→`processing`→(on done)`grid`. Grid tile→`activatePage`→`editing-corners`→Confirm→`grid`. Grid "Capturar más"→`capturing` (re-arm camera). Grid "Finalizar"→`done`. `done` "Escanear otro"→`resetDocument`→`capturing`.

## Data model — RawCapture (light) vs DocumentPage (terminal)
```ts
export interface RawCapture {
  readonly id: string;             // crypto.randomUUID(); flows straight into DocumentPage.id
  readonly order: number;          // dense 0..n-1 within rawCaptures
  readonly originalBlob: Blob;     // JPEG q FILTER.JPEG_QUALITY of the (cropped) full-res original
  readonly thumbnail: ImageBitmap; // ~150px longest edge, from the UNWARPED original (for the count tile)
  readonly originalWidth: number;
  readonly originalHeight: number;
}
```
`DocumentPage` unchanged EXCEPT add `readonly needsReview?: boolean` (true when detection returned null OR non-convex → full-frame fallback; surfaced as a grid badge). At conversion the page REUSES `rawCapture.originalBlob` by reference (no re-compress).

## Memory (bounded to ~1 live full-res bitmap)
- Capture: each tap → `captureFullResFrame` → crop to visible rect (D-4) → `Promise.all([compressBitmapToJpeg→originalBlob, makeThumbnail→thumbnail])` → `fullRes.close()`. RawCapture holds blob+thumbnail only.
- Processing: strictly SEQUENTIAL (never Promise.all over pages) decode→detect(downscaled)→warp→compress→close, one raw at a time. Reuse `originalBlob` by reference into the page. Peak ≈ 1 full-res image, independent of page count.
- Cap `FILTER.PAGE_CAP` (30) enforced on `pages.length + rawCaptures.length` at the CaptureButton (disabled at cap) + defensively in `addRawCapture`.

---

## Implementation plan (ordered, green between each unit)

### Unit 1 — Store + data model  (files: store/documentSlice.ts, store/scannerStore.ts, hooks/useActivePage.ts) — ADDITIVE, build stays green
- Add `RawCapture` interface; `DocumentSlice.rawCaptures: readonly RawCapture[]` (initial `[]`).
- Add `DocumentPage.needsReview?: boolean` (optional, back-compatible).
- Actions: `addRawCapture(raw)` (append; defensive no-op at combined cap), `clearRawCaptures()` (close remaining raw thumbnails, set `[]`), `removeLastRawCapture()` (close its thumbnail, pop — for retake-last), `removeRawCapture(id)` (close+remove a specific raw — used by the processing loop as it converts each). 
- Rename phase `'warping'`→`'processing'`, remove `'tray'`. Fix any reference.
- `resetDocument`: also close every `rawCaptures[].thumbnail` before reset.
- `useActivePage`: `isAtCap`/`canAddPage` → `pages.length + rawCaptures.length >= FILTER.PAGE_CAP`. Add `materializeRawCapture({id, originalBitmap, originalWidth, originalHeight})` → compress + thumbnail (from UNWARPED original) + `addRawCapture` + close the live bitmap.
- Do NOT remove DetectionSlice fields here (that's Unit 4b). Keep build green (no consumers of new stuff yet).
- Tests: documentSlice combined-cap, raw thumbnail close on reset/clear, removeLast/removeRawCapture close hygiene; useActivePage materializeRawCapture (compress+thumb+close, cap block).

### Unit 2 — Extract `useOpenCvInit` keeper hook  (files: hooks/useOpenCvInit.ts NEW, hooks/useDocumentDetection.ts, components/ScannerScreen.tsx)
- Move the OpenCV INIT machinery (`ensureOpenCvInit`/`retryManualInit`/`attemptInit`/backoff/OpenCvSlice mirroring) OUT of useDocumentDetection into `useOpenCvInit` returning `{ ensureOpenCvInit, retryManualInit, initState, workerClient }`.
- ScannerScreen consumes init from `useOpenCvInit`. Leave the live detection loop importable for now (removed in 4b). Keep the ensure-init-on-mount behavior. Green.

### Unit 3 — Full-bleed capture screen (raw-first)  (files: components/CaptureScreen.tsx NEW, components/CaptureCountThumbnail.tsx NEW, components/CameraView.tsx, components/CaptureButton.tsx, components/ScannerScreen.tsx)
- `CameraView`: add `fill?: boolean` — when set, container is `absolute inset-0 h-full w-full` (drop `aspect-[3/4] w-full max-w-md rounded-2xl`); video stays `object-cover`. Preserve forwardRef videoRef + openCamera timing (no remount churn).
- `CaptureScreen` (rendered for `phase==='capturing'`, and idle→capturing after start):
  - `relative h-full w-full overflow-hidden bg-black` immersive layer.
  - Full-bleed `CameraView fill` (only when camera usable — see phase-gating below).
  - Top overlay (absolute, `pt-[env(safe-area-inset-top)]`, with a subtle scrim for contrast): CameraSelector (if ≥2 devices) + torch pill (if supported). Keep minimal.
  - Bottom bar (absolute, `pb-[env(safe-area-inset-bottom)]`, 3-col grid): left = `CaptureCountThumbnail`; center = round `CaptureButton`; right = floating "Siguiente" `NextButton` (only when `rawCaptures.length>0`).
  - **Capture flow (rewrite `runCaptureSequence`)**: on tap → guard (ignore if a capture is in-flight or `isAtCap`) → set `capturing-in-flight` → `captureFullResFrame` → **crop to visible object-cover rect** (D-4: compute from video.videoWidth/Height vs the displayed element rect) → `materializeRawCapture` → stay in `capturing`. Wrap in try/catch: on throw, close partial bitmap, toast, stay in `capturing`. Clear in-flight in finally.
  - **Feedback (H1 visibility of system status)**: brief screen-flash / scale-pulse on the video + `navigator.vibrate?.(15)` (guarded) + optimistic count bump (badge increments on tap, settles when thumbnail resolves). Disable CaptureButton while in-flight (anti-double-tap).
  - `NextButton` → `setPhase('processing')`. Label `t('capture.next')` (default "Siguiente"), accessible.
- `CaptureCountThumbnail`: draws the LAST raw thumbnail on a ~56px rounded canvas + count badge (`aria-live="polite"`). Provide a small "×" to `removeLastRawCapture()` (retake-last) — the tile is NOT inert.
- **Phase-gating decouple (critical)**: compute `cameraUsable = permission!=='denied' && devices.length>0 && lastCameraError==null`. Render ImportFallback / camera-error screens based on `cameraUsable`, only suppressed when phase ∈ {`editing-corners`,`processing`,`grid`,`done`}. When `!cameraUsable`, CaptureScreen renders a **no-camera variant**: NO live video, shows captured raw thumbnails + an "Import another" button + "Siguiente". Never mount live CameraView when permission!=='granted'.
- **Re-arm camera** on entry to `capturing` (effect: if phase becomes `capturing` and the stream track is missing/ended → `openCamera`), so "Capturar más"/"Escanear otro" never land on a black camera.
- Route `phase==='capturing'` (and started/idle) to CaptureScreen. Do NOT start the detection loop in capturing.
- Tests: CaptureScreen renders FAB/Next/count badge; Next gated on ≥1 capture; in-flight guard; no-camera variant; cap disables capture.

### Unit 4 — Deferred batch processing  (files: hooks/useBatchProcess.ts NEW, components/ProcessingScreen.tsx NEW, components/ScannerScreen.tsx)
- `useBatchProcess` returns `{ processing, done, total, run(), cancel() }`. Triggered on entering `processing`.
- **Run-once/idempotency guard**: a `ran` ref + a `processedIds` set so StrictMode double-invoke / re-entry never re-adds pages (dedupe by raw.id). Cleanup on unmount closes the in-flight bitmap.
- Sequence per raw (sorted by order): `await ensureOpenCvInit()` once up front (tolerate rejection → degraded path). For each raw:
  a. `decodeBlobToBitmap(originalBlob)` → originalBitmap.
  b. DETECT on downscaled copy (`createImageBitmap(orig,{resizeWidth:min(DOWNSCALE_WIDTH,originalWidth)})`); capture detectionWidth BEFORE transfer; offscreen gating + double-close guard (copy from ScannerScreen import template).
  c. Corners: `result.corners` → `scaleCornersToFullRes` → `orderCorners` → `isConvex`? use it : `frameCorners`; null → `frameCorners`. Set `needsReview=true` when fallback used.
  d. Recipe: `createInitialRecipe(corners, inferAspectRatio(corners).name)` — **VERIFY the real signature in editRecipe.ts** (NEUTRAL filter is seeded internally; do NOT pass a phantom 3rd arg). Filter stays NEUTRAL (D-2).
  e. WARP full-res: extract ImageData from originalBitmap, transfer buffer (no extra clone needed — warped once), `workerClient.warp(imageData, corners, aspectRatio)`; handle bitmap vs imagedata per offscreen.
  f. `Promise.all([makeThumbnail(warpedBase,THUMB), compressBitmapToJpeg(warpedBase,Q)])`.
  g. `addPage({id, order:pages.length, recipe, thumbnail, originalBlob:raw.originalBlob, warpedBlob, originalWidth, originalHeight, warpedWidth, warpedHeight, needsReview})`; then `removeRawCapture(raw.id)` (conserve cap, single close owner).
  h. finally: close originalBitmap + warpedBase (+ the detect downscale bitmap per guard).
- **Degraded / WARP-fail fallback (fold critique)**: if `ensureOpenCvInit` failed OR `workerClient.warp` throws for a page → build the page WITHOUT the worker: draw originalBitmap onto a main-thread canvas as the warpedBase (identity), thumbnail+compress from it, corners=frameCorners, `needsReview=true`. A page is ALWAYS created — never silently drop the only copy. (Optionally retry once before falling back.)
- After loop: `clearRawCaptures()` (defensive) → `setPhase('grid')`. If total pages created is 0 (shouldn't happen with the fallback), route to `capturing` with a banner.
- `ProcessingScreen`: full-bleed centered determinate bar + `t('processing.progress',{done,total})` + spinner + a **Cancel** that aborts the loop (closes in-flight bitmap, keeps rawCaptures, returns to `capturing`). Re-scope OpenCvDegradedBanner here.
- Tests: sequential order, one-live-page hygiene (bitmaps closed), frameCorners fallback on null detect (needsReview), per-page warp-error → degraded page (not dropped), run-once guard (no dup pages), clearRawCaptures.

### Unit 5 — No-scroll immersive shell + review/export wiring + empty states  (files: app/App.tsx, styles/tokens.css or index.css, components/ScannerScreen.tsx, components/PageGrid.tsx, index.html)
- App shell: subscribe to `phase`; `immersive = phase==='capturing'||phase==='processing'`. Root `h-[100dvh] overflow-hidden overscroll-none` with `100svh`/`100vh` fallback. Header/LanguageToggle hidden when immersive. `main`: immersive → `flex flex-1 flex-col overflow-hidden` (no padding); else → centered + `overflow-y-auto` (internal scroll, page never scrolls).
- `index.html`: ensure `<meta name="viewport" ... viewport-fit=cover>` (MANDATORY for safe-area-inset to resolve non-zero). Add `touch-action: manipulation`.
- Review/export: grid "Capturar más" → `setPhase('capturing')`; ensure editing-corners re-entry, apply-to-all, export (useExportPdf) work off processed pages (should be unchanged). needsReview badge on PageGrid tiles.
- **Empty-state PageGrid**: `pages.length===0` → "Capturar" CTA → `capturing` (no dead grid).
- Extract `PageThumbnail` into its own module `components/PageThumbnail.tsx` (grid/done still use it) so CaptureTray can be deleted in 4b.
- i18n: add `capture.next`, `processing.title`, `processing.progress` ("{done} de {total}"), `processing.failedPages`, `processing.cancel`, `grid.needsReview`, `grid.emptyCta`, import-another. Keep en/es satisfies parity.

### Unit 6 (a.k.a. 4b) — Remove dead live-detection path + prune i18n  (files: hooks/useDocumentDetection.ts DELETE, components/DetectionOverlay.tsx DELETE, components/QualityHints.tsx DELETE, components/CaptureTray.tsx DELETE, store/scannerStore.ts, lib/detectionMath.ts, lib/detectionConstants.ts, hooks/useActivePage.ts, components/CaptureButton.tsx, components/ScannerScreen.tsx, shared/i18n/en.ts, es.ts) — do LAST, once nothing consumes it
- Delete `useDocumentDetection.ts` (INIT already extracted in Unit 2), `DetectionOverlay.tsx`, `QualityHints.tsx`, `CaptureTray.tsx` (keep `PageThumbnail`, moved in Unit 5).
- scannerStore/DetectionSlice: remove live fields+actions `corners,rawCorners,quality,stability,countdown,autoCaptureEnabled,noDetectionSince` + setters + `resetDetection`/`DetectionActions`/`initialDetectionSlice` dangles. KEEP OpenCvSlice + CameraSlice.offscreenSupported.
- detectionMath.ts: delete `lerpQuad,maxCornerStdDevPx,contourAreaRatio,isTooFar,TOO_FAR_*`. KEEP `scaleCornersToFullRes`.
- detectionConstants.ts: delete `STABILITY_MS,STABILITY_STDDEV_PX,INTERP_ALPHA,BLUR_PERSIST_FRAMES,NO_DETECTION_MS,BLUR_THRESHOLD,DARK_THRESHOLD`. KEEP `DOWNSCALE_WIDTH,MIN_CONTOUR_AREA_RATIO,POLY_APPROX_EPSILON_RATIO,MAX_APPROX_POINTS,ASPECT_TOLERANCE,MAX_CAPTURE_PIXELS`.
- CaptureButton: drop the countdown aria branch (no auto-capture). Remove `materializeCapture`/`DraftCapture` (dead). 
- i18n: remove now-dead keys `scanner.autoOn/autoOff, scanner.noDocumentDetected, scanner.captureAnyway, quality.*, capture.autoCapturingIn`. Sweep every removed key's last consumer; tsc must stay green (satisfies-typed dictionaries).
- Worker/workerClient/messages: UNCHANGED (RPCs reused at processing).
- Update/remove obsolete ScannerScreen detection tests.

## Hard constraints (every unit)
- Strict TS, zero `any`. F1 hygiene: close-before-overwrite, single OffscreenCanvas per worker op, `.delete()` Mats in finally, close every ImageBitmap you decode. i18n es-default via t(). Initial bundle < 200KB gzip. Conventional commits, NO Co-Authored-By. Keep `npm run typecheck` + `npx vitest run` + `npm run build` green before each commit.

## Edge cases (must all hold)
0 captures → Next hidden. Cap 30 → capture disabled + badge. No quad → frameCorners + needsReview. Per-page WARP throw → degraded page (never dropped). Offscreen unsupported → gated + double-close guard. OpenCV never loads → degraded pages, banner, adjust in review. iOS safe areas via viewport-fit=cover. StrictMode double-mount → run-once guard, idempotent. Import/denied/no-camera → no-camera CaptureScreen variant (no black video). Camera stays open across captures + "Capturar más" (re-arm on entry). Reset/scan-again closes raw thumbnails. Processing cancel → back to capturing, rawCaptures intact.
