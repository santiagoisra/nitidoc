# Low-Contrast Page Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably detect and rank the topmost document in low-contrast, shadowed, reflective, and overlapping iPhone captures without increasing unsafe automatic crops.

**Architecture:** Keep the existing local OpenCV.js worker and independent acceptance gate. Replace the two-mask, area-first detector with bounded multi-channel candidate generation, deterministic fusion and evidence scoring, then make one conditional 960 px retry at the batch/source boundary when the 640 px result is absent or ambiguous.

**Tech Stack:** TypeScript 5.7, OpenCV.js 4.10, Vitest 3, Playwright 1.49, React 18, jpeg-js.

## Global Constraints

- The target in overlapping scenes is the topmost, nearest visible document, even when a lower sheet is larger.
- Photo 9 is excluded entirely because it contains a recognizable child; raw attachments and EXIF are never committed.
- Processing stays local and offline-capable. Do not add network inference, telemetry, or a learned model.
- Preserve the current four-edge and border-contact acceptance checks. New ambiguity evidence may reject more candidates but may never authorize a crop that currently fails.
- Run the complete ensemble at 640 px first and at most one sequential 960 px retry.
- Warm p95 detection latency on the target iPhone must remain at or below two seconds; cold and warm runs are reported separately.
- OpenCV strategies run sequentially and delete every caller-owned `Mat`, `MatVector`, fetched contour, and lines matrix exactly once.
- The installed OpenCV.js runtime does not expose CLAHE despite stale generated typings. Do not call `cv.createCLAHE` or `cv.CLAHE`.
- Keep the worker as a classic IIFE worker loaded with `importScripts`; do not convert it to a module worker.
- Keep the iOS/WebKit main-thread `ImageData` extraction path; worker `OffscreenCanvas` drawing remains unsupported for this flow.

---

## File Structure

```text
scripts/
  prepare-detection-corpus.mjs       metadata-free resize/re-encode importer
tests/unit/fixtures/low-contrast/
  README.md                          provenance, privacy, annotation rules
  iphone-low-contrast-001.jpg/json   14 approved fixture/sidecar pairs
  ...
  iphone-low-contrast-014.jpg/json
tests/unit/helpers/
  detectionCorpus.ts                 corpus loader and geometric metrics
tests/unit/
  detectionCorpusFixtures.test.ts    privacy/schema/ground-truth checks
  candidateGenerators.test.ts        real OpenCV generator regressions
  candidateFusion.test.ts            pure candidate deduplication tests
  candidateScoring.test.ts           pure ordering and ambiguity tests
src/features/scanner/worker/
  candidateTypes.ts                  private candidate/evidence types
  candidateGenerators.ts             channels, contours, gradients, lines
  candidateFusion.ts                 strategy-aware geometric deduplication
  candidateScoring.ts                evidence extraction and ranking
  detectPipeline.ts                  bounded orchestration only
  cvBindings.ts                      verified OpenCV runtime surface
  messages.ts                        wire-safe diagnostics
src/features/scanner/lib/
  detectionConstants.ts              generator, score, retry, budget values
  detectionAcceptance.ts             unchanged safety gate plus ambiguity veto
src/features/scanner/hooks/
  useBatchProcess.ts                 640-first and conditional 960 retry
docs/qa/
  2026-08-08-low-contrast-page-detection.md  physical iPhone evidence
```

---

### Task 1: Build the privacy-safe corpus and metric harness

**Files:**
- Create: `scripts/prepare-detection-corpus.mjs`
- Create: `tests/unit/fixtures/low-contrast/README.md`
- Create: `tests/unit/fixtures/low-contrast/iphone-low-contrast-001.jpg` through `iphone-low-contrast-014.jpg`
- Create: matching `tests/unit/fixtures/low-contrast/iphone-low-contrast-001.json` through `iphone-low-contrast-014.json`
- Create: `tests/unit/helpers/detectionCorpus.ts`
- Create: `tests/unit/detectionCorpusFixtures.test.ts`

**Interfaces:**
- Produces: `DetectionCorpusAnnotation`, `DetectionCorpusFixture`, `loadDetectionCorpus()`, `normalizedCornerError()`, and `isQuadWithinGate()`.
- Consumes: `Quad` and `Point` from `@/shared/types/geometry` using the existing `[topLeft, topRight, bottomRight, bottomLeft]` order.

- [ ] **Step 1: Write the failing corpus validation test**

```ts
// tests/unit/detectionCorpusFixtures.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadDetectionCorpus } from './helpers/detectionCorpus';

describe('low-contrast detection corpus', () => {
  it('contains exactly the 14 approved metadata-free fixtures', async () => {
    const fixtures = await loadDetectionCorpus();
    expect(fixtures).toHaveLength(14);
    expect(fixtures.every(({ annotation }) => annotation.target === 'topmost-document')).toBe(true);
    expect(fixtures.some(({ sourcePath }) => sourcePath.includes('Foto-9'))).toBe(false);
    for (const fixture of fixtures) {
      expect(fixture.jpeg.includes(Buffer.from('Exif\0\0'))).toBe(false);
      expect(fixture.annotation.quad).toHaveLength(4);
      for (const point of fixture.annotation.quad) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test and verify the corpus is missing**

Run: `npm test -- tests/unit/detectionCorpusFixtures.test.ts`

Expected: FAIL because `detectionCorpus.ts` and the fixtures do not exist.

- [ ] **Step 3: Implement the metadata-stripping importer**

Use `jpeg-js` to decode, bilinearly resize to 960 px width, and re-encode at quality 85. Encoding new JPEG bytes removes source EXIF without a platform-specific dependency.

```js
// scripts/prepare-detection-corpus.mjs — core contract
const EXCLUDED_SOURCE_NAMES = new Set(['9-Foto-9.jpg']);
const OUTPUT_WIDTH = 960;
const JPEG_QUALITY = 85;

function outputName(index) {
  return `iphone-low-contrast-${String(index).padStart(3, '0')}.jpg`;
}

function resizeBilinear({ data, width, height }, targetWidth) {
  const targetHeight = Math.round((height * targetWidth) / width);
  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleX = (width - 1) / (targetWidth - 1);
  const scaleY = (height - 1) / (targetHeight - 1);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = y * scaleY;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, height - 1);
    const fy = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = x * scaleX;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, width - 1);
      const fx = sourceX - x0;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = data[(y0 * width + x0) * 4 + channel] * (1 - fx)
          + data[(y0 * width + x1) * 4 + channel] * fx;
        const bottom = data[(y1 * width + x0) * 4 + channel] * (1 - fx)
          + data[(y1 * width + x1) * 4 + channel] * fx;
        output[(y * targetWidth + x) * 4 + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { data: output, width: targetWidth, height: targetHeight };
}
```

The CLI accepts exactly two positional paths: source directory and destination directory. It sorts `1-Foto-1.jpg` through `15-Foto-15.jpg` numerically, rejects photo 9, refuses to overwrite an existing fixture, and prints the source-to-output mapping without copying original names into committed metadata.

- [ ] **Step 4: Generate and annotate the 14 fixtures**

Run:

```sh
node scripts/prepare-detection-corpus.mjs \
  /tmp/codex-remote-attachments/019fe3c1-0d43-73b1-9cc9-b64eb43b3b5b/2162FA14-EEC0-4B16-94AC-535B84C0D1A4 \
  tests/unit/fixtures/low-contrast
```

For each derivative, inspect the image and record the visible target corners in normalized coordinates. In overlapping scenes, annotate only the topmost sheet: yellow in source photo 14 and pink in source photo 15.

```json
{
  "id": "iphone-low-contrast-001",
  "target": "topmost-document",
  "quad": [
    { "x": 0.24, "y": 0.18 },
    { "x": 0.76, "y": 0.19 },
    { "x": 0.79, "y": 0.83 },
    { "x": 0.22, "y": 0.84 }
  ],
  "expectedOutcome": "accepted",
  "tags": ["shadow", "wood", "low-contrast"]
}
```

The numeric example shows the schema, not reusable coordinates. Each sidecar must contain measurements from its own derivative. Use `needs-review` for a genuinely occluded or incomplete topmost boundary; do not label an unsafe frame `accepted` to improve recall.

- [ ] **Step 5: Implement the loader and geometric metrics**

```ts
export interface DetectionCorpusAnnotation {
  readonly id: string;
  readonly target: 'topmost-document';
  readonly quad: Quad;
  readonly expectedOutcome: 'accepted' | 'needs-review' | 'no-document';
  readonly tags: readonly string[];
}

export interface DetectionCorpusFixture {
  readonly sourcePath: string;
  readonly jpeg: Buffer;
  readonly annotation: DetectionCorpusAnnotation;
}

export async function loadDetectionCorpus(): Promise<readonly DetectionCorpusFixture[]>;
export function normalizedCornerError(actual: Quad, expected: Quad, width: number, height: number): number;
export function isQuadWithinGate(actual: Quad, expected: Quad, width: number, height: number, limit = 0.025): boolean;
```

`normalizedCornerError` computes the mean Euclidean distance between corresponding ordered corners divided by `Math.hypot(width, height)`.

- [ ] **Step 6: Run the corpus tests**

Run: `npm test -- tests/unit/detectionCorpusFixtures.test.ts`

Expected: PASS with 14 fixture/annotation pairs and no EXIF marker.

- [ ] **Step 7: Commit the corpus work unit**

```sh
git add scripts/prepare-detection-corpus.mjs tests/unit/fixtures/low-contrast tests/unit/helpers/detectionCorpus.ts tests/unit/detectionCorpusFixtures.test.ts
git commit -m "test(scanner): add low-contrast detection corpus"
```

---

### Task 2: Add bounded channels and candidate generators

**Files:**
- Create: `src/features/scanner/worker/candidateTypes.ts`
- Create: `src/features/scanner/worker/candidateGenerators.ts`
- Create: `tests/unit/candidateGenerators.test.ts`
- Modify: `src/features/scanner/worker/cvBindings.ts`
- Modify: `src/features/scanner/lib/detectionConstants.ts`

**Interfaces:**
- Produces: `DetectionStrategy`, `RawCandidate`, `DetectionChannels`, `createDetectionChannels()`, `deleteDetectionChannels()`, and `generateCandidates()`.
- Consumes: `CvBindings`, `CvMat`, `Point`, and `Quad`.

- [ ] **Step 1: Write failing real-OpenCV generator tests**

```ts
// @vitest-environment node
it('finds a weak page border under a strong illumination gradient', () => {
  const image = makeSyntheticPage({ foreground: 132, background: 126, diagonalShadow: 45 });
  const rgba = cv.matFromImageData(image);
  const channels = createDetectionChannels(cv, rgba);
  try {
    expect(generateCandidates(cv, channels).length).toBeGreaterThan(0);
  } finally {
    deleteDetectionChannels(channels);
    rgba.delete();
  }
});

it('assembles a quad from four broken line segments', () => {
  const image = makeBrokenBorderPage();
  const rgba = cv.matFromImageData(image);
  const channels = createDetectionChannels(cv, rgba);
  try {
    expect(generateCandidates(cv, channels).some((candidate) => candidate.strategy === 'hough-lines')).toBe(true);
  } finally {
    deleteDetectionChannels(channels);
    rgba.delete();
  }
});
```

- [ ] **Step 2: Run the generator tests and verify RED**

Run: `npm test -- tests/unit/candidateGenerators.test.ts`

Expected: FAIL because the candidate modules do not exist.

- [ ] **Step 3: Add only runtime-verified OpenCV bindings**

```ts
interface CvBindings {
  split(src: CvMat, destination: CvMatVector): void;
  Sobel(src: CvMat, dst: CvMat, ddepth: number, dx: number, dy: number, ksize?: number, scale?: number, delta?: number, borderType?: number): void;
  HoughLinesP(image: CvMat, lines: CvMat, rho: number, theta: number, threshold: number, minLineLength?: number, maxLineGap?: number): void;
  readonly CV_16S: number;
  readonly COLOR_RGBA2RGB: number;
  readonly COLOR_RGB2Lab: number;
  readonly BORDER_DEFAULT: number;
}
```

Do not copy stale `createCLAHE` declarations from the dependency typings.

- [ ] **Step 4: Define plain, worker-private candidate types**

```ts
export type DetectionStrategy =
  | 'otsu'
  | 'closed-canny'
  | 'adaptive-mean'
  | 'adaptive-gaussian'
  | 'local-contrast'
  | 'gradient'
  | 'chroma-a'
  | 'chroma-b'
  | 'hough-lines';

export interface RawCandidate {
  readonly quad: Quad;
  readonly strategy: DetectionStrategy;
}

export interface DetectionChannels {
  readonly width: number;
  readonly height: number;
  readonly gray: CvMat;
  readonly localContrast: CvMat;
  readonly gradient: CvMat;
  readonly chromaA: CvMat;
  readonly chromaB: CvMat;
}
```

- [ ] **Step 5: Build and dispose channels sequentially**

`createDetectionChannels()` owns all returned Mats. Estimate local illumination with a 31×31 Gaussian background and write `clamp(128 + gray - background)` into a new `CV_8UC1` Mat. Build gradients with Sobel X/Y → `convertScaleAbs` → per-pixel maximum. Convert RGBA → RGB → Lab, split through `MatVector`, and retain caller-owned A/B channel wrappers. Delete RGB, Lab, background, Sobel intermediates, and the vector before returning. If construction throws, delete every channel already created.

```ts
export function createDetectionChannels(cv: CvBindings, rgba: CvMat): DetectionChannels;
export function deleteDetectionChannels(channels: DetectionChannels): void;
```

- [ ] **Step 6: Generate bounded contour and line candidates**

Create binary masks from Otsu, closed Canny, adaptive mean/Gaussian in both polarities, local contrast, gradients, and Lab A/B. Each mask is created, consumed, and deleted before the next strategy. Retain at most the 12 largest contours per strategy.

For line assembly, retain the 16 longest Hough segments, form parallel pairs within 12 degrees, combine pairs whose directions differ by 60–120 degrees, intersect their infinite lines, order the four corners, and reject non-convex or out-of-frame quads.

```ts
export function generateCandidates(cv: CvBindings, channels: DetectionChannels): readonly RawCandidate[];
```

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```sh
npm test -- tests/unit/candidateGenerators.test.ts
npm run typecheck
```

Expected: PASS; no CLAHE reference exists in `src/`.

- [ ] **Step 8: Commit the generator work unit**

```sh
git add src/features/scanner/worker/candidateTypes.ts src/features/scanner/worker/candidateGenerators.ts src/features/scanner/worker/cvBindings.ts src/features/scanner/lib/detectionConstants.ts tests/unit/candidateGenerators.test.ts
git commit -m "feat(scanner): generate low-contrast page candidates"
```

---

### Task 3: Fuse candidates and rank the topmost document

**Files:**
- Create: `src/features/scanner/worker/candidateFusion.ts`
- Create: `src/features/scanner/worker/candidateScoring.ts`
- Create: `tests/unit/candidateFusion.test.ts`
- Create: `tests/unit/candidateScoring.test.ts`
- Modify: `src/features/scanner/worker/candidateTypes.ts`
- Modify: `src/features/scanner/lib/detectionConstants.ts`

**Interfaces:**
- Produces: `FusedCandidate`, `CandidateFeatures`, `ScoredCandidate`, `CandidateRanking`, `fuseCandidates()`, `extractCandidateFeatures()`, and `rankCandidates()`.
- Consumes: plain candidates from Task 2 and read-only grayscale/gradient channels.

- [ ] **Step 1: Write failing fusion tests**

```ts
it('merges near-identical quads and preserves independent strategies', () => {
  const fused = fuseCandidates([
    candidate('otsu', quad(10, 10, 90, 90)),
    candidate('gradient', quad(11, 9, 91, 90)),
  ], 100, 100);
  expect(fused).toHaveLength(1);
  expect(fused[0].strategies).toEqual(['gradient', 'otsu']);
});
```

Use mean ordered-corner distance divided by image diagonal. Merge when distance is at or below 2.5%; average corresponding corners and sort unique strategies lexically for deterministic diagnostics.

- [ ] **Step 2: Write failing ranking tests**

```ts
it('prefers the supported top sheet over a larger underlying sheet', () => {
  const ranking = rankCandidates([
    scored('large-underlay', { areaRatio: 0.82, minEdgeSupport: 0.52, meanBoundaryContrast: 0.41, strategyAgreement: 0.4, topmostScore: -1 }),
    scored('small-top-sheet', { areaRatio: 0.46, minEdgeSupport: 0.81, meanBoundaryContrast: 0.76, strategyAgreement: 0.8, topmostScore: 1 }),
  ]);
  expect(ranking.best?.id).toBe('small-top-sheet');
  expect(ranking.ambiguous).toBe(false);
});

it('reports ambiguity instead of forcing a crop', () => {
  const ranking = rankCandidates([scoredAt(0.71), scoredAt(0.66)]);
  expect(ranking.ambiguous).toBe(true);
});
```

- [ ] **Step 3: Run fusion/scoring tests and verify RED**

Run: `npm test -- tests/unit/candidateFusion.test.ts tests/unit/candidateScoring.test.ts`

Expected: FAIL because fusion and scoring are not implemented.

- [ ] **Step 4: Implement deterministic fusion**

```ts
export interface FusedCandidate {
  readonly id: string;
  readonly quad: Quad;
  readonly strategies: readonly DetectionStrategy[];
}

export function fuseCandidates(candidates: readonly RawCandidate[], width: number, height: number): readonly FusedCandidate[];
```

Sort raw candidates by strategy then corner coordinates before clustering so repeated runs produce identical IDs and ordering.

- [ ] **Step 5: Extract independently inspectable features**

```ts
export interface CandidateFeatures {
  readonly edgeSupport: readonly [number, number, number, number];
  readonly boundaryContrast: readonly [number, number, number, number];
  readonly areaRatio: number;
  readonly geometryScore: number;
  readonly strategyAgreement: number;
  readonly topmostScore: number;
  readonly borderContacts: readonly ('top' | 'right' | 'bottom' | 'left')[];
}

export function extractCandidateFeatures(
  cv: CvBindings,
  candidate: FusedCandidate,
  competitors: readonly FusedCandidate[],
  channels: DetectionChannels,
): CandidateFeatures;
```

Compute four-edge support and inside/outside contrast separately. For topmost evidence, inspect intersections between overlapping candidates: if a competitor edge weakens inside the candidate while the candidate edge remains continuous across the intersection, add positive evidence; apply the inverse as negative evidence. Normalize to `[-1, 1]` and return zero when no layering cue exists.

- [ ] **Step 6: Rank without letting area dominate**

```ts
export interface CandidateWithFeatures extends FusedCandidate {
  readonly features: CandidateFeatures;
}

export interface ScoredCandidate extends CandidateWithFeatures {
  readonly score: number;
}

export interface CandidateRanking {
  readonly best: ScoredCandidate | null;
  readonly runnerUp: ScoredCandidate | null;
  readonly scoreMargin: number;
  readonly ambiguous: boolean;
}

export function rankCandidates(candidates: readonly CandidateWithFeatures[]): CandidateRanking;
```

Start with these calibratable weights: minimum edge support 0.30, mean boundary contrast 0.20, mean edge support 0.15, topmost evidence 0.15, strategy agreement 0.10, geometry 0.08, and bounded area tie-breaker 0.02. A score margin below 0.08 is ambiguous. Sort ties by stable candidate ID.

- [ ] **Step 7: Run pure tests**

Run: `npm test -- tests/unit/candidateFusion.test.ts tests/unit/candidateScoring.test.ts`

Expected: PASS for deduplication, topmost priority, deterministic ties, and ambiguity.

- [ ] **Step 8: Commit the ranking work unit**

```sh
git add src/features/scanner/worker/candidateTypes.ts src/features/scanner/worker/candidateFusion.ts src/features/scanner/worker/candidateScoring.ts src/features/scanner/lib/detectionConstants.ts tests/unit/candidateFusion.test.ts tests/unit/candidateScoring.test.ts
git commit -m "feat(scanner): rank topmost document candidates"
```

---

### Task 4: Integrate the ensemble without weakening acceptance

**Files:**
- Modify: `src/features/scanner/worker/detectPipeline.ts`
- Modify: `src/features/scanner/worker/messages.ts`
- Modify: `src/features/scanner/worker/opencv.worker.ts`
- Modify: `src/features/scanner/lib/detectionAcceptance.ts`
- Modify: `tests/unit/detectRealCameraCapture.test.ts`
- Modify: `tests/unit/detectionAcceptance.test.ts`
- Modify: `tests/unit/workerClientProtocol.test.ts`
- Modify: `tests/unit/useBatchProcess.test.ts`
- Create: `tests/unit/detectionCorpusPipeline.test.ts`

**Interfaces:**
- Preserves: `runDetectPipeline(cvBindings, imageData, withQuality)` signature.
- Extends: `DetectionEvidence` with deterministic candidate diagnostics.
- Consumes: Tasks 1–3 corpus, generators, fusion, and scoring.

- [ ] **Step 1: Write failing acceptance and protocol tests**

```ts
it('rejects an otherwise strong ambiguous result', () => {
  expect(isDetectionAccepted(evidence({ ambiguous: true }))).toBe(false);
});

it('does not let candidate score bypass weak physical edges', () => {
  expect(isDetectionAccepted(evidence({ score: 0.99, edgeSupport: [0.9, 0.9, 0.2, 0.9] }))).toBe(false);
});
```

Update protocol fixtures to require serializable diagnostics and prove the transferred request buffer behavior is unchanged.
Update the shared `useBatchProcess.test.ts` result builder in the same RED step so every mocked `DetectionEvidence` contains the required candidate diagnostics; Task 5 will then extend those fixtures with two-attempt routing assertions.

- [ ] **Step 2: Write the failing corpus pipeline test**

For every `accepted` fixture, decode through `jpeg-js`, call `runDetectPipeline`, and report target ID, corner error, winning strategies, ambiguity, and elapsed time. Assert the annotated topmost target is selected and preserve the current intact/cropped safety cases.

Run: `npm test -- tests/unit/detectionCorpusPipeline.test.ts tests/unit/detectionAcceptance.test.ts tests/unit/workerClientProtocol.test.ts`

Expected: FAIL under the old area-first pipeline on at least the documented low-contrast/overlap cases.

- [ ] **Step 3: Extend wire-safe diagnostics**

```ts
export interface CandidateDiagnostics {
  readonly strategies: readonly DetectionStrategy[];
  readonly score: number;
  readonly scoreMargin: number;
  readonly ambiguous: boolean;
  readonly analysisWidth: number;
  readonly stageTimingsMs: Readonly<Record<'channels' | 'generate' | 'fuse' | 'score', number>>;
}

export interface DetectionEvidence {
  readonly confidence: 'high' | 'medium' | 'low';
  readonly areaRatio: number;
  readonly edgeSupport: readonly [number, number, number, number];
  readonly borderContacts: readonly ('top' | 'right' | 'bottom' | 'left')[];
  readonly candidate: CandidateDiagnostics;
}
```

Diagnostics contain numbers, strings, and arrays only—never Mats or pixels.

- [ ] **Step 4: Replace area-first orchestration**

`runDetectPipeline` must:

1. create base RGBA and derived channels;
2. generate raw candidates sequentially;
3. fuse candidates;
4. extract features and rank;
5. map the winning candidate to existing corners/evidence/quality output;
6. delete all channels and source Mats in `finally`.

Return null corners/evidence when no candidate exists. Preserve `withQuality` behavior and the public return type.

```ts
const source = cvBindings.matFromImageData(imageData);
let channels: DetectionChannels | null = null;
try {
  channels = createDetectionChannels(cvBindings, source);
  const activeChannels = channels;
  const fused = fuseCandidates(
    generateCandidates(cvBindings, activeChannels),
    activeChannels.width,
    activeChannels.height,
  );
  const scored = fused.map((candidate) => ({
    ...candidate,
    features: extractCandidateFeatures(cvBindings, candidate, fused, activeChannels),
  }));
  const ranking = rankCandidates(scored);
  return buildPipelineResult(ranking, activeChannels, withQuality);
} finally {
  if (channels) deleteDetectionChannels(channels);
  if (!source.isDeleted()) source.delete();
}
```

- [ ] **Step 5: Add ambiguity as an additional acceptance veto**

```ts
export function isDetectionAccepted(evidence: DetectionEvidence | null): boolean {
  if (!evidence || evidence.confidence === 'low' || evidence.candidate.ambiguous) return false;
  if (evidence.edgeSupport.some((support) => support < DETECTION.MIN_EDGE_SUPPORT)) return false;
  return !hasOppositeBorderContacts(evidence.borderContacts);
}
```

Do not change `MIN_EDGE_SUPPORT` or border-contact semantics.

- [ ] **Step 6: Run the integrated worker matrix**

Run:

```sh
npm test -- --run tests/unit/detectRealCameraCapture.test.ts tests/unit/detectionAcceptance.test.ts tests/unit/detectionCorpusPipeline.test.ts
npm test -- tests/unit/workerClientProtocol.test.ts tests/unit/opencvWorkerSauvolaRoute.test.ts
npm run typecheck
```

Expected: PASS; current intact fixture remains accepted, cropped fixture remains rejected, and ambiguity can only make acceptance stricter.

- [ ] **Step 7: Commit the pipeline work unit**

```sh
git add src/features/scanner/worker/detectPipeline.ts src/features/scanner/worker/messages.ts src/features/scanner/worker/opencv.worker.ts src/features/scanner/lib/detectionAcceptance.ts tests/unit/detectRealCameraCapture.test.ts tests/unit/detectionAcceptance.test.ts tests/unit/workerClientProtocol.test.ts tests/unit/useBatchProcess.test.ts tests/unit/detectionCorpusPipeline.test.ts
git commit -m "feat(scanner): integrate evidence-ranked detection"
```

---

### Task 5: Add the conditional 960 px retry and time budget

**Files:**
- Modify: `src/features/scanner/hooks/useBatchProcess.ts`
- Modify: `src/features/scanner/lib/detectionConstants.ts`
- Modify: `tests/unit/useBatchProcess.test.ts`
- Modify: `tests/unit/mainThreadImageData.test.ts`
- Modify: `tests/e2e/detection.spec.ts`

**Interfaces:**
- Produces: `shouldRetryDetection()` and `detectAtWidth()` as hook-local helpers.
- Consumes: worker diagnostics and unchanged `WorkerClient.detectImageData()`.

- [ ] **Step 1: Write failing retry-routing tests**

```ts
it('retries once at 960 when the 640 result is ambiguous', async () => {
  worker.detectImageData
    .mockResolvedValueOnce(result({ corners: weakQuad, ambiguous: true, analysisWidth: 640 }))
    .mockResolvedValueOnce(result({ corners: strongQuad, ambiguous: false, analysisWidth: 960 }));
  await processCapture();
  expect(worker.detectImageData).toHaveBeenCalledTimes(2);
  expect(extractedWidths()).toEqual([640, 960]);
});

it('does not retry a strong accepted 640 result', async () => {
  worker.detectImageData.mockResolvedValue(result({ corners: strongQuad, ambiguous: false, analysisWidth: 640 }));
  await processCapture();
  expect(worker.detectImageData).toHaveBeenCalledTimes(1);
});

it('falls back to review when the retry remains ambiguous', async () => {
  worker.detectImageData.mockResolvedValue(result({ corners: weakQuad, ambiguous: true }));
  await processCapture();
  expect(warpPage).not.toHaveBeenCalled();
  expect(addPage).toHaveBeenCalledWith(expect.objectContaining({ needsReview: true }));
});
```

- [ ] **Step 2: Run batch tests and verify RED**

Run: `npm test -- tests/unit/useBatchProcess.test.ts tests/unit/mainThreadImageData.test.ts`

Expected: FAIL because only one 640 px call exists.

- [ ] **Step 3: Add explicit retry constants**

```ts
export const DETECTION = {
  PRIMARY_MAX_WIDTH: 640,
  RETRY_MAX_WIDTH: 960,
  RETRY_SCORE_MARGIN: 0.08,
  SOFT_TIME_BUDGET_MS: 2_000,
  // existing safety constants remain unchanged
} as const;
```

- [ ] **Step 4: Implement source-boundary retry**

Keep `originalBitmap` alive. For each attempt, create a distinct resized bitmap, convert it through `bitmapToImageData()`—which closes that attempt bitmap exactly once—and call the worker sequentially.

```ts
function shouldRetryDetection(result: DetectResponse, elapsedMs: number): boolean {
  if (elapsedMs >= DETECTION.SOFT_TIME_BUDGET_MS) return false;
  return !result.corners || result.evidence?.candidate.ambiguous === true || !isDetectionAccepted(result.evidence);
}
```

If retry is skipped by budget, preserve the primary evidence but require manual review. If retry runs, use the retry result only when its score is higher and it is not more ambiguous; otherwise keep the primary candidate and still apply the independent acceptance gate.

- [ ] **Step 5: Preserve bitmap and worker ownership invariants**

Extend tests to prove two distinct detection bitmaps are created, both close exactly once, `originalBitmap` remains available for full-resolution warp, and the worker's single-flight guard never receives overlapping calls.

- [ ] **Step 6: Add real-browser retry coverage**

In `tests/e2e/detection.spec.ts`, stub a deterministic ambiguous primary response followed by a strong retry and assert the page reaches the grid without a worker protocol error. Add the inverse case where both attempts remain ambiguous and assert the corner editor/manual-review path.

- [ ] **Step 7: Run focused and browser tests**

Run:

```sh
npm test -- tests/unit/useBatchProcess.test.ts tests/unit/workerClientProtocol.test.ts tests/unit/mainThreadImageData.test.ts
npm run test:e2e -- tests/e2e/detection.spec.ts
npm run typecheck
```

Expected: PASS with exactly zero or one retry and no ownership regression.

- [ ] **Step 8: Commit the retry work unit**

```sh
git add src/features/scanner/hooks/useBatchProcess.ts src/features/scanner/lib/detectionConstants.ts tests/unit/useBatchProcess.test.ts tests/unit/mainThreadImageData.test.ts tests/e2e/detection.spec.ts
git commit -m "feat(scanner): retry ambiguous detection at 960px"
```

---

### Task 6: Enforce quality gates and complete physical iPhone QA

**Files:**
- Modify: `tests/unit/detectionCorpusPipeline.test.ts`
- Modify: `src/features/scanner/lib/detectionConstants.ts` only when corpus evidence justifies calibrated non-safety values
- Create: `docs/qa/2026-08-08-low-contrast-page-detection.md`

**Interfaces:**
- Consumes: complete detector, corpus metrics, browser tests, and production build.
- Produces: reproducible quality report and merge/deploy recommendation.

- [ ] **Step 1: Turn descriptive corpus output into explicit gates**

For complete four-edge fixtures, assert median normalized corner error `<= 0.01` and p95 `<= 0.025`. Assert every overlapping seed scene selects the annotated topmost target. For `needs-review` and safety fixtures, assert zero unsafe automatic acceptance.

```ts
expect(summary.topmostSelections).toBe(summary.overlappingFixtures);
expect(summary.unsafeAcceptances).toBe(0);
expect(summary.medianCornerError).toBeLessThanOrEqual(0.01);
expect(summary.p95CornerError).toBeLessThanOrEqual(0.025);
```

- [ ] **Step 2: Run the complete local verification matrix**

Run:

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Expected: every command exits 0. Fix no unrelated failure silently; diagnose it before changing code.

- [ ] **Step 3: Record warm local timing without weakening gates**

Run the corpus pipeline repeatedly after one warm-up and record p50/p95 per stage, retry rate, and maximum observed analysis width. If p95 exceeds two seconds, reduce optional generator work or retry frequency; do not lower edge-support, border-contact, corner-error, or topmost-selection requirements.

- [ ] **Step 4: Deploy the verified branch to an expiring Firebase preview channel**

Deploy only after local tests and a fresh review pass:

```sh
firebase hosting:channel:deploy low-contrast-detection --only nitidoc --expires 7d
```

Record commit SHA, preview URL, deployment time, and cold/warm status in the QA document. Production remains unchanged until the reviewed work is merged.

- [ ] **Step 5: Perform physical iPhone QA on unseen scenes**

Test at least: white paper on a light wall, white paper on wood, hard phone shadow, glossy page with glare, torn/occluded edge, colorful workbook, two overlapping sheets where the top sheet is smaller, a partial page, and no document. Run offline after the app is cached. Record model, iOS version, browser/PWA mode, result, retry behavior, and elapsed time for each scene.

- [ ] **Step 6: Write the completed QA report**

`docs/qa/2026-08-08-low-contrast-page-detection.md` must contain actual corpus counts, median/p95 corner error, unsafe acceptance count, retry rate, local timing, physical-device matrix, known limitations, and the final merge/deploy decision. Do not leave empty rows or speculative results.

- [ ] **Step 7: Commit the verified quality evidence**

```sh
git add tests/unit/detectionCorpusPipeline.test.ts src/features/scanner/lib/detectionConstants.ts docs/qa/2026-08-08-low-contrast-page-detection.md
git commit -m "test(scanner): verify low-contrast detection gates"
```

- [ ] **Step 8: Final review and delivery**

Run a fresh-context adversarial review of the complete diff, resolve every correctness/safety finding, rerun the affected matrix, then create the GitHub issue/PR chain required by the repository's review-size policy. Merge in dependency order and deploy Firebase Hosting only after merged-main verification.
