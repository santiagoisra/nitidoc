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
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlipHorizontal, RotateCw } from 'lucide-react';
import { Button } from '@/shared/ui';
import { isConvex, inferAspectRatio, outputSize } from '@/features/scanner/lib/geometry';
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
      setIsWarping(true);
      setWarpError(false);
      try {
        const imageData = extractImageData(frame.source);
        // `aspectOverrideArg` lets callers that just changed the override in
        // the SAME event handler (handleAspectChange) pass the fresh value
        // directly, avoiding a stale read of `aspectOverride` from this
        // callback's closure before React commits the state update.
        const aspectForWarp = aspectOverrideArg ?? aspectOverride ?? inferAspectRatio(finalCorners).name;
        const workerClient = getSharedWorkerClient();
        const response = await workerClient.warp(
          { width: imageData.width, height: imageData.height, data: imageData.data },
          finalCorners,
          aspectForWarp,
        );

        if (response.type === 'WARP_RESULT') {
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
          setWarpedImage(bitmap);
        }

        setRecipe(createInitialRecipe(finalCorners, aspectForWarp));
      } catch {
        setWarpError(true);
      } finally {
        setIsWarping(false);
      }
    },
    [aspectOverride, frame.source, setRecipe, setWarpedImage],
  );

  const handlePointerDown = useCallback(
    (index: 0 | 1 | 2 | 3) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerIdRef.current = event.pointerId;
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
            <WarpedPreview bitmap={warpedImage} transform={transform} outSize={outputSize(recipe.corners, recipe.aspectRatio)} />
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
}

/**
 * Renders the warped bitmap and applies rotation/flip purely via CSS
 * `transform` (ADR-005) — never re-invokes the worker for these edits.
 */
function WarpedPreview({ bitmap, transform, outSize }: WarpedPreviewProps): ReactNode {
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

  return (
    <canvas
      ref={draw}
      width={outSize.outW}
      height={outSize.outH}
      data-testid="warped-preview-canvas"
      className="h-auto w-full motion-safe:transition-transform motion-safe:duration-200"
      style={{ transform }}
    />
  );
}
