/**
 * Manual corner editor + warp trigger (Group 5 / Slice E; design section 2.2
 * second half; perspective spec CAP-6/CAP-7/CAP-8).
 *
 * Responsibilities (tasks 5.1-5.4):
 *  - Render 4 draggable handles over the captured full-res frame, seeded
 *    from the scaled detected corners when available, or distributed across
 *    the frame otherwise (5.1.1).
 *  - Show a magnifier loupe centered on the handle while dragging (5.1.2).
 *  - Validate convexity with `isConvex` on every pointerup/touchend and
 *    disable "Confirm" + show an invalid state when the quad is not convex
 *    (5.1.3).
 *  - Trigger the warp ONLY on pointerup/touchend, never on intermediate drag
 *    positions (5.1.4 / 5.2.1).
 *  - Handle both `WARP_RESULT` (ImageBitmap) and `WARP_RESULT_IMAGEDATA`
 *    responses depending on `offscreenSupported`, closing the previous
 *    warped bitmap before assigning a new one (5.2.2).
 *  - Build the initial `EditRecipe` on warp success (5.2.3).
 *  - Offer an aspect-ratio override before confirming (5.3.1).
 *  - Offer non-destructive post-warp rotate/flip controls that only touch
 *    the recipe + a CSS transform, never re-invoking the worker (5.4).
 *
 * Does NOT touch `CapturedFrame.source` at any point (perspective spec
 * "Ediciones no destructivas sobre el original") — only reads pixels out of
 * it once per confirmed warp.
 */

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlipHorizontal, RotateCw } from 'lucide-react';
import { Button } from '@/shared/ui';
import {
  isConvex,
  inferAspectRatio,
  outputSize,
  layoutSizeForRotation,
} from '@/features/scanner/lib/geometry';
import {
  createInitialRecipe,
  frameCorners,
  magnifierSampleRect,
  recipeToCssTransform,
  rotateRecipe,
  flipHorizontalRecipe,
} from '@/features/scanner/lib/editRecipe';
import { getSharedWorkerClient } from '@/features/scanner/lib/workerClient';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { AspectRatioName, Point, Quad } from '@/shared/types/geometry';
import type { CapturedFrame } from '@/shared/types/scanner';

const ASPECT_RATIO_OPTIONS: readonly AspectRatioName[] = ['a4', 'letter', 'ticket', 'unknown'];

const ASPECT_RATIO_LABELS: Record<AspectRatioName, string> = {
  a4: 'A4',
  letter: 'Letter',
  ticket: 'Ticket',
  unknown: 'Original',
};

/** Magnifier canvas size (CSS px) and zoom factor (task 5.1.2, "lupa 2-3x"). */
const MAGNIFIER_SIZE = 120;
const MAGNIFIER_ZOOM = 2.5;
const HANDLE_HIT_SIZE = 44; // touch target >= 44px

export interface CornerEditorProps {
  readonly frame: CapturedFrame;
  /** Scaled detected corners in full-res space, or null when there is no valid prior detection. */
  readonly initialCorners: Quad | null;
  /** Called after the user confirms a successful warp and picks a final recipe. */
  readonly onConfirm: () => void;
  /** Called when the user backs out without confirming (resumes the detection loop). */
  readonly onCancel: () => void;
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

export function CornerEditor({ frame, initialCorners, onConfirm, onCancel }: CornerEditorProps): ReactNode {
  const warpedImage = useScannerStore((s) => s.warpedImage);
  const recipe = useScannerStore((s) => s.recipe);
  const setWarpedImage = useScannerStore((s) => s.setWarpedImage);
  const setRecipe = useScannerStore((s) => s.setRecipe);

  const seedCorners = useMemo<Quad>(
    () => initialCorners ?? frameCorners(frame.width, frame.height),
    [initialCorners, frame.width, frame.height],
  );

  const [corners, setCornersState] = useState<Quad>(seedCorners);
  const [aspectOverride, setAspectOverride] = useState<AspectRatioName | null>(null);
  const [isWarping, setIsWarping] = useState(false);
  const [warpError, setWarpError] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<0 | 1 | 2 | 3 | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  /** Tracks whether the active drag actually moved, to skip a redundant warp on a bare tap (fix L2). */
  const movedRef = useRef(false);
  /** Backing canvas that shows the source document behind the handles/overlay. */
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Guards the one-shot initial warp so it runs exactly once per mounted frame. */
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
  // float over an empty surface otherwise). `frame.source` is immutable and not
  // closed by the memoized ImageData extraction, so it stays drawable here.
  useEffect(() => {
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(frame.source, 0, 0);
    }
  }, [frame.source, frame.width, frame.height]);

  // Fix H2: `frame.source` is immutable, so extract the full-res ImageData
  // ONCE per frame instead of allocating a full-res canvas (~48MB for a
  // 3000x4000 frame) on every warp — that repeated allocation can hit iOS's
  // canvas memory cap. The worker TRANSFERS the buffer it receives (leaving it
  // detached), so runWarp clones a fresh buffer per warp and keeps this
  // memoized ImageData intact for subsequent warps of the same frame.
  const sourceImageData = useMemo<ImageData | null>(
    () => {
      // Extraction can fail on exotic environments (missing 2d context). Do
      // NOT throw during render — surfacing it as a warp error keeps the editor
      // interactive (the user can still adjust corners / go back) instead of
      // crashing the whole screen. runWarp treats a null extraction as a warp
      // failure.
      try {
        return extractImageData(frame.source);
      } catch {
        return null;
      }
    },
    // frame.capturedAt uniquely identifies each captured frame's immutable
    // source; frame.source is included so a same-timestamp remount still
    // re-extracts from the correct bitmap.
    [frame.source, frame.capturedAt],
  );

  const valid = isConvex(corners);
  const inferred = useMemo(() => inferAspectRatio(corners), [corners]);
  const effectiveAspect = aspectOverride ?? inferred.name;

  /** Converts a pointer event's client coordinates into the frame's source pixel space. */
  const toSourcePoint = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const scaleX = frame.width / rect.width;
      const scaleY = frame.height / rect.height;
      const x = Math.min(Math.max((clientX - rect.left) * scaleX, 0), frame.width);
      const y = Math.min(Math.max((clientY - rect.top) * scaleY, 0), frame.height);
      return { x, y };
    },
    [frame.width, frame.height],
  );

  const runWarp = useCallback(
    async (finalCorners: Quad, aspectOverrideArg?: AspectRatioName) => {
      // Fix H1: convexity is a HARD invariant of runWarp, not just a call-site
      // check. Even if a caller forgets to gate on `isConvex` (or gates on a
      // stale closure value), runWarp itself must never warp a non-convex
      // quad. Call-sites still check for UX (to disable the button / preview).
      if (!isConvex(finalCorners)) return;

      // Fix C1/C2: claim a sequence number for this warp. Only the most recent
      // warp is allowed to touch the store; older ones are discarded (and their
      // bitmap closed) when they resolve.
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
        // the NEXT warp of the same frame would fail. Cloning keeps the
        // memoized ImageData reusable while still transferring zero-copy.
        const transferData = new Uint8ClampedArray(sourceImageData.data);
        const response = await workerClient.warp(
          { width: sourceImageData.width, height: sourceImageData.height, data: transferData },
          finalCorners,
          aspectForWarp,
        );

        if (response.type === 'WARP_RESULT') {
          // Fix C1/C2: a stale/unmounted result must be dropped AND its bitmap
          // closed here (setWarpedImage would never receive it, so nothing else
          // would ever release it).
          if (!isLatest()) {
            response.bitmap.close();
            return;
          }
          setWarpedImage(response.bitmap);
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
          setWarpedImage(bitmap);
        }

        setRecipe(createInitialRecipe(finalCorners, aspectForWarp));
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
    [aspectOverride, sourceImageData, setRecipe, setWarpedImage],
  );

  // Run one warp as soon as the editor opens so the user immediately sees the
  // corrected preview and can Confirm without first nudging a handle. `recipe`
  // (required to enable Confirm) and `warpedImage` are only produced by a warp,
  // so without this the editor would sit inert with Confirm disabled. Runs once
  // per mounted frame (the component is keyed by `capturedAt`, so a new capture
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
    if (!valid || !recipe) return;
    onConfirm();
  }, [onConfirm, recipe, valid]);

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
    setRecipe(recipe ? rotateRecipe(recipe) : recipe);
  }, [recipe, setRecipe]);

  const handleFlipHorizontal = useCallback(() => {
    setRecipe(recipe ? flipHorizontalRecipe(recipe) : recipe);
  }, [recipe, setRecipe]);

  const transform = recipe ? recipeToCssTransform(recipe) : 'none';

  const magnifierRect =
    draggingIndex !== null && dragPoint
      ? magnifierSampleRect(dragPoint.x, dragPoint.y, MAGNIFIER_SIZE, MAGNIFIER_ZOOM, frame.width, frame.height)
      : null;

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4" data-testid="corner-editor">
      <div
        ref={containerRef}
        className="relative aspect-[3/4] w-full max-w-md overflow-hidden rounded-2xl bg-surface"
        data-testid="corner-editor-canvas"
      >
        <canvas
          ref={sourceCanvasRef}
          className="absolute inset-0 h-full w-full object-cover"
          aria-hidden="true"
        />
        <svg
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          preserveAspectRatio="xMidYMid slice"
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
          const leftPct = (point.x / frame.width) * 100;
          const topPct = (point.y / frame.height) * 100;
          return (
            <button
              key={index}
              type="button"
              aria-label={`Corner handle ${index + 1}`}
              data-testid={`corner-handle-${index}`}
              onPointerDown={handlePointerDown(index as 0 | 1 | 2 | 3)}
              onPointerMove={handlePointerMove(index as 0 | 1 | 2 | 3)}
              onPointerUp={handlePointerUp(index as 0 | 1 | 2 | 3)}
              onPointerCancel={handlePointerUp(index as 0 | 1 | 2 | 3)}
              style={{
                left: `${leftPct}%`,
                top: `${topPct}%`,
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

        {magnifierRect && (
          <Magnifier
            source={frame.source}
            rect={magnifierRect}
            size={MAGNIFIER_SIZE}
            anchor={dragPoint as Point}
            frameWidth={frame.width}
            frameHeight={frame.height}
          />
        )}
      </div>

      {!valid && (
        <p role="alert" className="text-sm text-danger" data-testid="corner-editor-invalid">
          Corners must form a convex shape. Adjust a handle to continue.
        </p>
      )}

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

      {warpedImage && recipe && (
        <div className="flex w-full flex-col items-center gap-3" data-testid="warp-preview">
          <div className="w-full max-w-xs overflow-hidden rounded-xl bg-surface">
            <WarpedPreview
              bitmap={warpedImage}
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
              aria-label="Rotate 90 degrees"
            >
              <RotateCw size={18} strokeWidth={1.5} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleFlipHorizontal}
              data-testid="flip-horizontal-button"
              aria-label="Flip horizontal"
            >
              <FlipHorizontal size={18} strokeWidth={1.5} aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {isWarping && (
        <p className="text-sm text-text-muted" data-testid="warp-loading" role="status" aria-live="polite">
          Processing…
        </p>
      )}
      {warpError && (
        <p role="alert" className="text-sm text-danger" data-testid="warp-error">
          Could not process the image. Adjust a corner to retry.
        </p>
      )}

      <div className="flex w-full items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="corner-editor-cancel">
          Back
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={handleConfirm}
          disabled={!valid || !recipe}
          data-testid="corner-editor-confirm"
        >
          Confirm
        </Button>
      </div>
    </div>
  );
}

interface MagnifierProps {
  readonly source: ImageBitmap;
  readonly rect: { readonly sx: number; readonly sy: number; readonly sWidth: number; readonly sHeight: number };
  readonly size: number;
  readonly anchor: Point;
  readonly frameWidth: number;
  readonly frameHeight: number;
}

/**
 * Floating circular magnifier canvas, drawn via `drawImage` cropping a
 * 2-3x region under the drag point (task 5.1.2). Purely presentational and
 * DOM-driven — this is intentionally not unit-tested (real drag + canvas
 * pixel output is out of scope per the verification plan); the pure
 * coordinate math it depends on (`magnifierSampleRect`) is unit-tested.
 */
function Magnifier({ source, rect, size, anchor, frameWidth, frameHeight }: MagnifierProps): ReactNode {
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

  const leftPct = (anchor.x / frameWidth) * 100;
  const topPct = (anchor.y / frameHeight) * 100;

  return (
    <canvas
      ref={draw}
      width={size}
      height={size}
      data-testid="corner-editor-magnifier"
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-[calc(100%+24px)] rounded-full border-2
        border-primary-light shadow-lg"
      style={{ left: `${leftPct}%`, top: `${topPct}%` }}
    />
  );
}

interface WarpedPreviewProps {
  readonly bitmap: ImageBitmap;
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
 */
function WarpedPreview({ bitmap, transform, outSize, rotation }: WarpedPreviewProps): ReactNode {
  const draw = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
    },
    [bitmap],
  );

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
        ref={draw}
        width={outSize.outW}
        height={outSize.outH}
        data-testid="warped-preview-canvas"
        className="motion-safe:transition-transform motion-safe:duration-200"
        style={canvasStyle}
      />
    </div>
  );
}
