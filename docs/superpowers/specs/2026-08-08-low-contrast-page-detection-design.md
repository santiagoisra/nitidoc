# Low-contrast page detection — design

Date: 2026-08-08
Branch: `codex/low-contrast-page-detection`
Status: approved

## 1. Purpose

Physical iPhone testing shows that Nitidoc's capture safety is substantially
better, but automatic page detection still misses or misranks documents when
the paper and background have weak contrast, illumination is uneven, or several
rectangular surfaces overlap.

This change improves candidate recall and ranking without weakening automatic
crop safety. Detection may spend up to two seconds after capture when the fast
pass is inconclusive. If the image does not contain enough boundary evidence,
Nitidoc must continue to request manual review instead of inventing a crop.

## 2. Product rules

1. When several sheets overlap, the target is the **topmost, nearest visible
   document**, even when a lower sheet has a larger area.
2. A larger quadrilateral never wins solely because it is larger.
3. A candidate may be detected but still rejected for automatic warping. Recall
   and safety remain independent decisions.
4. When the two best candidates are too close in confidence or their ordering
   is ambiguous, the page is marked `needsReview`.
5. No remote inference or image upload is introduced. Processing remains local
   and offline-capable.

## 3. Current failure mechanism

`useBatchProcess` currently downsizes the captured source to 640 px and sends
`ImageData` to the OpenCV worker. `runDetectPipeline` generates candidates from
only global Otsu and a fixed closed-Canny mask, considers five external contours
per mask, and selects the largest valid quadrilateral before measuring its edge
support.

This has two distinct failure modes:

- low-contrast or locally shadowed borders disappear before geometry can form a
  candidate;
- desk seams, underlying sheets, book covers, or other large rectangles can
  outrank the intended top sheet.

The existing acceptance layer correctly rejects candidates with weak edge
support or unsafe border contact. Its thresholds must not be relaxed to mask an
upstream recall or ranking defect.

## 4. Chosen approach

Use a bounded classical ensemble in the existing OpenCV worker. It is
deterministic, inspectable, local, and can reuse the current runtime. A learned
segmentation model is explicitly deferred until measured held-out failures show
that the classical design cannot meet the quality gate.

### Rejected: tune only Otsu and Canny

Changing two thresholds is cheap but cannot handle local illumination,
polarity changes, weak chromatic edges, and competing rectangles consistently.
It would optimize individual examples without changing the failure mechanism.

### Deferred: learned page segmentation

A compact on-device model could help where context matters more than gradients,
but it adds model provenance, licensing, cache size, Safari/WASM latency, and
memory risk. It remains a separately gated follow-up, never a prerequisite for
this change.

## 5. Detection architecture

### 5.1 Preprocessing

Create reusable channels from the 640 px source:

- luminance normalized for uneven illumination;
- local-contrast luminance using a locally estimated background and bounded
  blur/division or morphological normalization; the installed OpenCV.js runtime
  does not expose CLAHE even though its generated typings declare it;
- selected chroma or normalized color differences when luminance alone is weak;
- gradient magnitude and polarity-independent edge evidence.

Every OpenCV `Mat` has one explicit owner and is deleted in the stage that
created it. Strategies execute sequentially to bound peak memory on iPhone.

### 5.2 Candidate generators

Generate quadrilateral hypotheses from a small, fixed set of complementary
strategies:

- global threshold masks for high-contrast pages;
- adaptive/local threshold masks for shadows and illumination gradients;
- gradient and Canny variants for weak or non-uniform boundaries;
- line-segment assembly for pages whose four borders do not form one closed
  contour;
- polarity variants where the page can be lighter or darker than its
  surroundings.

Generators return candidates with their source strategy and raw evidence. They
do not choose the winner. Near-duplicate quadrilaterals are fused before
scoring.

### 5.3 Candidate scoring

Each fused candidate receives independently inspectable features:

- support along each of the four physical sides;
- inside-versus-outside boundary contrast per side;
- convexity, corner plausibility, aspect and area bounds;
- agreement across independent generators;
- border contact and visible-edge completeness;
- overlap and occlusion evidence for topmost ordering;
- ambiguity margin against the next-best candidate.

Four-side evidence, cross-strategy agreement, and topmost ordering dominate the
score. Area is only a bounded tie-breaker after evidence quality. When two
overlapping candidates remain indistinguishable, the scorer reports ambiguity
instead of forcing an ordering.

Topmost evidence includes edge termination and T-junction cues where an upper
sheet interrupts the border or texture of a lower surface. These cues improve
ranking but never bypass the four-edge safety requirement.

### 5.4 Conditional high-resolution retry

Run the complete bounded ensemble at 640 px first. Retry once at 960 px only
when:

- no plausible candidate exists;
- the best candidate lacks enough evidence for acceptance; or
- competing candidates have an insufficient score margin.

The retry is sequential and optional. A soft elapsed-time budget skips remaining
optional stages before exceeding the accepted two-second target. The best
available evidence is returned, but a budget expiry can never turn an ambiguous
candidate into an accepted crop.

### 5.5 Acceptance boundary

`detectionAcceptance.ts` remains the final authority for automatic warping. It
continues to require real support on all four edges and reject unsafe border
contact. New candidate confidence and ambiguity may make acceptance stricter;
they must not weaken existing safeguards.

The observable outcomes remain:

- accepted candidate → automatic warp;
- detected but unsafe or ambiguous candidate → preserve evidence and mark
  `needsReview`;
- no candidate → frame-corner fallback and `needsReview`.

## 6. Module boundaries

The implementation should keep each responsibility independently testable:

```text
src/features/scanner/worker/
  detectPipeline.ts          orchestrates stages and retry input
  candidateGenerators.ts     produces raw quadrilateral hypotheses
  candidateFusion.ts         deduplicates and combines strategy evidence
  candidateScoring.ts        ranks geometry, boundary and topmost evidence
  cvBindings.ts              typed OpenCV surface and Mat ownership helpers
src/features/scanner/lib/
  detectionConstants.ts      calibrated stage and budget parameters
  detectionAcceptance.ts     independent automatic-warp safety gate
```

`detectPipeline.ts` must not absorb the mathematical details of every strategy.
The worker protocol exposes only diagnostics needed for regression analysis:
winning strategies, per-edge support, aggregate confidence, ambiguity, retry
usage, and stage timing.

## 7. Corpus and annotation

The 15 supplied iPhone captures form the seed corpus. Photo 9 contains a
recognizable child and is excluded entirely; anonymization is unnecessary
because the remaining images already cover the relevant geometry. The other 14
become metadata-stripped, recompressed test derivatives capped at the 960 px
analysis scale. Raw attachments and EXIF are not committed.

Each fixture receives a sidecar annotation:

```json
{
  "id": "iphone-low-contrast-001",
  "target": "topmost-document",
  "quad": [[0.2, 0.1], [0.8, 0.12], [0.82, 0.9], [0.18, 0.88]],
  "expectedOutcome": "accepted",
  "tags": ["shadow", "wood", "low-contrast"]
}
```

Coordinates are normalized and ordered top-left, top-right, bottom-right,
bottom-left. `expectedOutcome` is `accepted`, `needs-review`, or `no-document`.
Overlapping scenes annotate only the topmost target and explicitly tag
`stacked-documents`. Ground truth is reviewed visually before detector tuning.

The seed corpus is a regression set, not enough evidence for a universal quality
claim. Calibration must also retain existing fixtures and add consent-safe
negative and low-contrast examples. Future physical QA expands the corpus by
scene rather than by near-duplicate frames.

## 8. Quality gates

Before implementation, the corpus runner records the current baseline. The new
detector must satisfy all of these gates:

- select the annotated topmost document in every overlapping seed-corpus scene;
- produce zero unsafe automatic warps on cropped, partial, and no-document
  safety fixtures;
- preserve all existing intact/cropped acceptance regressions;
- on complete four-edge fixtures, achieve median normalized corner error at or
  below 1% of the image diagonal and 95th percentile at or below 2.5%;
- materially improve valid-candidate recall in low-contrast strata without a
  statistically meaningful increase in unsafe acceptance;
- keep warm p95 detection latency at or below two seconds on the target iPhone;
- report cold and warm runtime separately and record whether the 960 px retry
  ran.

With only 14 private seed fixtures, recall percentages are descriptive rather
than statistically conclusive. A result may be technically mergeable after all
safety and regression gates pass, but “dramatically improved” is confirmed only
by physical iPhone QA on additional, previously unseen scenes.

## 9. Error handling and diagnostics

Every strategy can fail independently and yield no candidates. An OpenCV error
in an optional strategy is recorded with its stage name; it does not discard a
valid candidate already produced by another strategy. A base pipeline or worker
failure follows the existing manual-review fallback.

Diagnostics are deterministic and contain no pixels. Tests can assert candidate
source, retry use, score ordering, ambiguity, and acceptance reason without
depending on console output. Production telemetry is not introduced by this
change.

## 10. Testing strategy

1. **Corpus baseline:** run the current detector against normalized ground truth
   and preserve the report as RED evidence.
2. **Generator unit tests:** verify each strategy on the smallest fixture that
   demonstrates its intended failure mode.
3. **Fusion and scoring tests:** use synthetic candidates to prove
   deduplication, four-side weighting, ambiguity behavior, and topmost ordering.
4. **Acceptance tests:** prove the new diagnostics cannot weaken the existing
   edge-support and border-contact rules.
5. **Corpus regression:** report per-fixture corner error, target identity,
   acceptance outcome, retry, and elapsed time.
6. **Browser tests:** verify worker protocol and manual-review fallback in real
   Chromium and WebKit.
7. **Physical iPhone gate:** test cold/warm runs, glare, shadows, stacked pages,
   low contrast, memory pressure, and offline operation before production
   deployment.

## 11. Delivery boundaries

Implementation should be split into reviewable work units:

1. privacy-safe corpus, annotation schema, baseline runner, and frozen safety
   regressions;
2. candidate generators plus OpenCV ownership helpers;
3. fusion, scoring, topmost ordering, and auditable diagnostics;
4. conditional 960 px retry, timing budget, integrated browser/device QA;
5. final verification, GitHub review, merge, and Firebase Hosting deployment.

No learned model, live-camera temporal detector, auto-capture, or safety-threshold
relaxation belongs in this change.
