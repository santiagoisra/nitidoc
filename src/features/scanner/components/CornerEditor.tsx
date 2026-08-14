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
 *    warp). Confirm hands `{ warpedBase, recipe }` to the caller — this
 *    component never touches `DocumentSlice` directly for this path. Fase 2.3
 *    (capture-ux-redesign.md, Unit 6): this fresh-capture mode is now DEAD —
 *    `CaptureScreen`'s manual captures never reach this component; per-page
 *    detection/warp happens in the deferred `'processing'` batch step
 *    instead (`useBatchProcess.ts`). Kept documented here since the RE-ENTRY
 *    mode below reuses the exact same confirm/cancel contract.
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
 *    discarding the in-progress recipe (rotation/flip/filter edits made so
 *    far are preserved in local state).
 * Corner changes re-warp via `runWarp`; the captured paper selection stays
 * immutable, and no post-capture aspect presets are offered. Filter changes
 * NEVER re-warp (`handleFilterChange` only rewrites local
 * recipe state) — both invariants are preserved verbatim across the step
 * split, only their presentation moved.
 *
 * Does NOT touch `originalBitmap` at any point (perspective spec "Ediciones
 * no destructivas sobre el original") — only reads pixels out of it once per
 * confirmed warp. `originalBitmap` ownership stays with the caller: this
 * component never closes it (fresh-capture cancel closes it in
 * `ScannerScreen`; re-entry closes it via `deactivateActivePage`).
 *
 * Fase 2.2 punch-list item 2 (corner-handle coordinate mapping): the
 * letterbox ("contain") mapping between the source frame and its displayed
 * box — so no document corner is ever cropped out of view when the frame's
 * aspect ratio differs from the container's fixed `aspect-[3/4]` box — now
 * lives entirely in `CropOverlay` (see the "Inline auto-crop Work Unit 1"
 * paragraph below). That file's module doc comment has the full rationale;
 * `geometry.ts`'s `computeLetterboxMapping`/`sourceToDisplay`/
 * `displayToSource` remain the single source of truth either way.
 *
 * Fase 2.2 punch-list item 3 (filter not visible in the big preview):
 * `WarpedPreview` now consumes `recipe.filter` directly — CSS-routable
 * presets draw instantly via `ctx.filter`; adaptive presets (`bw`/
 * `bw-high-contrast`/`eco`, or any preset with `sharpness > 0`) render
 * through a DEBOUNCED, latest-wins `workerClient.applyFilter` call on a
 * downscaled preview-sized copy of the warp base, mirroring `FilterPanel`'s
 * own debounce + monotonic-sequence guard. Filter changes still never
 * re-invoke `runWarp` (D4 unchanged).
 *
 * Inline auto-crop Work Unit 1 (bitmap-agnostic `CropOverlay` extraction):
 * the 'corners' step's source `<canvas>`, letterbox mapping, corner `<svg>`/
 * `<button>` handles, pointer-drag handling, and `Magnifier` loupe now live
 * in `CropOverlay` (`components/CropOverlay.tsx`) — a CONTROLLED,
 * bitmap-agnostic component with no knowledge of `originalBitmap`'s
 * ownership, `EditRecipe`, the worker, or the store, so a future inline crop
 * mode (Work Unit 2, a different screen) can reuse it over any bitmap. This
 * component still owns EVERYTHING about WHEN to warp: `corners` stays local
 * state here (`CropOverlay` only reports changes via `onCornersChange`), and
 * the "warp only on release, only if moved, only if convex" invariant (fix
 * L2, tasks 5.1.3/5.1.4) is reconstructed from `CropOverlay`'s
 * `onDragStateChange(dragging)` callback paired with `movedDuringDragRef`
 * (see `handleDragStateChange` below) instead of the inline pointer handlers
 * this file used to define directly.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlipHorizontal, RotateCw } from 'lucide-react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { CropOverlay } from '@/features/scanner/components/CropOverlay';
import { FilterPanel } from '@/features/scanner/components/FilterPanel';
import { WarpedPreview } from '@/features/scanner/components/WarpedPreview';
import { isConvex, inferAspectRatio, outputSize } from '@/features/scanner/lib/geometry';
import { paperSelection, resolveWarpGeometry } from '@/features/scanner/lib/paperFormats';
import {
  createInitialRecipe,
  frameCorners,
  recipeToCssTransform,
  rotateRecipe,
  flipHorizontalRecipe,
  withFilter,
} from '@/features/scanner/lib/editRecipe';
import { getSharedWorkerClient } from '@/features/scanner/lib/workerClient';
import type { Quad } from '@/shared/types/geometry';
import type { EditRecipe, FilterParams } from '@/shared/types/scanner';

export interface CornerEditorConfirmResult {
  /** Fresh, UNFILTERED warp base. Ownership transfers to the caller (`rewarpActivePage` owns closing it). */
  readonly warpedBase: ImageBitmap;
  readonly recipe: EditRecipe;
}

export interface CornerEditorProps {
  /**
   * Correlates this editing session: a fresh `randomId()` for an
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
  const [isWarping, setIsWarping] = useState(false);
  const [warpError, setWarpError] = useState(false);
  /** Fase 2.1 item 2: internal two-step flow, presentation-only (see module doc comment). */
  const [step, setStep] = useState<'corners' | 'adjust'>('corners');

  /**
   * Tracks whether `CropOverlay` reported at least one `onCornersChange`
   * during the CURRENT drag gesture — reset on `onDragStateChange(true)`,
   * checked (and reset) on `onDragStateChange(false)`. Reconstructs the
   * original "skip a redundant warp on a bare tap" guard (fix L2) now that
   * corner dragging itself lives in `CropOverlay` and this component only
   * observes the two callbacks. See `handleCornersChange`/
   * `handleDragStateChange` below.
   */
  const movedDuringDragRef = useRef(false);
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

  const runWarp = useCallback(
    async (finalCorners: Quad) => {
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
        const aspectForWarp = inferAspectRatio(finalCorners).name;
        // Captured paper provenance is immutable after shutter/import. Corner
        // editing changes geometry only; it must never replace the recipe's
        // paper selection or expose a later format preset.
        const paperForWarp = initialRecipe?.paper ?? paperSelection('original', 'auto', 'none');
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
          resolveWarpGeometry(paperForWarp),
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
            return { ...base, corners: finalCorners, aspectRatio: aspectForWarp, paper: paperForWarp };
          }
          return createInitialRecipe(finalCorners, aspectForWarp, paperForWarp);
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
    [sourceImageData, initialRecipe, applyWarpedImage],
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

  /**
   * `CropOverlay.onCornersChange` — fired continuously while a handle is
   * being dragged. Also marks the current drag gesture as "moved" so
   * `handleDragStateChange` below knows whether to warp when the drag ends
   * (fix L2's bare-tap guard, reconstructed across the two callbacks now
   * that `CropOverlay` owns the drag itself).
   */
  const handleCornersChange = useCallback((next: Quad) => {
    movedDuringDragRef.current = true;
    setCornersState(next);
  }, []);

  /**
   * `CropOverlay.onDragStateChange` — `true` on pointerdown, `false` on
   * pointerup/pointercancel. Reconstructs the original `handlePointerUp`
   * logic verbatim (tasks 5.1.3/5.1.4, fix L2): resets the "moved" guard
   * when a new drag starts, and on release, re-warps ONLY if the drag
   * actually moved a corner (a bare tap is a no-op) and the LATEST
   * committed corners are convex — read via the `setCornersState`
   * functional-updater form so this always sees the truly latest corners
   * regardless of when this callback itself was last recreated (same
   * reasoning as the original `handlePointerUp`'s
   * `setCornersState((latest) => ...)`).
   */
  const handleDragStateChange = useCallback(
    (dragging: boolean) => {
      if (dragging) {
        movedDuringDragRef.current = false;
        return;
      }
      if (!movedDuringDragRef.current) return;
      movedDuringDragRef.current = false;
      setCornersState((latest) => {
        if (isConvex(latest)) {
          void runWarp(latest);
        }
        return latest;
      });
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
   * own Confirm flow commits this component's `recipe` (`rewarpActivePage`
   * -> `updateRecipe`).
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

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="corner-editor">
      {step === 'corners' && (
        <>
          <CropOverlay
            bitmap={originalBitmap}
            width={width}
            height={height}
            corners={corners}
            onCornersChange={handleCornersChange}
            onDragStateChange={handleDragStateChange}
            valid={valid}
          />

          {!valid && (
            <p role="alert" className="text-sm text-danger" data-testid="corner-editor-invalid">
              {t('editor.convexWarning')}
            </p>
          )}
        </>
      )}

      {step === 'adjust' && warpedImage && recipe && (
        <>
          <div className="flex w-full flex-col items-center gap-3" data-testid="warp-preview">
            <div className="w-full max-w-xs overflow-hidden rounded-xl bg-surface">
              <WarpedPreview
                bitmap={warpedImage}
                filter={recipe.filter}
                transform={transform}
                outSize={outputSize(recipe.corners, resolveWarpGeometry(recipe.paper))}
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
