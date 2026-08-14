# Manual Paper Framing Design

## Intent

Replace post-capture paper-size inference with an explicit paper choice made
before each shutter action. Detection still finds a document quad and still
routes uncertain or invalid quads to review; only automatic classification of
the paper *format* is removed. This keeps the existing scanner robust without
claiming that camera pixels reveal physical paper size.

## Scope and non-goals

The capture screen exposes six choices: **A4/A3**, **Oficio**, **Carta**,
**Legal**, **Tarjeta/DNI**, and **Forma libre**. The selected value is a
per-shot input: the capture control may retain its last value for convenience,
but `RawCapture` snapshots it and processing never reads a later UI value.
`Forma libre` is the initial value and applies no aspect constraint.

This change does not modify B&W filtering, OpenCV edge/quad detection,
uncertain-quad review behavior, signed releases, deployment, or unrelated
scanner UI. The same TypeScript/React implementation is shipped to browser
and Capacitor Android; there is no Android-native framing or crop path.

## Domain model and geometry

`PaperFormatId` continues to represent the canonical export family. The
current aliases provide the six picker values: `a4`, `oficio`, `letter`,
`legal`, `ticket`, and `original`. UI labels change only at the capture
boundary: `a4` is presented as **A4/A3**, `ticket` as **Tarjeta/DNI**, and
`original` as **Forma libre**. `a4` remains the canonical ID because ISO A4
and A3 have the same `1 / sqrt(2)` portrait ratio and capture geometry cannot
derive scale.

Each `RawCapture` gains `paper: PaperSelection`. It is created with
`paperSelection(alias, 'manual')`; therefore every new page carries explicit
manual provenance through `RawCapture -> DocumentPage.recipe.paper`. The
batch processor must use `raw.paper`, never `classifyPaperRatio`, both on the
normal detection path and on its identity/review fallback. `resolveWarpGeometry`
then yields fixed geometry for A4/A3, Oficio, Carta, Legal, and Tarjeta/DNI;
only Forma libre retains measured geometry. Tarjeta/DNI uses the ISO/IEC 7810
ID-1 ratio (53.98 x 85.60 mm in portrait) so its guide and warp agree with a
physical card. A4/A3 renders and exports provisionally as A4 (210 x 297 mm),
not as a detected physical size.

Existing saved and history pages remain readable through the compatibility
normalization already used for `PaperSelection`; no migration rewrites blobs or
corners. The temporary removal means new captures have no `source: 'auto'`
selection and `classifyPaperRatio`/`automaticPaperSelection` are not called by
the new-capture or any re-warp path. A legacy automatic selection remains
readable as historical provenance, but its existing geometry is preserved
rather than reclassified.

## Capture framing

`CaptureScreen` owns a selected `PaperFormatAlias`, initially `original`, and
renders an accessible selector above the shutter controls. Its framing guide
is a presentation-only overlay over `CameraView`: a centered, contained
rectangle using the selected fixed portrait ratio; no guide is drawn for
`original`. It updates immediately when the picker changes and does not alter
the camera stream, captured pixels, or edge detection.

On shutter and image import, `CaptureScreen` passes the current manual
selection into `useActivePage.materializeRawCapture`. The materializer creates
the `RawCapture` with that immutable selection. Processing copies it into the
initial recipe before the full-resolution warp. Adjust Borders receives that
recipe and continues to resolve the selected geometry, so a manual choice
survives crop edits and re-warps. The post-capture format selector and
"clear to automatic" affordance in `FilterPanel` are removed: there is no
automatic result to restore, and format choice belongs to the capture
decision. The review screen may show the selected format as non-editable
context if that is needed for clarity, but it must not mutate provenance.

## Shared crop overlay side handles

`CropOverlay` retains its four draggable corners and adds four midpoint side
handles: top, right, bottom, and left. Side drags translate the corresponding
pair of corners only on the perpendicular axis:

| Handle | Points changed | Allowed coordinate |
| --- | --- | --- |
| Top | top-left, top-right | `y` |
| Right | top-right, bottom-right | `x` |
| Bottom | bottom-right, bottom-left | `y` |
| Left | bottom-left, top-left | `x` |

The overlay remains controlled and reports a complete `Quad` on every valid
move. It uses the same letterbox source/display mapping as corners. Each side
handle has a 44px minimum hit target, pointer capture, `touch-action: none`,
and the existing pointer-up/cancel release behavior. A candidate quad is sent
only when it remains convex; invalid candidates leave the last valid controlled
quad visible. The active drag still drives the magnifier from the mapped source
point and fires `onDragStateChange` exactly once on start and end. This makes
the feature work identically for mouse, touch web, and Capacitor Android.

`CornerEditor` and Adjust Borders continue to consume only
`onCornersChange(quad)` and `onDragStateChange(dragging)`. Their existing
re-warp-on-real-drag guard therefore applies to side drags without parallel
crop logic.

## PDF behavior

`exportPdf` keeps its current nominal-page rules. Since all new selections are
manual, known nominal formats use catalog millimetres; A4/A3 uses the A4
MediaBox provisionally and Tarjeta/DNI uses the ID-1 MediaBox. Forma libre
keeps the raster-based MediaBox fallback and is not stretched. Rotation still
determines final PDF orientation.

## Verification strategy

Implementation proceeds in strict RED/GREEN TDD cycles. Unit tests cover
manual selection construction, raw-to-page propagation, removal of automatic
classification, fixed versus measured warp geometry, and PDF MediaBoxes.
React tests cover the live picker, guide visibility/ratio, selection snapshot
on capture/import, and that Adjust Borders receives preserved provenance.
`CropOverlay` tests cover all four side mappings, corner regression, convexity
rejection, pointer capture/cancel, and touch-sized targets. Finish with the
focused suite, full `npm test`, `npm run typecheck`, and both web and native
production builds.
