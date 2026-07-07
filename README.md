# Nitidoc

Document scanner PWA — capture a document with the camera (or import an image),
detect its edges, correct perspective, and get a clean, de-skewed page. Runs
entirely on-device (privacy-first); detection and perspective warp run in a Web
Worker via OpenCV.js so the UI never blocks.

Status: **Phase 1 (Core Scanner) complete** — live camera detection, auto-capture,
manual corner editor, perspective warp, and the full edge-case/fallback set.
Multipage, filters, PDF/signature export, PWA/offline, and Firebase sync are later
phases.

## Prerequisites

- Node.js 22+
- npm 10+

## Setup

```bash
npm install
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR (see the OpenCV caveat below) |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run typecheck` | `tsc --noEmit` |

The OpenCV.js asset (~10 MB, WASM embedded) is copied from `node_modules` into
`public/opencv/` by `scripts/copy-opencv.mjs`, wired as a `predev` / `prebuild` /
`pretest:e2e` hook. It is served as a static asset and **never** enters the initial
JS bundle (which stays ~60 KB gzip).

## ⚠️ OpenCV in `npm run dev` (known limitation)

OpenCV.js is the official prebuilt **classic** Emscripten UMD build. It only
bootstraps inside a **classic** Web Worker via `importScripts` — it hangs in an
ES-module worker. In a production build the detection worker is bundled as a
classic IIFE, so this works (OpenCV initializes in ~0.5 s).

**Vite's dev server does not bundle workers** (the `worker.format` option applies
to builds only): under `npm run dev` the worker is served as unbundled ES modules,
which a classic worker cannot parse. As a result **OpenCV does not initialize under
`npm run dev`** — the scanner detects this, fails fast, and **degrades gracefully**:
importing an image and the manual corner editor still work; only automatic edge
detection and the OpenCV warp are unavailable.

To exercise the full detection → warp pipeline locally, use the production build:

```bash
npm run build && npm run preview
```

This is a dev-only ergonomics limitation, not a production issue. See
the phase 1 investigation notes (topic `opencv-worker-init`) for the full
investigation.

## Architecture

Feature-sliced under `src/features/`:

```
src/
├── app/                  # layout + single scanner route (Phase 1)
├── styles/tokens.css     # design tokens (CSS variables)
├── features/scanner/
│   ├── worker/           # opencv.worker.ts (classic) + message contract
│   ├── hooks/            # useCamera, useDocumentDetection
│   ├── components/       # CameraView, CornerEditor, CaptureButton, …
│   ├── lib/              # opencvLoader, workerClient, geometry, captureFrame…
│   └── store/            # Zustand scanner store
└── shared/               # ui/, lib/, types/
```

Key principles:

- **Original frames are immutable.** Edits (corners, aspect ratio, rotation, flip)
  are a serializable `EditRecipe` applied at render/export time — enables undo and
  re-export without re-capturing.
- **Detection and warp run in a Web Worker** (`OffscreenCanvas` + transferables),
  never on the UI thread. Pure geometry is DOM-free and unit-tested.
- **Strict TypeScript**, no `any`.

## Key decisions

- **OpenCV loading**: classic worker + `self.importScripts('/opencv/opencv.js')`,
  with the absolute asset URL passed in from the main thread (a relative path fails
  to resolve in some worker contexts). The npm package's dynamic `import()` inside
  an ES-module worker hangs — see the caveat above.
- **Single-thread OpenCV.js** (no WASM threads / SIMD-threads): avoids a known
  threads-in-worker bug and the COOP/COEP headers that would complicate Firebase
  Auth later.
- **jscanify not used**: it depends on the DOM (returns `HTMLCanvasElement`) and
  cannot run in a worker; the detection pipeline is reimplemented directly on
  OpenCV.js primitives.

## Testing

- **Unit** (Vitest): geometry, detection math, edit recipe, store, camera/detection
  lifecycle, worker protocol. 130+ tests.
- **E2E** (Playwright): app shell, camera (fake media stream), permission-denied,
  corner editor, and an import-fixture flow.

Calibration thresholds (blur, darkness, corner-stability window) are starting
values pending real-device QA.
