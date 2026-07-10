/**
 * Manual corner editor + warp trigger (Group 5 / Slice E; design section 2.2
 * second half; perspective spec CAP-6/CAP-7/CAP-8). Rewired to the
 * active-page model in Group 1c (design section 5.4, ADR-010): this
 * component is now a CONTROLLED component over its `originalBitmap`/
 * `initialRecipe` props instead of reading/writing F1's legacy single-page
 * capture state (`warpedImage`/`recipe`) from the store.
 *
 * Two callers, one component (design section 5.1/5.4):
 *  - Fresh, not-yet-confirmed capture: `originalBitmap` is the live captured
 *    frame, `initialRecipe` is `null` (a brand-new recipe is built on first
 *    warp). Confirm hands `{ warpedBase, recipe }` to the caller, which calls
 *    `useActivePage.materializeCapture` (design section 2.2 "Materialize on
 *    capture") — this component never touches `DocumentSlice` directly for
 *    this path.
 *  - Re-entry into an already-materialized page (grid tap -> activatePage):
 *    `originalBitmap` is `activeWorking.originalBitmap`, `initialRecipe` is
 *    the page's existing recipe (so filter/rotation/flip survive a corner
 *    re-warp — design section 2.2 "Re-warp (active)": `{...recipe, corners,
 *    aspectRatio}`). Confirm hands the same shape to the caller, which calls
 *    `useActivePage.rewarpActivePage` then `deactivateActivePage`.
 *
 * Responsibilities (tasks 5.1-5.4), unchanged from F1:
 *  - Render 4 draggable handles over the full-res source, seeded from the
 *    scaled detected corners when available, or distributed across the
 *    frame otherwise (5.1.1).
 *  - Show a magnifier loupe centered on the handle while dragging (5.1.2).
 *  - Validate convexity with `isConvex` on every pointerup/touchend and
 *    disable "Next"/"Confirm" + show an invalid state when the quad is not
 *    convex (5.1.3).
 *  - Trigger the warp ONLY on pointerup/touchend, never on intermediate drag
 *    positions (5.1.4 / 5.2.1).
 *  - Handle both `WARP_RESULT` (ImageBitmap) and `WARP_RESULT_IMAGEDATA`
 *    responses depending on `offscreenSupported`, closing the previous
 *    warped bitmap before assigning a new one (5.2.2) — now done via LOCAL
 *    state (`applyWarpedImage`) since the store no longer owns this bitmap
 *    until Confirm hands it off.
 *  - Build the initial `EditRecipe` on warp success (5.2.3), preserving the
 *    caller's `initialRecipe` (filter/rotation/flip) across re-warps.
 *  - Offer an aspect-ratio override before confirming (5.3.1).
 *  - Offer non-destructive post-warp rotate/flip controls that only touch
 *    the recipe + a CSS transform, never re-invoking the worker (5.4).
 *
 * TWO-STEP internal flow (Fase 2.1 punch-list items 2/3): a local `step`
 * state — `'corners' | 'adjust'` — splits what used to be one monolithic
 * screen. This is INTENTIONALLY not a `DocumentPhase` — the store's phase
 * model still only knows `'editing-corners'`; `step` is a presentation-only
 * concern private to this component.
 *  - `'corners'`: ONLY the corner-drag canvas + convex-shape warning.
 *    Primary action is "Next", which validates the quad (`valid && recipe`,
 *    i.e. a successful warp already landed) and advances to `'adjust'`.
 *    Secondary is "Back", which CANCELS the whole editing session (calls
 *    `onCancel`), exactly like the old single-step "Back" did.
 *  - `'adjust'`: the warped preview + aspect/size selector + rotate/flip +
 *    the `FilterPanel` rendered INLINE (no longer a `Sheet` modal — Fase 2.1
 *    item 2, "filters more visible"). Primary action is "Confirm", which
 *    commits the page via `onConfirm` exactly as before (recipe includes
 *    whatever filter was selected here — Fase 2.1 item 3, "filter actually
 *    applies"). Secondary is "Back", which returns to `'corners'` WITHOUT
 *    discarding the in-progress recipe (aspect/rotation/flip/filter edits
 *    made so far are preserved in local state).
 * Aspect changes still re-warp via `runWarp` (unchanged `handleAspectChange`);
 * filter changes NEVER re-warp (`handleFilterChange` only rewrites local
 * recipe state) — both invariants are preserved verbatim across the step
 * split, only their presentation moved.
 *
 * Does NOT touch `originalBitmap` at any point (perspective spec "Ediciones
 * no destructivas sobre el original") — only reads pixels out of it once per
 * confirmed warp. `originalBitmap` ownership stays with the caller: this
 * component never closes it (fresh-capture cancel closes it in
 * `ScannerScreen`; re-entry closes it via `deactivateActivePage`).
 *
 * Fase 2.2 punch-list item 2 (corner-handle coordinate mapping): the source
 * `<canvas>` and the corner overlay `<svg>` both render the frame in
 * LETTERBOX ("contain") mode — `object-contain` / `preserveAspectRatio="xMidYMid meet"`
 * — so no document corner is ever cropped out of view when the frame's
 * aspect ratio differs from the container's fixed `aspect-[3/4]` box (a
 * `slice`/`object-cover` crop would disagree with a naive linear
 * percentage-based handle position, landing handles on the sides instead of
 * the true corners). The draggable handle `<button>`s and `toSourcePoint`
 * both use the SAME `computeLetterboxMapping`/`sourceToDisplay`/
 * `displayToSource` helpers (`geometry.ts`) against the container's
 * LIVE measured box (`ResizeObserver`, see `setContainerRef` below) instead
 * of a stretch-mapping percentage, so the handles and the pointer-to-source
 * conversion always agree with what is actually drawn.
 *
 * Fase 2.2 punch-list item 3 (filter not visible in the big preview):
 * `WarpedPreview` now consumes `recipe.filter` directly — CSS-routable
 * presets draw instantly via `ctx.filter`; adaptive presets (`bw`/
 * `bw-high-contrast`/`eco`, or any preset with `sharpness > 0`) render
 * through a DEBOUNCED, latest-wins `workerClient.applyFilter` call on a
 * downscaled preview-sized copy of the warp base, mirroring `FilterPanel`'s
 * own debounce + monotonic-sequence guard. Filter changes still never
 * re-invoke `runWarp` (D4 unchanged).
 */

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlipHorizontal, RotateCw } from 'lucide-react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { FilterPanel } from '@/features/scanner/components/FilterPanel';
import {
  isConvex,
  inferAspectRatio,
  outputSize,
  layoutSizeForRotation,
  computeLetterboxMapping,
  sourceToDisplay,
  displayToSource,
  type LetterboxMapping,
} from '@/features/scanner/lib/geometry';
import {
  createInitialRecipe,
  frameCorners,
  magnifierSampleRect,
  recipeToCssTransform,
  rotateRecipe,
  flipHorizontalRecipe,
  withFilter,
} from '@/features/scanner/lib/editRecipe';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { buildCssFilter, needsWorker } from '@/features/scanner/lib/filterPipeline';
import { makeThumbnail } from '@/features/scanner/lib/pageResources';
import { getSharedWorkerClient } from '@/features/scanner/lib/workerClient';
import type { FilteredResult, FilterVariant } from '@/features/scanner/worker/messages';
import type { AspectRatioName, Point, Quad } from '@/shared/types/geometry';
import type { EditRecipe, FilterParams } from '@/shared/types/scanner';

const ASPECT_RATIO_OPTIONS: readonly AspectRatioName[] = ['a4', 'letter', 'ticket', 'unknown'];

/** Magnifier canvas size (CSS px) and zoom factor (task 5.1.2, "lupa 2-3x"). */
const MAGNIFIER_SIZE = 120;
const MAGNIFIER_ZOOM = 2.5;
const HANDLE_HIT_SIZE = 44; // touch target >= 44px

export interface CornerEditorConfirmResult {
  /** Fresh, UNFILTERED warp base. Ownership transfers to the caller (materializeCapture / rewarpActivePage own closing it). */
  readonly warpedBase: ImageBitmap;
  readonly recipe: EditRecipe;
}

export interface CornerEditorProps {
  /**
   * Correlates this editing session: a fresh `crypto.randomUUID()` for an
   * unconfirmed capture, or the existing page's id when re-editing an
   * already-materialized page (design section 5.4). Only used by the
   * caller (not read internally) — kept as a prop so callers can key the
   * component by it (fix M3: remount on a new session).
   */
  readonly pageId: string;
  /**
   * Full-res immutable source: the live captured frame's bitmap for a fresh
   * capture, or `activeWorking.originalBitmap` for a re-entered page (design
   * section 5.4). Never mutated or closed by this component.
   */
  readonly originalBitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  /** Scaled detected corners in full-res space, or null when there is no valid prior detection. */
  readonly initialCorners: Quad | null;
  /**
   * The page's existing recipe when re-editing an already-materialized page
   * (preserves `filter`/`rotation`/`flipH`/`flipV` across a corners-only
   * re-warp, design section 2.2). `null` for a fresh, not-yet-confirmed
   * capture — a brand-new recipe is built from scratch on first warp.
   */
  readonly initialRecipe: EditRecipe | null;
  /**
   * Called after the user confirms a successful warp. Ownership of
   * `warpedBase` transfers to the caller, which decides materialize-vs-rewarp
   * semantics (this component is deliberately unaware of `DocumentSlice`).
   */
  readonly onConfirm: (result: CornerEditorConfirmResult) => void;
  /** Called when the user backs out without confirming (discards this session's local edits). */
  readonly onCancel: () => void;
  /**
   * Document-wide "apply filter to all pages" bulk rewrite (design section
   * 5.4/ADR-011). Forwarded verbatim to `FilterPanel` — this component never
   * calls it itself and never imports the store, keeping its own controlled
   * contract store-agnostic (design section 5.4's own framing). Omit to hide
   * the "Apply to all" action (e.g. a document with a single page).
   */
  readonly onApplyToAll?: (filter: FilterParams) => void;
}

function extractImageData(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('CornerEditor: failed to acquire 2d context to extract full-res ImageData.');
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

export function CornerEditor({
  originalBitmap,
  width,
  height,
  initialCorners,
  initialRecipe,
  onConfirm,
  onCancel,
  onApplyToAll,
}: CornerEditorProps): ReactNode {
  const { t } = useTranslation();
  const ASPECT_RATIO_LABELS: Record<AspectRatioName, string> = {
    a4: t('editor.aspectA4'),
    letter: t('editor.aspectLetter'),
    ticket: t('editor.aspectTicket'),
    unknown: t('editor.aspectOriginal'),
  };
  // Local state replaces F1's legacy warpedImage/recipe store fields — this
  // component is a controlled component over its props; the caller
  // (ScannerScreen) decides what to do with the confirmed result.
  const [warpedImage, setWarpedImageState] = useState<ImageBitmap | null>(null);
  const [recipe, setRecipeState] = useState<EditRecipe | null>(initialRecipe);

  /**
   * Close-before-overwrite hygiene (design section 1.5/7), reimplemented
   * LOCALLY since the store no longer owns this bitmap until Confirm hands
   * it off. Mirrors F1's legacy `setWarpedImage` action.
   */
  const applyWarpedImage = useCallback((next: ImageBitmap | null) => {
    setWarpedImageState((prev) => {
      if (prev && prev !== next) {
        prev.close();
      }
      return next;
    });
  }, []);

  const seedCorners = useMemo<Quad>(
    () => initialRecipe?.corners ?? initialCorners ?? frameCorners(width, height),
    [initialRecipe, initialCorners, width, height],
  );

  const [corners, setCornersState] = useState<Quad>(seedCorners);
  const [aspectOverride, setAspectOverride] = useState<AspectRatioName | null>(
    initialRecipe?.aspectRatio ?? null,
  );
  const [isWarping, setIsWarping] = useState(false);
  const [warpError, setWarpError] = useState(false);
  /** Fase 2.1 item 2: internal two-step flow, presentation-only (see module doc comment). */
  const [step, setStep] = useState<'corners' | 'adjust'>('corners');
  const [draggingIndex, setDraggingIndex] = useState<0 | 1 | 2 | 3 | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * Fase 2.2 item 2: the container's LIVE measured CSS box, used to compute
   * the letterbox mapping the handles are positioned with. A `ResizeObserver`
   * (attached via the `setContainerRef` callback ref below, not a mount-only
   * `useEffect`) keeps this correct across viewport/orientation changes while
   * the 'corners' step is mounted, and re-measures on every remount (the
   * step's own container div unmounts/remounts across the 'corners' <->
   * 'adjust' switch — same reasoning as `drawSourceCanvas` above).
   */
  const [containerSize, setContainerSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!node) {
      setContainerSize(null);
      return;
    }
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      resizeObserverRef.current = observer;
    }
  }, []);

  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);

  const letterboxMapping = useMemo<LetterboxMapping | null>(
    () =>
      containerSize ? computeLetterboxMapping(width, height, containerSize.width, containerSize.height) : null,
    [containerSize, width, height],
  );

  const activePointerIdRef = useRef<number | null>(null);
  /** Tracks whether the active drag actually moved, to skip a redundant warp on a bare tap (fix L2). */
  const movedRef = useRef(false);
  /** Guards the one-shot initial warp so it runs exactly once per mounted session. */
  const initialWarpDoneRef = useRef(false);

  // Fix C1/C2: monotonic warp sequence + mounted flag. Every runWarp claims a
  // sequence number; a warp whose number is no longer the latest (a newer warp
  // superseded it) or that resolves after unmount is DROPPED and its bitmap is
  // CLOSED, so a stale warp can never overwrite a newer one and never leaks a
  // full-res ImageBitmap (critical on iOS). The cleanup bumps the sequence so
  // any warp in flight at unmount is invalidated and its bitmap released.
  const warpSeqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      warpSeqRef.current += 1;
    };
  }, []);

  // Draw the source document into the backing canvas so the user can SEE the
  // page while adjusting the corner handles (the overlay/handles alone would
  // float over an empty surface otherwise). `originalBitmap` is immutable and
  // not closed by the memoized ImageData extraction, so it stays drawable here.
  // A CALLBACK ref (not a `useEffect` keyed on the canvas) since the 'corners'
  // step's canvas can unmount/remount across a 'corners' <-> 'adjust' step
  // switch (Fase 2.1 item 2) — an effect keyed on `[originalBitmap, width,
  // height]` would NOT re-fire on a bare remount with unchanged deps and the
  // canvas would come back blank. A callback ref fires on every mount,
  // mirroring the pattern `Magnifier`/`WarpedPreview` already use below.
  const drawSourceCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(originalBitmap, 0, 0);
      }
    },
    [originalBitmap, width, height],
  );

  // Fix H2: `originalBitmap` is immutable, so extract the full-res ImageData
  // ONCE per session instead of allocating a full-res canvas (~48MB for a
  // 3000x4000 frame) on every warp — that repeated allocation can hit iOS's
  // canvas memory cap. The worker TRANSFERS the buffer it receives (leaving it
  // detached), so runWarp clones a fresh buffer per warp and keeps this
  // memoized ImageData intact for subsequent warps of the same session.
  const sourceImageData = useMemo<ImageData | null>(
    () => {
      // Extraction can fail on exotic environments (missing 2d context). Do
      // NOT throw during render — surfacing it as a warp error keeps the editor
      // interactive (the user can still adjust corners / go back) instead of
      // crashing the whole screen. runWarp treats a null extraction as a warp
      // failure.
      try {
        return extractImageData(originalBitmap);
      } catch {
        return null;
      }
    },
    // `originalBitmap` uniquely identifies each session's immutable source.
    [originalBitmap],
  );

  const valid = isConvex(corners);
  const inferred = useMemo(() => inferAspectRatio(corners), [corners]);
  const effectiveAspect = aspectOverride ?? inferred.name;

  /**
   * Converts a pointer event's client coordinates into the frame's source
   * pixel space, using the SAME letterbox mapping the handles are drawn
   * with (Fase 2.2 item 2) — reads the container's LIVE rect on every call
   * rather than the (possibly one-frame-stale) `containerSize` state, so a
   * drag mid-resize never disagrees with what is currently on screen.
   */
  const toSourcePoint = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const mapping = computeLetterboxMapping(width, height, rect.width, rect.height);
      return displayToSource({ x: clientX - rect.left, y: clientY - rect.top }, mapping, width, height);
    },
    [width, height],
  );

  const runWarp = useCallback(
    async (finalCorners: Quad, aspectOverrideArg?: AspectRatioName) => {
      // Fix H1: convexity is a HARD invariant of runWarp, not just a call-site
      // check. Even if a caller forgets to gate on `isConvex` (or gates on a
      // stale closure value), runWarp itself must never warp a non-convex
      // quad. Call-sites still check for UX (to disable the button / preview).
      if (!isConvex(finalCorners)) return;

      // Fix C1/C2: claim a sequence number for this warp. Only the most recent
      // warp is allowed to touch local state; older ones are discarded (and
      // their bitmap closed) when they resolve.
      const seq = (warpSeqRef.current += 1);
      const isLatest = (): boolean => mountedRef.current && seq === warpSeqRef.current;

      setIsWarping(true);
      setWarpError(false);
      try {
        // Guard: if the one-time full-res extraction failed (fix H2 memoized it
        // to null), there is nothing to warp — surface a warp error the same
        // way a worker failure would.
        if (!sourceImageData) {
          throw new Error('CornerEditor: source ImageData unavailable for warp.');
        }
        // `aspectOverrideArg` lets callers that just changed the override in
        // the SAME event handler (handleAspectChange) pass the fresh value
        // directly, avoiding a stale read of `aspectOverride` from this
        // callback's closure before React commits the state update.
        const aspectForWarp = aspectOverrideArg ?? aspectOverride ?? inferAspectRatio(finalCorners).name;
        const workerClient = getSharedWorkerClient();
        // Fix H2: clone a fresh buffer per warp for the transfer. The worker
        // transfers (detaches) the buffer it receives, so transferring the
        // memoized `sourceImageData.data` directly would leave it detached and
        // the NEXT warp of the same session would fail. Cloning keeps the
        // memoized ImageData reusable while still transferring zero-copy.
        const transferData = new Uint8ClampedArray(sourceImageData.data);
        const response = await workerClient.warp(
          { width: sourceImageData.width, height: sourceImageData.height, data: transferData },
          finalCorners,
          aspectForWarp,
        );

        if (response.type === 'WARP_RESULT') {
          // Fix C1/C2: a stale/unmounted result must be dropped AND its bitmap
          // closed here (nothing else would ever receive/release it).
          if (!isLatest()) {
            response.bitmap.close();
            return;
          }
          applyWarpedImage(response.bitmap);
        } else {
          // WARP_RESULT_IMAGEDATA (no OffscreenCanvas, design section 8): paint
          // the plain pixel data into a bitmap the presentation layer can use
          // the same way as the OffscreenCanvas path (design section 1.2).
          const canvas = document.createElement('canvas');
          canvas.width = response.image.width;
          canvas.height = response.image.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            throw new Error('CornerEditor: failed to acquire 2d context for WARP_RESULT_IMAGEDATA.');
          }
          // `ImageDataLike.data` is typed as `Uint8ClampedArray<ArrayBufferLike>`
          // (its backing buffer could in principle be a SharedArrayBuffer),
          // while `ImageData`'s constructor requires `ArrayBuffer` specifically.
          // Re-wrapping the same bytes in a fresh typed array narrows this back
          // to a concrete `ArrayBuffer` without copying semantics changing.
          const pixelData = new Uint8ClampedArray(response.image.data);
          const painted = new ImageData(pixelData, response.image.width, response.image.height);
          ctx.putImageData(painted, 0, 0);
          const bitmap = await createImageBitmap(canvas);
          // Fix M4: release the temporary main-thread canvas backing store as
          // soon as the bitmap is created, on every path.
          canvas.width = 0;
          canvas.height = 0;
          // Fix C1/C2: same stale/unmount guard as the OffscreenCanvas path —
          // close the freshly created bitmap rather than leaking it.
          if (!isLatest()) {
            bitmap.close();
            return;
          }
          applyWarpedImage(bitmap);
        }

        // Design section 2.2 "Re-warp (active)": preserve the CALLER's
        // existing recipe (filter/rotation/flip) across a corners-only
        // re-warp by merging onto it; a fresh capture (no initialRecipe, no
        // prior local recipe yet) builds a brand-new one instead.
        setRecipeState((prev) => {
          const base = prev ?? initialRecipe;
          if (base) {
            return { ...base, corners: finalCorners, aspectRatio: aspectForWarp };
          }
          return createInitialRecipe(finalCorners, aspectForWarp);
        });
      } catch {
        // Only the latest warp may surface an error; a stale warp that rejected
        // after a newer one already succeeded must not flip the UI into error.
        if (isLatest()) setWarpError(true);
      } finally {
        // Fix C1/C2: only the most recent warp clears the loading flag, so a
        // stale warp resolving late cannot hide the spinner of a newer one.
        if (isLatest()) setIsWarping(false);
      }
    },
    [aspectOverride, sourceImageData, initialRecipe, applyWarpedImage],
  );

  // Run one warp as soon as the editor opens so the user immediately sees the
  // corrected preview and can Confirm without first nudging a handle. `recipe`
  // (required to enable Confirm) and `warpedImage` are only produced by a warp,
  // so without this the editor would sit inert with Confirm disabled. Runs once
  // per mounted session (the component is keyed by `pageId`, so a new session
  // remounts and re-warps). Skipped for a non-convex seed — the user must fix
  // the quad first, exactly like the drag path.
  useEffect(() => {
    if (initialWarpDoneRef.current) return;
    if (!sourceImageData || !isConvex(seedCorners)) return;
    initialWarpDoneRef.current = true;
    void runWarp(seedCorners);
  }, [sourceImageData, seedCorners, runWarp]);

  const handlePointerDown = useCallback(
    (index: 0 | 1 | 2 | 3) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerIdRef.current = event.pointerId;
      movedRef.current = false;
      setDraggingIndex(index);
      const point = toSourcePoint(event.clientX, event.clientY);
      if (point) setDragPoint(point);
    },
    [toSourcePoint],
  );

  const handlePointerMove = useCallback(
    (index: 0 | 1 | 2 | 3) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (draggingIndex !== index || activePointerIdRef.current !== event.pointerId) {
        return;
      }
      const point = toSourcePoint(event.clientX, event.clientY);
      if (!point) return;
      movedRef.current = true;
      setDragPoint(point);
      // Task 5.1.4: update the visual quad on every move (so the handle
      // tracks the pointer), but this is a pure local state update — it
      // does NOT call workerClient.warp. The warp only fires in
      // handlePointerUp below.
      setCornersState((prev) => {
        const next = [...prev] as [Point, Point, Point, Point];
        next[index] = point;
        return next as Quad;
      });
    },
    [draggingIndex, toSourcePoint],
  );

  const handlePointerUp = useCallback(
    (index: 0 | 1 | 2 | 3) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (activePointerIdRef.current === event.pointerId) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      activePointerIdRef.current = null;
      setDraggingIndex(null);
      setDragPoint(null);

      // Fix L2: a bare tap (pointerdown + pointerup with no pointermove) leaves
      // the quad unchanged, so re-warping would be redundant — the initial warp
      // (on editor entry) or the last drag's warp already reflects these
      // corners. Only re-warp when the handle actually moved.
      const moved = movedRef.current;
      movedRef.current = false;
      if (!moved) {
        void index;
        return;
      }

      // Task 5.1.3 / 5.1.4: validate convexity and recalc the warp ONLY on
      // release, using the latest committed corners (functional read avoids
      // relying on a possibly-stale `corners` closure).
      setCornersState((latest) => {
        if (isConvex(latest)) {
          void runWarp(latest);
        }
        return latest;
      });
      void index;
    },
    [runWarp],
  );

  const handleConfirm = useCallback(() => {
    if (!valid || !recipe || !warpedImage) return;
    onConfirm({ warpedBase: warpedImage, recipe });
  }, [valid, recipe, warpedImage, onConfirm]);

  const handleCancelClick = useCallback(() => {
    // Nobody else knows about this LOCAL bitmap (unlike `originalBitmap`,
    // which the caller owns) — release it here so cancelling never leaks a
    // full-res warped bitmap (design section 7 hygiene).
    if (warpedImage) {
      warpedImage.close();
    }
    onCancel();
  }, [warpedImage, onCancel]);

  const handleAspectChange = useCallback(
    (name: AspectRatioName) => {
      setAspectOverride(name);
      if (valid) {
        void runWarp(corners, name);
      }
    },
    [corners, runWarp, valid],
  );

  const handleRotate = useCallback(() => {
    setRecipeState((prev) => (prev ? rotateRecipe(prev) : prev));
  }, []);

  const handleFlipHorizontal = useCallback(() => {
    setRecipeState((prev) => (prev ? flipHorizontalRecipe(prev) : prev));
  }, []);

  /**
   * Filter edits (design section 5.4, ADR-009): folded into LOCAL recipe
   * state exactly like rotate/flip above — non-destructive, never triggers
   * `runWarp`. The final value only reaches `DocumentSlice` once the caller's
   * own Confirm flow commits this component's `recipe`
   * (`materializeCapture`/`rewarpActivePage` -> `updateRecipe`).
   */
  const handleFilterChange = useCallback((filter: FilterParams) => {
    setRecipeState((prev) => (prev ? withFilter(prev, filter) : prev));
  }, []);

  /**
   * "Next" (step 'corners' -> 'adjust', Fase 2.1 item 2): the same gate the
   * old single-step "Confirm" button used (`valid && recipe`) — a successful
   * warp must already exist before the user can move on to aspect/filter
   * adjustments, since the 'adjust' step's preview is built from it.
   */
  const handleNextClick = useCallback(() => {
    if (!valid || !recipe) return;
    setStep('adjust');
  }, [valid, recipe]);

  /** "Back" from step 'adjust' returns to 'corners' WITHOUT discarding the in-progress recipe (Fase 2.1 item 2). */
  const handleBackToCorners = useCallback(() => {
    setStep('corners');
  }, []);

  const transform = recipe ? recipeToCssTransform(recipe) : 'none';

  const magnifierRect =
    draggingIndex !== null && dragPoint
      ? magnifierSampleRect(dragPoint.x, dragPoint.y, MAGNIFIER_SIZE, MAGNIFIER_ZOOM, width, height)
      : null;

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="corner-editor">
      {step === 'corners' && (
        <>
          <div
            ref={setContainerRef}
            className="relative aspect-[3/4] w-full max-w-md overflow-hidden rounded-2xl bg-surface"
            data-testid="corner-editor-canvas"
          >
            <canvas ref={drawSourceCanvas} className="absolute inset-0 h-full w-full object-contain" aria-hidden="true" />
            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="xMidYMid meet"
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-hidden="true"
            >
              <polygon
                points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="rgba(94, 234, 212, 0.15)"
                stroke={valid ? 'var(--color-primary-light)' : 'var(--color-danger)'}
                strokeWidth={4}
                strokeLinejoin="round"
              />
            </svg>

            {corners.map((point, index) => {
              // Fase 2.2 item 2: the handle's DISPLAY position uses the SAME
              // letterbox mapping as the canvas/SVG (falls back to the
              // identity mapping for the brief window before the container
              // is measured), positioned in PX (not %) relative to this
              // container — `sourceToDisplay` already accounts for the
              // letterbox offset, which a percentage of container size alone
              // cannot express.
              const display = sourceToDisplay(point, letterboxMapping ?? { scale: 1, offsetX: 0, offsetY: 0 });
              return (
                <button
                  key={index}
                  type="button"
                  aria-label={t('editor.cornerHandle', { n: index + 1 })}
                  data-testid={`corner-handle-${index}`}
                  onPointerDown={handlePointerDown(index as 0 | 1 | 2 | 3)}
                  onPointerMove={handlePointerMove(index as 0 | 1 | 2 | 3)}
                  onPointerUp={handlePointerUp(index as 0 | 1 | 2 | 3)}
                  onPointerCancel={handlePointerUp(index as 0 | 1 | 2 | 3)}
                  style={{
                    left: `${display.x}px`,
                    top: `${display.y}px`,
                    width: HANDLE_HIT_SIZE,
                    height: HANDLE_HIT_SIZE,
                    touchAction: 'none',
                  }}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-surface/80
                    shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light
                    ${valid ? 'border-primary-light' : 'border-danger'}`}
                />
              );
            })}

            {magnifierRect && dragPoint && (
              <Magnifier
                source={originalBitmap}
                rect={magnifierRect}
                size={MAGNIFIER_SIZE}
                anchor={sourceToDisplay(dragPoint, letterboxMapping ?? { scale: 1, offsetX: 0, offsetY: 0 })}
              />
            )}
          </div>

          {!valid && (
            <p role="alert" className="text-sm text-danger" data-testid="corner-editor-invalid">
              {t('editor.convexWarning')}
            </p>
          )}
        </>
      )}

      {step === 'adjust' && warpedImage && recipe && (
        <>
          <div className="flex w-full items-center justify-center gap-2" data-testid="aspect-ratio-selector">
            {ASPECT_RATIO_OPTIONS.map((name) => (
              <Button
                key={name}
                type="button"
                variant={effectiveAspect === name ? 'primary' : 'secondary'}
                onClick={() => handleAspectChange(name)}
                aria-pressed={effectiveAspect === name}
                data-testid={`aspect-ratio-${name}`}
              >
                {ASPECT_RATIO_LABELS[name]}
              </Button>
            ))}
          </div>

          <div className="flex w-full flex-col items-center gap-3" data-testid="warp-preview">
            <div className="w-full max-w-xs overflow-hidden rounded-xl bg-surface">
              <WarpedPreview
                bitmap={warpedImage}
                filter={recipe.filter}
                transform={transform}
                outSize={outputSize(recipe.corners, recipe.aspectRatio)}
                rotation={recipe.rotation}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={handleRotate}
                data-testid="rotate-button"
                aria-label={t('editor.rotate')}
              >
                <RotateCw size={18} strokeWidth={1.5} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleFlipHorizontal}
                data-testid="flip-horizontal-button"
                aria-label={t('editor.flipHorizontal')}
              >
                <FlipHorizontal size={18} strokeWidth={1.5} aria-hidden="true" />
              </Button>
            </div>
          </div>

          <FilterPanel
            baseBitmap={warpedImage}
            filter={recipe.filter}
            onChange={handleFilterChange}
            onApplyToAll={onApplyToAll}
          />
        </>
      )}

      {isWarping && (
        <p className="text-sm text-text-muted" data-testid="warp-loading" role="status" aria-live="polite">
          {t('common.processing')}
        </p>
      )}
      {warpError && (
        <p role="alert" className="text-sm text-danger" data-testid="warp-error">
          {t('editor.processError')}
        </p>
      )}

      <div className="flex w-full items-center justify-between gap-3">
        {step === 'corners' ? (
          <>
            <Button type="button" variant="ghost" onClick={handleCancelClick} data-testid="corner-editor-cancel">
              {t('editor.back')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleNextClick}
              disabled={!valid || !recipe}
              data-testid="corner-editor-next"
            >
              {t('editor.next')}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={handleBackToCorners} data-testid="corner-editor-back">
              {t('editor.back')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleConfirm}
              disabled={!valid || !recipe}
              data-testid="corner-editor-confirm"
            >
              {t('editor.confirm')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

interface MagnifierProps {
  readonly source: ImageBitmap;
  readonly rect: { readonly sx: number; readonly sy: number; readonly sWidth: number; readonly sHeight: number };
  readonly size: number;
  /**
   * Anchor in DISPLAY (letterboxed container) px space — already converted
   * via `sourceToDisplay` at the call site (Fase 2.2 item 2), since the
   * container is no longer a naive stretch-mapping of the source frame.
   */
  readonly anchor: Point;
}

/**
 * Floating circular magnifier canvas, drawn via `drawImage` cropping a
 * 2-3x region under the drag point (task 5.1.2). Purely presentational and
 * DOM-driven — this is intentionally not unit-tested (real drag + canvas
 * pixel output is out of scope per the verification plan); the pure
 * coordinate math it depends on (`magnifierSampleRect`) is unit-tested.
 */
function Magnifier({ source, rect, size, anchor }: MagnifierProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const draw = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      canvasRef.current = canvas;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(source, rect.sx, rect.sy, rect.sWidth, rect.sHeight, 0, 0, size, size);
    },
    [rect, size, source],
  );

  return (
    <canvas
      ref={draw}
      width={size}
      height={size}
      data-testid="corner-editor-magnifier"
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-[calc(100%+24px)] rounded-full border-2
        border-primary-light shadow-lg"
      style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
    />
  );
}

interface WarpedPreviewProps {
  readonly bitmap: ImageBitmap;
  /** Current recipe filter (Fase 2.2 item 3) — the preview must reflect this live. */
  readonly filter: FilterParams;
  readonly transform: string;
  readonly outSize: { readonly outW: number; readonly outH: number };
  readonly rotation: 0 | 90 | 180 | 270;
}

/**
 * Renders the warped bitmap and applies rotation/flip purely via CSS
 * `transform` (ADR-005) — never re-invokes the worker for these edits.
 *
 * Fix H3: the canvas keeps its intrinsic `outW x outH` size, but a 90/270deg
 * CSS rotation swaps the image's visible bounding box (a 700x990 A4 rotated
 * 90deg occupies a 990x700 box). The layout wrapper therefore reserves the
 * ROTATION-AWARE box (`layoutSizeForRotation`) as an `aspect-ratio` so the
 * rotated image fits at the correct aspect instead of overflowing or being
 * clipped. The canvas is centered and scaled to the box's shorter constraint
 * so, once rotated, its rotated footprint stays inside the reserved box.
 *
 * Fase 2.2 item 3: this preview now reflects `filter` LIVE, mirroring
 * `FilterPanel`'s own two-stage routing (`filterPipeline.ts`):
 *  - CSS-routable presets (`needsWorker(filter) === false`) draw instantly
 *    via `ctx.filter = buildCssFilter(filter)` directly on the full-res
 *    `bitmap` — no worker round-trip.
 *  - Adaptive presets (`bw`/`bw-high-contrast`/`eco`, or any preset with
 *    `sharpness > 0`) render through a DEBOUNCED (`FILTER.SLIDER_DEBOUNCE_MS`),
 *    latest-wins `workerClient.applyFilter` call on a downscaled
 *    (`FILTER.WARPED_PREVIEW_MAX_EDGE`) preview-sized copy of `bitmap` —
 *    mirrors `FilterPanel`'s own debounce + monotonic-sequence guard
 *    (design section 4.5) rather than re-deriving a new pattern. The
 *    downscaled result is upscaled back onto the full-size canvas via
 *    `drawImage`'s destination scaling — an intentional CSS-approximation-
 *    grade tradeoff for a live preview, exactly like `buildThumbnailCssFilter`
 *    is for tray/grid thumbnails; the pixel-accurate render happens at
 *    export time (`exportPdf.ts`), not here. Filter changes NEVER trigger
 *    `runWarp` (D4 unchanged) — this component only ever READS `bitmap`.
 */
function WarpedPreview({ bitmap, filter, transform, outSize, rotation }: WarpedPreviewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Close-before-overwrite hygiene for the derived downscaled preview base
  // (design section 1.5/7), mirroring `FilterPanel`'s own `thumbnailRef`
  // pattern. Only populated lazily, the first time an adaptive preset is
  // selected (see the effect below) — a CSS-only session never allocates one.
  const previewBaseRef = useRef<ImageBitmap | null>(null);
  const previewBaseSourceRef = useRef<ImageBitmap | null>(null);
  const [previewBaseVersion, setPreviewBaseVersion] = useState(0);
  const applyPreviewBase = useCallback((next: ImageBitmap | null) => {
    const prev = previewBaseRef.current;
    if (prev && prev !== next) {
      prev.close();
    }
    previewBaseRef.current = next;
    setPreviewBaseVersion((v) => v + 1);
  }, []);

  // The latest batched adaptive-preset render (design section 4.5's
  // "latest-wins-per-target owned by the caller" — this component is that
  // caller, exactly like `FilterPanel`).
  const adaptiveResultRef = useRef<FilteredResult | null>(null);
  const [adaptiveVersion, setAdaptiveVersion] = useState(0);
  const applyAdaptiveResult = useCallback((next: FilteredResult | null) => {
    const prev = adaptiveResultRef.current;
    if (prev?.kind === 'bitmap' && !(next?.kind === 'bitmap' && next.bitmap === prev.bitmap)) {
      prev.bitmap.close();
    }
    adaptiveResultRef.current = next;
    setAdaptiveVersion((v) => v + 1);
  }, []);

  const mountedRef = useRef(true);
  const baseSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Release whatever preview-base/adaptive bitmaps are alive on unmount.
  useEffect(
    () => () => {
      previewBaseRef.current?.close();
      previewBaseRef.current = null;
      const result = adaptiveResultRef.current;
      if (result?.kind === 'bitmap') {
        result.bitmap.close();
      }
      adaptiveResultRef.current = null;
    },
    [],
  );

  // Lazily (re)generate the downscaled preview base whenever the warp base
  // bitmap changes AND the current filter actually needs the worker — a
  // CSS-only session never pays this cost. Guarded so an unrelated slider
  // tweak on an ALREADY-adaptive filter does not regenerate the base bitmap
  // again for the same `bitmap` (only the debounced re-render below reruns).
  useEffect(() => {
    if (!needsWorker(filter)) return;
    if (previewBaseSourceRef.current === bitmap && previewBaseRef.current) return;
    const seq = (baseSeqRef.current += 1);
    void makeThumbnail(bitmap, FILTER.WARPED_PREVIEW_MAX_EDGE)
      .then((thumb) => {
        if (!mountedRef.current || seq !== baseSeqRef.current) {
          thumb.close();
          return;
        }
        previewBaseSourceRef.current = bitmap;
        applyPreviewBase(thumb);
      })
      .catch(() => {
        // Non-fatal: `draw` below falls back to the unfiltered bitmap until a
        // base becomes available.
      });
  }, [bitmap, filter, applyPreviewBase]);

  // Debounced, latest-wins adaptive-preset render (mirrors FilterPanel's own
  // `SLIDER_DEBOUNCE_MS` + monotonic-sequence guard, design section 4.5).
  useEffect(() => {
    if (!needsWorker(filter)) return;
    const base = previewBaseRef.current;
    if (!base) return;

    const timer = setTimeout(() => {
      const seq = (previewSeqRef.current += 1);
      const image = extractImageData(base);
      const variant: FilterVariant = {
        preset: filter.preset,
        brightness: filter.brightness,
        contrast: filter.contrast,
        sharpness: filter.sharpness,
      };
      const outputBitmap = typeof OffscreenCanvas !== 'undefined';

      void getSharedWorkerClient()
        .applyFilter(image, [variant], outputBitmap)
        .then((response) => {
          if (!mountedRef.current || seq !== previewSeqRef.current) {
            // Superseded by a newer debounced request — never leak a stale
            // result's bitmap (design section 4.5).
            for (const result of response.results) {
              if (result.kind === 'bitmap') {
                result.bitmap.close();
              }
            }
            return;
          }
          applyAdaptiveResult(response.results[0] ?? null);
        })
        .catch(() => {
          // Preview failure leaves the last rendered frame in place —
          // non-fatal for editing.
        });
    }, FILTER.SLIDER_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `previewBaseVersion` re-arms this effect once a fresh base lands;
    // `adaptiveVersion` is intentionally NOT a dependency (it is this
    // effect's own output).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewBaseVersion, filter.preset, filter.brightness, filter.contrast, filter.sharpness, applyAdaptiveResult]);

  // Draws whichever source is currently live: CSS-routable presets draw
  // `bitmap` directly with `ctx.filter`; adaptive presets draw the latest
  // batched result (or, while its debounce is still pending, fall back to
  // the unfiltered `bitmap` rather than a blank canvas).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!needsWorker(filter)) {
      ctx.filter = buildCssFilter(filter);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none';
      return;
    }

    const result = adaptiveResultRef.current;
    if (!result) {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return;
    }
    if (result.kind === 'bitmap') {
      ctx.drawImage(result.bitmap, 0, 0, canvas.width, canvas.height);
      return;
    }
    // `ImageDataLike` result: paint it into a scratch canvas first (canvas 2D
    // has no scaled variant of `putImageData`), then `drawImage` that scratch
    // canvas scaled onto the real preview canvas.
    const scratch = document.createElement('canvas');
    scratch.width = result.image.width;
    scratch.height = result.image.height;
    const scratchCtx = scratch.getContext('2d');
    if (scratchCtx) {
      const pixelData = new Uint8ClampedArray(result.image.data);
      scratchCtx.putImageData(new ImageData(pixelData, result.image.width, result.image.height), 0, 0);
      ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    }
    scratch.width = 0;
    scratch.height = 0;
  }, [bitmap, filter, adaptiveVersion]);

  const layout = layoutSizeForRotation(outSize.outW, outSize.outH, rotation);
  const rotated = rotation === 90 || rotation === 270;

  // The wrapper reserves the ROTATION-AWARE box via `aspect-ratio` so the
  // container proportion is correct at every rotation step. Inside it, the
  // canvas is sized to the UNROTATED image aspect: for 0/180 it fills the box
  // width; for 90/270 its intrinsic WIDTH (`outW`) is mapped onto the box
  // HEIGHT (`width: <boxHeight>`), so once the CSS `rotate()` swings it 90deg
  // its footprint lands exactly inside the swapped box instead of overflowing.
  // Sizing is expressed relative to the box so it stays responsive: for the
  // rotated case the canvas width tracks the box height via `height`/`width`
  // percentages against the swapped aspect.
  const canvasStyle = rotated
    ? { width: `${(layout.outH / layout.outW) * 100}%`, height: 'auto', transform }
    : { width: '100%', height: 'auto', transform };

  return (
    <div
      className="relative mx-auto flex items-center justify-center overflow-hidden"
      style={{ width: '100%', aspectRatio: `${layout.outW} / ${layout.outH}` }}
      data-testid="warped-preview-box"
    >
      <canvas
        ref={canvasRef}
        width={outSize.outW}
        height={outSize.outH}
        data-testid="warped-preview-canvas"
        className="motion-safe:transition-transform motion-safe:duration-200"
        style={canvasStyle}
      />
    </div>
  );
}
