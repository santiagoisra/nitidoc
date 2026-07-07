# Design — multipage-filters (Fase 2: Gestion multipagina + Filtros)

> Change name: `multipage-filters` · Artifact store: openspec · Depends on: `core-scanner` (F1, archived).
> This document LOWERS the proposal's resolved decisions (D-MEM, D-CV, D1–D8) into contracts, types,
> diagrams, and ADRs. It does NOT re-open those decisions. ADR numbering CONTINUES F1 (which ended at ADR-006):
> this change adds **ADR-007 … ADR-011**.
> `sdd-spec` owns requirements/scenarios; this doc owns the HOW at architectural level. No task breakdown here.

---

## 0. What this design commits to (read this first)

| Area | Commitment |
|---|---|
| **Store** | Retire `CaptureSlice`; introduce `DocumentSlice` (N ordered pages + one active working set + pending-deletion slot). Direct migration (D5). |
| **Live memory** | Exactly ONE page materialized full-res at a time via a structural `activeWorking` field. Inactive pages hold JPEG `Blob`s + a ~150px thumbnail bitmap. Hard cap 30 pages (D-MEM). |
| **Filter model** | `EditRecipe.filter: FilterParams` — JSON only (D1). Warp base stays UNFILTERED; filter is a presentation layer (D4 / ADR-005). |
| **Filter routing** | Canvas2D `ctx.filter` for `original`/`enhanced`/`grayscale`; OpenCV worker `APPLY_FILTER` for `bw`/`bw-high-contrast`/`eco` and for any `sharpness > 0`. No WebGL (D3). |
| **Worker** | New `APPLY_FILTER` RPC on the EXISTING classic worker + `cvBindings` extension. Batches the 3 adaptive previews in ONE call. |
| **Apply-to-all** | Rewrites each page's `recipe.filter`; invalidates cached renders. No giant worker batch (D7/D8). |
| **UI** | Continuous-capture tray (camera stays open), `@dnd-kit` grid (lazy-loaded feature boundary), Toast host with 5s undo. Rewrite `ScannerScreen` + `CornerEditor` to the active-page model. |
| **F1 hygiene** | PRESERVED verbatim: close-before-overwrite, 16MP capture cap, single OffscreenCanvas per worker operation. |

### Real-code facts this design is built on (verified, not assumed)

- Worker files live under `src/features/scanner/worker/` (singular). The proposal's `workers/` path is wrong.
- `Toast` and `Sheet` primitives ALREADY exist in `src/shared/ui/` (`index.ts` re-exports both). F1 shipped Toast as a
  *presentational primitive only* — no queue, no timer, no action button. Fase 2 adds the HOST + timer + action, it does
  NOT re-create the primitive.
- The worker is a **classic** worker (`type: 'classic'`, `importScripts('/opencv/opencv.js')`, Vite `worker.format: 'iife'`).
  `APPLY_FILTER` must not assume ES-module worker features. See `workerClient.ts` header comment.
- `WorkerClient` is a **module singleton** (`getSharedWorkerClient()`), one worker per session. Its `isBusy()`/drop-latest
  backpressure is **DETECT-only**; `APPLY_FILTER` is a distinct RPC that must NOT share the DETECT in-flight gate.
- `CornerEditor` already extracts `sourceImageData` ONCE per frame via `useMemo` and CLONES a fresh buffer per warp
  because the worker transfers (detaches) the buffer. Fase 2 must keep this pattern when the source is a decoded blob.
- Store hygiene is already centralized: `setOriginalFrame`/`setWarpedImage` close the previous bitmap before overwriting.
  Fase 2 mirrors this exactly in `setActiveWorking`.

---

## 1. Data & store contracts

### 1.1 `FilterParams` + `EditRecipe` (in `src/shared/types/scanner.ts`)

```ts
export type FilterPreset =
  | 'original'
  | 'enhanced'
  | 'grayscale'
  | 'bw'
  | 'bw-high-contrast'
  | 'eco';

export interface FilterParams {
  readonly preset: FilterPreset;
  readonly brightness: number; // -100..100  (0 = neutral)
  readonly contrast: number;   // -100..100  (0 = neutral)
  readonly sharpness: number;  //    0..100  (0 = off)
}

export const NEUTRAL_FILTER: FilterParams = {
  preset: 'original',
  brightness: 0,
  contrast: 0,
  sharpness: 0,
} as const;

export interface EditRecipe {
  readonly corners: Quad;
  readonly aspectRatio: AspectRatioName;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly filter: FilterParams; // NEW — still pure JSON, no binaries (ADR-009)
}
```

> `EditRecipe` MUST remain JSON-serializable (no `ImageBitmap`/`Blob`/`Mat`). `editRecipe.ts` helpers gain a
> `withFilter(recipe, filter)` and `createInitialRecipe` seeds `filter: NEUTRAL_FILTER`. Fase 4 IndexedDB persistence
> serializes recipe + blobs unchanged — no rework.

### 1.2 `DocumentPage` — per-page record (`src/features/scanner/store/documentSlice.ts`)

```ts
export interface DocumentPage {
  readonly id: string;                 // crypto.randomUUID()
  readonly order: number;              // dense 0..n-1, always re-indexed on mutation
  readonly recipe: EditRecipe;         // includes filter; single source of truth per page (D1)

  // Layered retention (D-MEM). These persist for INACTIVE pages; live full-res
  // bitmaps live in `activeWorking`, NOT here.
  readonly thumbnail: ImageBitmap;     // ~150px longest edge, UNFILTERED warp base, cached at confirm (D6)
  readonly originalBlob: Blob;         // JPEG q0.85 of the full-res original (decode on-demand for re-warp)
  readonly warpedBlob: Blob;           // JPEG q0.85 of the UNFILTERED warp base (export/preview baseline, D4)

  // Dimensions kept so callers can size canvases / map corner coordinates
  // WITHOUT decoding a blob.
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly warpedWidth: number;
  readonly warpedHeight: number;
}
```

`DocumentPage` holds binary handles (`ImageBitmap`, `Blob`) — that is FINE and consistent with F1 (the store already
holds `ImageBitmap`). The JSON-only invariant is scoped to `EditRecipe`, not to `DocumentPage`.

### 1.3 `ActivePageResources` — the single live working set (structural D-MEM enforcement)

```ts
/**
 * The ONLY full-res materialization allowed at any moment. Because the slice
 * holds at most one of these, "one live page" is a TYPE-LEVEL invariant, not a
 * convention. Peak live full-res memory is bounded to ~1 page (~90MB) regardless
 * of document length (D-MEM).
 */
export interface ActivePageResources {
  readonly pageId: string;
  readonly originalBitmap: ImageBitmap; // decoded from originalBlob (~48MB @ 12MP), for re-warp
  readonly warpedBase: ImageBitmap;     // UNFILTERED warp base (~tens MB), for filter preview
}
```

### 1.4 `DocumentSlice` — shape + actions

```ts
export type DocumentPhase =
  | 'idle'
  | 'capturing'
  | 'editing-corners'
  | 'warping'
  | 'tray'      // continuous capture: strip of thumbnails, camera still open
  | 'grid'      // reorder / delete / per-page filter
  | 'done';

export interface DocumentSlice {
  readonly pages: readonly DocumentPage[];
  readonly activePageId: string | null;
  /** The single live working set for `activePageId`, or null when no page is materialized. */
  readonly activeWorking: ActivePageResources | null;
  /** True when the active page was re-warped since activation → warpedBlob+thumbnail must be regenerated on deactivate. */
  readonly activeDirty: boolean;
  readonly selectedPageIds: readonly string[];
  /** Undo window: retains the deleted page (resources UNRELEASED) until the 5s toast expires. */
  readonly pendingDeletion: DocumentPage | null;
  readonly phase: DocumentPhase;
}

export interface DocumentActions {
  // ── page lifecycle ──────────────────────────────────────────────
  /** Appends an already-compressed page (blobs + thumbnail produced by the capture controller). Enforces the 30 cap. */
  readonly addPage: (page: DocumentPage) => void;
  readonly setActivePageId: (id: string | null) => void;
  /** Swaps the live working set. Closes the PREVIOUS working set's bitmaps before overwrite (hygiene, mirrors setWarpedImage). */
  readonly setActiveWorking: (res: ActivePageResources | null) => void;
  readonly setActiveDirty: (dirty: boolean) => void;

  // ── edits ───────────────────────────────────────────────────────
  /** Replaces one page's recipe (corners/aspect/rotation/flip/filter). JSON only. */
  readonly updateRecipe: (pageId: string, recipe: EditRecipe) => void;
  /** After a dirty deactivate: replaces the cached warp base (closes old thumbnail before overwrite). */
  readonly updatePageWarpBase: (
    pageId: string,
    patch: Pick<DocumentPage, 'warpedBlob' | 'thumbnail' | 'warpedWidth' | 'warpedHeight'>,
  ) => void;
  /** D7/D8: writes `filter` into every page's recipe. Instant, no bitmap work. */
  readonly applyFilterToAll: (filter: FilterParams) => void;

  // ── ordering ────────────────────────────────────────────────────
  /** onDragEnd: caller passes the FULL new id order; slice re-indexes `order` densely (no partial patch). */
  readonly reorderPages: (orderedIds: readonly string[]) => void;

  // ── deletion + undo ─────────────────────────────────────────────
  /** Moves the page to `pendingDeletion`, removes it from `pages`, re-indexes. Closes activeWorking if that page was active. Resources otherwise UNRELEASED. */
  readonly deletePage: (pageId: string) => void;
  /** Undo: reinserts `pendingDeletion` at its `order`, re-indexes, clears the slot. */
  readonly restorePage: () => void;
  /** Toast expiry / superseded: HARD release — close thumbnail, drop blobs, clear the slot. */
  readonly hardReleaseDeletion: () => void;

  // ── selection + phase ───────────────────────────────────────────
  readonly setSelectedPageIds: (ids: readonly string[]) => void;
  readonly setPhase: (phase: DocumentPhase) => void;
  /** Full teardown: close activeWorking, close all thumbnails, close pendingDeletion, reset to initial. */
  readonly resetDocument: () => void;
}
```

**Migration note (task group 1, first in the cut):** `CaptureSlice` and its actions
(`setOriginalFrame`, `setWarpedImage`, `setRecipe`, `resetCaptureSlice`, plus the `phase`/`setPhase` it owns) are
REMOVED. `ScannerScreen` and `CornerEditor` are rewritten to the active-page model. **F1 tests that assume the
single-page shape are rewritten as their own task group** (store, `CornerEditor`, `ScannerScreen`). `OpenCvSlice`,
`CameraSlice`, `DetectionSlice` are untouched.

### 1.5 Store-level hygiene rules (NORMATIVE — extend F1 §7)

| Action | close() ownership |
|---|---|
| `setActiveWorking(next)` | If `prev.originalBitmap !== next?.originalBitmap` → `prev.originalBitmap.close()`. Same for `warpedBase`. (close-before-overwrite) |
| `updatePageWarpBase` | Close the page's PREVIOUS `thumbnail` before assigning the new one. `warpedBlob` is GC'd. |
| `deletePage` | If deleting the active page → `setActiveWorking(null)` (closes its bitmaps). Page's own `thumbnail`+blobs stay alive in `pendingDeletion`. |
| `hardReleaseDeletion` | `pendingDeletion.thumbnail.close()`; blobs dropped. |
| A SECOND `deletePage` while one is pending | Controller first calls `hardReleaseDeletion()` on the older pending page (only one slot), then proceeds. |
| `resetDocument` | Close `activeWorking` bitmaps, every `page.thumbnail`, and `pendingDeletion.thumbnail`. |
| Re-warp while active | Worker returns a fresh `warpedBase`; `setActiveWorking` closes the previous `warpedBase`. `setActiveDirty(true)`. |

---

## 2. Layered memory lifecycle (D-MEM) — the load-bearing design

This section defines precisely WHEN each resource is materialized/compressed/released and WHO owns `close()`.
Async decode/compress orchestration lives in a controller hook (`useActivePage`) and pure helpers
(`src/features/scanner/lib/pageResources.ts`); the STORE actions are synchronous and own only the close-before-overwrite
hygiene.

### 2.1 State/lifecycle diagram

```
                    capture confirmed (corner editor)                       activatePage(id)
                    ┌───────────────────────────────┐          ┌──────────────────────────────────────┐
                    ▼                                │          ▼                                        │
   ┌─────────┐  compress+thumbnail   ┌──────────────────────┐  decode blobs   ┌──────────────────────┐  │
   │ CAPTURE │ ───────────────────►  │  INACTIVE (in grid)  │ ──────────────► │  ACTIVE (working set) │  │
   │ (live   │  addPage()            │  thumbnail (~120KB)   │  setActive-     │  originalBitmap ~48MB  │  │
   │ bitmaps)│                       │  originalBlob ~1-3MB  │  Working(res)   │  warpedBase   ~tens MB │  │
   └─────────┘                       │  warpedBlob   ~1-3MB  │ ◄────────────── │  (recipe.filter live)  │  │
                                     └──────────┬───────────┘  deactivate:     └───────────┬──────────┘  │
                                                │              close bitmaps;               │             │
                                                │              if dirty → recompress         │ re-warp:    │
                                                │              warpedBlob+thumbnail          │ swap        │
                                                │                                            │ warpedBase  │
                                                │ deletePage()                               └─────────────┘
                                                ▼
                                     ┌──────────────────────┐  5s toast expiry / superseded
                                     │  pendingDeletion      │ ───────────────────────────►  HARD RELEASE
                                     │  (resources retained) │                               close thumbnail,
                                     │  Undo → restorePage() │ ◄──────────────────────────   drop blobs
                                     └──────────────────────┘
```

### 2.2 Transition contracts

| Transition | Trigger | Steps (WHO owns close) |
|---|---|---|
| **Materialize on capture** | Corner editor `Confirm` in capture flow | Controller has live `originalBitmap` (from capture) + `warpedBase` (from `WARP_RESULT`). It (1) makes thumbnail (§2.3), (2) `compressBitmapToJpeg` both → `originalBlob`/`warpedBlob`, (3) `addPage(page)`, (4) closes the live `originalBitmap`+`warpedBase` (the new inactive page keeps only thumbnail+blobs), (5) `setActiveWorking(null)`, returns to camera (tray). Peak: one live page during capture only. |
| **Activate** | Tap a page in the grid | Controller: (1) if a different page is active → run **Deactivate** first, (2) `decodeBlobToBitmap(originalBlob)` and `decodeBlobToBitmap(warpedBlob)`, (3) `setActiveWorking({pageId, originalBitmap, warpedBase})`, (4) `setActivePageId(id)`, `setActiveDirty(false)`. `setActiveWorking` closes any previous working bitmaps. |
| **Deactivate** | Switch page / leave editor / delete active | Controller: (1) if `activeDirty` → recompress current `warpedBase` → new `warpedBlob` + new thumbnail, `updatePageWarpBase(...)`, (2) `setActiveWorking(null)` (closes `originalBitmap`+`warpedBase`), `setActivePageId(null)`, `setActiveDirty(false)`. |
| **Re-warp (active)** | Corner/aspect change in editor | Worker `WARP(originalBitmap→ImageData, corners, aspect)` → new `warpedBase` bitmap. Controller: `setActiveWorking({...prev, warpedBase: fresh})` (closes old `warpedBase`), `setActiveDirty(true)`, `updateRecipe(pageId, {...recipe, corners, aspectRatio})`. **Filter changes never re-warp** (D4). |
| **Delete** | Trash on a page | `deletePage(id)` → moves to `pendingDeletion` (retains thumbnail+blobs), removes from `pages`, re-indexes. If active → `setActiveWorking(null)`. Controller shows a Toast (Undo, 5s) and arms a 5s timer. |
| **Undo** | Toast "Undo" within 5s | Controller cancels timer → `restorePage()` reinserts at `order`, re-indexes. Resources intact (never released). |
| **Hard release** | 5s timer fires OR a new delete supersedes | `hardReleaseDeletion()` → `pendingDeletion.thumbnail.close()`, blobs dropped, slot cleared. |
| **Cap reached** | `addPage` with `pages.length >= 30` | Tray blocks capture with a hint BEFORE capturing (controller checks `pages.length`); `addPage` also no-ops defensively over cap. `30` is a **starting value, calibrate in apply**. |

### 2.3 Compression + thumbnail parameters (starting values, calibrate in apply)

| Parameter | Starting value | Notes |
|---|---|---|
| JPEG quality | `0.85` | `OffscreenCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })`. Fallback: `<canvas>.toBlob` when no OffscreenCanvas. |
| Thumbnail longest edge | `150` px | Downscale the UNFILTERED `warpedBase` (preserves aspect). Filter preview on thumbnails is DERIVED at render (§3), not baked into the cached thumbnail. |
| Page cap | `30` | Hard block; D-MEM. |
| Re-warp source | decoded `originalBlob` | Trade-off (D-MEM, accepted): re-warp starts from a lossy JPEG of the original, not the pristine bitmap. Acceptable because most captures already arrive as camera JPEG and 48MB-live/page is not viable on iOS. |

Pure helpers (`pageResources.ts`, DOM/OffscreenCanvas allowed, no OpenCV, unit-testable where math-only):
`compressBitmapToJpeg(bitmap, quality)`, `decodeBlobToBitmap(blob)`, `makeThumbnail(bitmap, maxEdge)`.

---

## 3. Filter render pipeline

The renderer is a **two-stage** pipeline over the UNFILTERED `warpedBase` (ADR-005 / D4). Nothing here re-invokes WARP.

### 3.1 Routing diagram

```
                         recipe.filter (preset, brightness, contrast, sharpness)
                                            │
              needsWorker = preset ∈ {bw, bw-high-contrast, eco}  OR  sharpness > 0
                                            │
                 ┌──────────────────────────┴──────────────────────────┐
                 │ needsWorker = true                                    │ needsWorker = false
                 ▼                                                       ▼
   STAGE 1 (WORKER · APPLY_FILTER)                          STAGE 1 skipped → intermediate = warpedBase
   base → adaptiveThreshold / morphology / filter2D
   (brightness+contrast folded in via convertScaleAbs)
        │  bw/bw-hc/eco → binary/near-binary RGBA
        │  sharpness>0 on a color/gray preset → sharpened RGBA
        ▼
   intermediate bitmap
                 │                                                       │
                 └──────────────────────────┬──────────────────────────┘
                                            ▼
   STAGE 2 (MAIN · Canvas2D ctx.filter)  — presentation only
     preset original  → ctx.filter = 'none'
     preset enhanced  → brightness()·contrast()·saturate(SAT)
     preset grayscale → grayscale(1)·brightness()·contrast()
     adaptive presets → ctx.filter = 'none'  (brightness/contrast already folded into STAGE 1)
                                            ▼
   STAGE 3 (MAIN · CSS transform)  — recipe rotation/flip (existing ADR-005 `recipeToCssTransform`)
```

### 3.2 Slider → CSS mapping (Stage 2)

| Slider | Range | CSS function | Mapping |
|---|---|---|---|
| brightness | -100..100 | `brightness(v)` | `v = 1 + brightness/100` → 0..2 (1 = neutral) |
| contrast | -100..100 | `contrast(v)` | `v = 1 + contrast/100` → 0..2 (1 = neutral) |
| enhanced saturation | fixed | `saturate(SAT)` | `SAT = 1.3` starting value |
| grayscale | preset | `grayscale(1)` | always full for the `grayscale` preset |

Helper `buildCssFilter(filter: FilterParams): string` lives in a new pure module `src/features/scanner/lib/filterPipeline.ts`
(unit-testable: maps params → CSS string, and decides `needsWorker(filter): boolean`).

### 3.3 Slider → worker mapping (Stage 1)

| Slider | Worker use |
|---|---|
| brightness/contrast (adaptive presets) | `convertScaleAbs(gray, gray, alpha = 1 + contrast/100, beta = brightness * BETA_SCALE)` BEFORE `adaptiveThreshold`. `BETA_SCALE = 0.5` starting. |
| sharpness | `filter2D` with a 3×3 unsharp kernel blended by `α = sharpness/100` (§4.4). |

### 3.4 Where each render happens

| Context | What renders | Cost control |
|---|---|---|
| Preset preview (6 tiles) | Applied to the ~150px thumbnail. The 3 ADAPTIVE presets are computed in ONE batched `APPLY_FILTER` call (§4.3); the 3 CSS presets are `ctx.filter` on the thumbnail (instant). | Never re-render full-res for a preview. |
| Active-page live preview | Applied to `warpedBase` (active working set) at display resolution. Worker path debounced on slider drag (~120ms starting). | Single in-flight `APPLY_FILTER`; latest-wins (see §4.5). |
| Grid tile | The cached base thumbnail through the routing (CSS instant; adaptive uses a transient filtered-thumbnail cache keyed by `filterSignature(filter)`, evicted on filter change). | No full-res. |
| Export quality (Fase 3 consumes) | Full-res: decode `warpedBlob` → `APPLY_FILTER`/CSS at full size, on demand only. | Never on slider tweak. |

`filterSignature(filter)` = stable string of the 4 fields; used to memoize/evict derived filtered previews.

---

## 4. Worker `APPLY_FILTER` contract

### 4.1 Message shape (`worker/messages.ts` additions)

```ts
// ── request ────────────────────────────────────────────────────────
export interface FilterVariant {
  readonly preset: FilterPreset;
  readonly brightness: number;
  readonly contrast: number;
  readonly sharpness: number;
}

export interface ApplyFilterRequest {
  readonly id: number;
  readonly type: 'APPLY_FILTER';
  /** Base = UNFILTERED warp (thumbnail-sized for previews, full-res for export). `data.buffer` transferred. */
  readonly image: ImageDataLike;
  /** 1 variant (single active/export render) OR up to 3 (batched adaptive previews). Same base image reused. */
  readonly variants: readonly FilterVariant[];
  /** false → reply with ImageBitmap(s) (needs worker OffscreenCanvas); true → reply with ImageDataLike (fallback, design §8 parity). */
  readonly outputBitmap: boolean;
}

// ── response ───────────────────────────────────────────────────────
export type FilteredResult =
  | { readonly kind: 'bitmap'; readonly bitmap: ImageBitmap }
  | { readonly kind: 'imagedata'; readonly image: ImageDataLike };

export interface ApplyFilterResponse {
  readonly id: number;
  readonly type: 'APPLY_FILTER_RESULT';
  /** Same order and length as request.variants. */
  readonly results: readonly FilteredResult[];
}

// unions extended:
export type WorkerRequest  = InitRequest | DetectRequest | DetectRequestImageData | WarpRequest | ApplyFilterRequest;
export type WorkerResponse = ProgressEvent | InitDoneResponse | DetectResponse | WarpResponse
                           | WarpResponseImageData | ApplyFilterResponse | ErrorResponse;
export type WorkerErrorCode = /* …existing… */ | 'FILTER_FAILED';
```

### 4.2 Transfer table (extends F1 §1.2)

| Message | Payload | Mechanism |
|---|---|---|
| `APPLY_FILTER` (→worker) | `image` base | **transfer** `[image.data.buffer]` (zero-copy; detaches on caller — clone if reused, same as WARP) |
| `APPLY_FILTER_RESULT` (→main) | `results[]` | transfer ALL: every `bitmap` and every `image.data.buffer` in one `postMessage` transfer list |

### 4.3 Batching (3 previews, 1 roundtrip)

The base `image` is decoded to `srcMat` (and `grayMat`) **once**; each variant reuses them (clone gray per variant so
the shared gray is never mutated). Output canvas is a single reusable `filterCanvas` OffscreenCanvas (§F1 hygiene: one
canvas per operation), used sequentially: `putImageData` → `transferToImageBitmap` per variant. Every per-variant Mat is
created inside the try and `.delete()`'d in `finally` (§F1 §7). This avoids 3 DETECT-style roundtrips for the preview row.

### 4.4 The OpenCV pipeline (starting values — calibrate in apply)

```
applyVariant(srcRgba, gray, variant):
  # brightness/contrast pre-gain (adaptive presets only; color presets do B/C in CSS Stage 2)
  work = clone(gray)
  if variant.preset in {bw, bw-high-contrast, eco}:
      convertScaleAbs(work, work, alpha = 1 + variant.contrast/100, beta = variant.brightness * 0.5)

  switch variant.preset:
    bw:                                                  # blockSize 15, C 10
      adaptiveThreshold(work, out, 255, ADAPTIVE_THRESH_GAUSSIAN_C, THRESH_BINARY, 15, 10)
    bw-high-contrast:                                    # denoise speckle
      adaptiveThreshold(work, out, 255, ADAPTIVE_THRESH_GAUSSIAN_C, THRESH_BINARY, 25, 15)
      kernel = getStructuringElement(MORPH_RECT, Size(3,3))
      morphologyEx(out, out, MORPH_OPEN, kernel)         # remove specks; delete kernel in finally
    eco:                                                 # preserve faint gray (less "ink")
      adaptiveThreshold(work, out, 255, ADAPTIVE_THRESH_MEAN_C, THRESH_BINARY, 15, 7)
    original | enhanced | grayscale:
      out = srcRgba (or gray for grayscale) — worker only reached here when sharpness>0

  # sharpness (any preset, if variant.sharpness > 0) — 3x3 unsharp blended by α
  if variant.sharpness > 0:
      α = variant.sharpness / 100
      sharpen3x3 = [ 0,-1, 0, -1, 5,-1, 0,-1, 0 ]
      kernelData = blend(identity3x3, sharpen3x3, α)     # (1-α)*I + α*sharpen
      k = matFromArray(3, 3, CV_32F, kernelData)
      filter2D(out, out, -1 /*ddepth=src*/, k)           # delete k in finally

  # single-channel results (bw/bw-hc/eco/grayscale) → back to RGBA for ImageData
  if out is 1-channel: cvtColor(out, outRgba, COLOR_GRAY2RGBA) else outRgba = out
  return outRgba
```

Starting-value constants centralized in `src/features/scanner/lib/filterConstants.ts` (mirrors F1's `detectionConstants.ts`):
```ts
export const FILTER = {
  JPEG_QUALITY: 0.85,
  THUMBNAIL_MAX_EDGE: 150,
  PAGE_CAP: 30,
  ENHANCED_SATURATION: 1.3,
  BETA_SCALE: 0.5,
  SLIDER_DEBOUNCE_MS: 120,
  BW_BLOCK_SIZE: 15,     BW_C: 10,
  BW_HC_BLOCK_SIZE: 25,  BW_HC_C: 15,
  ECO_BLOCK_SIZE: 15,    ECO_C: 7,
  MORPH_KERNEL: 3,
} as const;
```

### 4.5 Backpressure (distinct from DETECT)

`APPLY_FILTER` does NOT go through the DETECT drop-latest gate (`detectInFlight`/`isBusy`). The `WorkerClient` gains an
`applyFilter(...)` method with its own **latest-wins-per-target** discipline owned by the CALLER (the filter controller):
while a filter render for the active page is in flight, a newer slider value supersedes it; the stale result's bitmaps are
CLOSED on arrival (same monotonic-sequence guard `CornerEditor.runWarp` already uses). One worker, still serialized, but
DETECT and APPLY_FILTER coexist via the shared `id` map.

### 4.6 `cvBindings.ts` typing plan (narrow local typing — same pattern as F1)

Add to `CvBindings`:
```ts
adaptiveThreshold(src: CvMat, dst: CvMat, maxValue: number, adaptiveMethod: number,
                  thresholdType: number, blockSize: number, C: number): void;
morphologyEx(src: CvMat, dst: CvMat, op: number, kernel: CvMat): void;
getStructuringElement(shape: number, ksize: CvSize): CvMat;
filter2D(src: CvMat, dst: CvMat, ddepth: number, kernel: CvMat): void;
convertScaleAbs(src: CvMat, dst: CvMat, alpha: number, beta: number): void;

readonly ADAPTIVE_THRESH_MEAN_C: number;
readonly ADAPTIVE_THRESH_GAUSSIAN_C: number;
readonly THRESH_BINARY: number;
readonly MORPH_RECT: number;
readonly MORPH_OPEN: number;
readonly COLOR_GRAY2RGBA: number;
readonly CV_32F: number;   // filter2D / structuring-element kernels
```
All confirmed present in `@techstark/opencv-js@^4.10.0` type defs (D-CV). Kernel Mats built via `matFromArray(..., CV_32F, ...)`
and `getStructuringElement` are worker-owned → `.delete()` in `finally` (§F1 §7). New reusable `filterCanvas: OffscreenCanvas`
singleton alongside `detectCanvas`/`warpCanvas`.

---

## 5. UI / component plan

### 5.1 Phase-driven `ScannerScreen` rewrite (active-page model)

```
idle ──start──► capturing ──► editing-corners ──confirm──► addPage ──► tray ──"Listo"──► grid ──► done
                                    ▲                                   │  (camera open)      │
                                    │                                   └─── capture next ────┘
                                    └───────────── activatePage (from grid tile) ─────────────┘
```

- `ScannerScreen` reads `phase` from `DocumentSlice` and renders: camera+tray (`capturing`/`tray`), `CornerEditor`
  (`editing-corners`), `PageGrid` (`grid`), done summary (`done`). Camera lifecycle + degraded mode + import fallback are
  UNCHANGED from F1 (they belong to Camera/OpenCV slices).
- **Continuous capture:** after `Confirm`, the capture controller runs Materialize-on-capture (§2.2) and returns to the
  camera with `phase = 'tray'`, reusing F1's `handleEditorCancel` resume pattern (`startDetection`). Camera stays open.

### 5.2 Tray (`CaptureTray`)

Horizontal strip of cached thumbnails at the foot of the camera + page counter + "Listo" (→ grid). Never renders full-res
(D6). Blocks new capture at the 30 cap with an inline hint. Reads `pages` (thumbnails only).

### 5.3 Grid (`PageGrid`) — lazy-loaded feature boundary

- New deps `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`, isolated behind `React.lazy(() => import('./PageGrid'))`
  so dnd-kit stays OUT of the initial bundle (respects F1's <200KB gzip budget).
- `onDragEnd` → `reorderPages(newOrderedIds)` (FULL re-index, no partial patch → no gaps/dupes).
- Tap a tile → activate (§2.2) → `phase = 'editing-corners'` (editor + filter panel bound to the active page).
- Trash on a tile → `deletePage` + Toast/undo (§5.5).

### 5.4 `CornerEditor` rewrite + `FilterPanel`

- `CornerEditor` now reads the ACTIVE page: source is `activeWorking.originalBitmap` (instead of `CaptureSlice.originalFrame`),
  recipe is the active page's recipe. Re-warp writes the fresh `warpedBase` into `activeWorking` (`setActiveWorking`) and
  `updateRecipe(activePageId, ...)` + `setActiveDirty(true)`. The existing extract-once/clone-per-warp pattern is preserved,
  sourced from the decoded bitmap.
- **`FilterPanel`** (new, may use the existing `Sheet` primitive): 6 preset tiles (previewed via §3.4), 3 sliders
  (brightness/contrast/sharpness) mapped per §3.2/§3.3, and an **"Apply to all"** button that confirms then calls
  `applyFilterToAll(filter)` (D7). Writes go through `updateRecipe(activePageId, withFilter(recipe, filter))`. Filter changes
  NEVER re-warp (D4) — they re-render Stage 1/2 only.

### 5.5 Toast host + undo (extends the EXISTING `shared/ui/Toast`)

- `Toast` primitive already exists (presentational). Fase 2 adds:
  - `action?: { label: string; onClick: () => void }` and `durationMs?: number` to `ToastProps`.
  - `ToastHost` (new, `shared/ui`) — renders a queue, owns per-toast auto-dismiss timers, exposes `useToast()`.
- Deletion flow: a scanner controller (`usePageDeletion`) calls `deletePage`, shows a Toast with an "Undo" action and a 5s
  timer. Undo → cancel timer + `restorePage()`. Timer fires → `hardReleaseDeletion()`. The **store** owns retention state;
  the **hook** owns the timer; `ToastHost` owns rendering. `5000ms` is a starting value.

---

## 6. ADRs (continuing F1 numbering; F1 ended at ADR-006)

### ADR-007 — Layered per-page memory model with a single structural live working set
- **Context (D-MEM):** a 12MP `ImageBitmap` ≈ 48MB RGBA; retaining `originalFrame` + `warpedImage` live per page makes 5
  pages ≈ 450MB and kills a mid-range iOS tab. Naive "retain all" is unsafe; naive "release all" loses instant re-warp.
- **Decision:** inactive pages hold ONLY a ~150px thumbnail bitmap + two JPEG `Blob`s (`originalBlob`, `warpedBlob`). At most
  ONE page is materialized full-res, held in a dedicated `activeWorking: ActivePageResources | null` slice field —
  "one live page" is a type-level invariant, not a convention. Hard cap 30 pages. Activation decodes blobs; deactivation
  recompresses if dirty then closes bitmaps.
- **Consequences:** (+) peak full-res memory ~1 page (~90MB), constant in document length; (+) blobs are serializable →
  Fase 4 IndexedDB for free; (+) close-before-overwrite centralized in `setActiveWorking`. (−) re-warp starts from a lossy
  JPEG of the original (accepted D-MEM trade-off); (−) activation pays a decode + a possible recompress on switch.
- **Rejected:** live bitmaps per page (OOM on iOS); keeping only recipes and re-deriving from a single retained original
  (can't, each page is a distinct capture).

### ADR-008 — No WebGL: Canvas2D `ctx.filter` + OpenCV worker cover all 6 presets (D3)
- **Context:** the 6 presets need brightness/contrast/saturate/grayscale (cheap, per-pixel) and adaptive B&W +
  sharpen (neighborhood ops).
- **Decision:** `original`/`enhanced`/`grayscale` render via Canvas2D `ctx.filter` on the main thread (instant, zero deps);
  `bw`/`bw-high-contrast`/`eco` and any `sharpness > 0` render via the EXISTING OpenCV worker (`APPLY_FILTER`). No WebGL/shaders.
- **Consequences:** (+) no second render subsystem (no context-loss handling, no GLSL reimplementation of adaptiveThreshold);
  (+) reuses the already-hot worker and loaded imgproc. (−) `ctx.filter` support assumed (broadly available; degrade to
  worker path or plain draw if absent — verify in apply).
- **Rejected:** WebGL color pipeline (D3) — unjustified second subsystem when Canvas2D + worker already cover every preset.

### ADR-009 — Filter lives in `EditRecipe`; warp base stays unfiltered (D1/D4)
- **Context:** the filter must be undoable, per-page, and not force a re-warp on every tweak.
- **Decision:** `FilterParams` is a field of `EditRecipe` (one source of truth per page, still pure JSON). The cached
  `warpedBase`/`warpedBlob` are UNFILTERED; the filter is a presentation layer applied over the base (extends ADR-005).
  Changing preset/sliders re-renders Stage 1/2 only — WARP is never re-invoked.
- **Consequences:** (+) preset switching is instant; (+) non-destructive; (+) recipe stays serializable. (−) export must
  re-apply the filter at full-res on demand (Fase 3), which is the intended lazy-render behavior (D8).

### ADR-010 — Direct store migration `CaptureSlice → DocumentSlice`, F1 tests rewritten (D5)
- **Context:** F1's single-page `CaptureSlice` is already on `main`. A compatibility wrapper would add permanent indirection.
- **Decision:** remove `CaptureSlice` and its actions outright; introduce `DocumentSlice`. Rewrite `ScannerScreen` and
  `CornerEditor` to the active-page model. Rewrite the F1 tests that assume single-page shape as their OWN task group
  (first in the cut), not as collateral fixes.
- **Consequences:** (+) no lasting compatibility cruft; (+) clean active-page model. (−) a non-additive breaking change with
  a dedicated test-rewrite cost, budgeted explicitly.

### ADR-011 — "Apply to all" = recipe rewrite + lazy per-page render (D7/D8)
- **Context:** applying one filter to every page must feel instant and must not fire a giant worker batch.
- **Decision:** `applyFilterToAll(filter)` writes the same `FilterParams` into every page's recipe (with UI confirmation,
  overwriting individual filters) and invalidates cached filtered previews. The real per-page render happens lazily, per
  page, on view/export. No document-level filter state exists — the per-page recipe remains the only truth (ADR-005).
- **Consequences:** (+) instant, memory-flat, no N-page worker storm; (+) consistent with the non-destructive model.
  (−) first view/export of each page pays its own render (acceptable, matches lazy-render intent).

---

## 7. Migration & sequencing note (for `sdd-tasks`)

Ordering is prescriptive; task group 1 is the breaking migration.

1. **Store migration (breaking, first):** add `FilterParams` to `EditRecipe`; introduce `DocumentSlice`
   (state + sync actions + hygiene §1.5); remove `CaptureSlice`. Rewrite `ScannerScreen`/`CornerEditor` to the active-page
   model. **Rewrite impacted F1 tests** (store, `CornerEditor`, `ScannerScreen`) — own sub-group, budgeted work.
2. **Memory lifecycle:** `pageResources.ts` helpers (`compressBitmapToJpeg`/`decodeBlobToBitmap`/`makeThumbnail`) +
   `useActivePage` controller (Materialize/Activate/Deactivate/Re-warp, §2.2). Verify peak-memory behavior on iOS in apply.
3. **Worker filters:** extend `cvBindings.ts` (§4.6); add `APPLY_FILTER` handler + `filterCanvas` singleton; `WorkerClient.applyFilter`;
   `filterPipeline.ts` (`needsWorker`/`buildCssFilter`/`filterSignature`). **Calibrate adaptiveThreshold/morphology/sharpen in apply.**
4. **Filter UI:** `FilterPanel` (presets + sliders + apply-to-all), preview routing (§3.4), debounce.
5. **Tray + grid:** `CaptureTray`; `PageGrid` behind `React.lazy` with `@dnd-kit`; `reorderPages`.
6. **Delete + undo:** extend `Toast` (action + duration) + `ToastHost`/`useToast`; `usePageDeletion` (5s timer);
   `deletePage`/`restorePage`/`hardReleaseDeletion`.

**Preserved F1 hygiene (NON-NEGOTIABLE):** close-before-overwrite (now also `setActiveWorking`/`updatePageWarpBase`),
16MP capture cap (unchanged capture path), single OffscreenCanvas per worker operation (add `filterCanvas`).

## 8. Empirical items to close in apply (not fixed here)

- **[MEDIUM]** `adaptiveThreshold` `blockSize`/`C` per preset and morphology kernel — starting values §4.4; calibrate on real docs.
- **[MEDIUM]** Full-res `filter2D` sharpen cost — not prototyped; measure and, if too slow, cap sharpen to display-res + defer full-res to export.
- **[MEDIUM]** JPEG q0.85 re-warp degradation — validate perceived quality; raise quality or store a higher-q original if needed.
- **[LOW]** `@dnd-kit` lazy-load bundle impact — confirm the initial bundle stays <200KB gzip.
- **[LOW]** `ctx.filter` availability on target browsers — degrade gracefully if absent.
- **[LOW]** Page cap 30 and slider debounce 120ms — tune by feel.

## 9. Traceability (proposal decision → design artifact)

| Decision | Design artifact |
|---|---|
| D-MEM | §1.3 `ActivePageResources`, §2 lifecycle, ADR-007 |
| D-CV | §4.6 `cvBindings` extension, §4.4 pipeline |
| D1 | §1.1 `EditRecipe.filter`, ADR-009 |
| D2 | §3.1 routing (worker for adaptive), §4 |
| D3 | §3 Canvas2D path, ADR-008 |
| D4 | §2.2 filter-never-re-warps, §3 base unfiltered, ADR-009 |
| D5 | §1.4 migration, §7, ADR-010 |
| D6 | §2.3 thumbnail cached at confirm, §5.2/§5.3 |
| D7 | §1.4 `applyFilterToAll`, §5.4, ADR-011 |
| D8 | §3.4 lazy render, ADR-011 |
</content>
</invoke>
