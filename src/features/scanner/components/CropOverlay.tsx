/**
 * Reusable draggable-corner crop overlay: draws a source bitmap and 4
 * draggable corner handles (plus the quad they trace) over it, using a
 * LETTERBOX ("contain") mapping so the handles always agree with what is
 * actually drawn regardless of the bitmap's aspect ratio.
 *
 * Extracted out of `CornerEditor` (inline auto-crop feature, Work Unit 1) so
 * a future inline crop mode (Work Unit 2, a different screen) can render the
 * exact same drag/letterbox/magnifier mechanics over any bitmap, without
 * `CornerEditor`'s warp/recipe/store concerns riding along. This file must
 * NOT import the document store, `useActivePage`, the worker client, or
 * `editRecipe` — it only knows about bitmaps and corner points (see
 * `CropOverlayProps` below). `CornerEditor` is the sole consumer for now.
 *
 * CONTROLLED component: `corners` is owned by the caller and rendered
 * as-is; this component reports every drag-move via `onCornersChange` and
 * reports drag start/end via `onDragStateChange`. It holds only EPHEMERAL
 * drag state locally (which handle is active, the live magnifier position)
 * — never the source-of-truth corner positions, and it never triggers a
 * warp. Deciding WHETHER (and when) to warp is entirely the caller's job:
 * `CornerEditor` reconstructs its original "warp only if the pointer
 * actually moved" guard (fix L2) by tracking whether `onCornersChange` fired
 * between an `onDragStateChange(true)` and the following `(false)` — see
 * `CornerEditor`'s `movedDuringDragRef` / `handleDragStateChange`.
 *
 * Letterbox mapping (Fase 2.2 punch-list item 2, ported verbatim from
 * `CornerEditor`): the source `<canvas>` and the corner overlay `<svg>` both
 * render the frame in LETTERBOX mode — `object-contain` /
 * `preserveAspectRatio="xMidYMid meet"` — so no document corner is ever
 * cropped out of view when the frame's aspect ratio differs from the
 * container's fixed `aspect-[3/4]` box (a `slice`/`object-cover` crop would
 * disagree with a naive linear percentage-based handle position, landing
 * handles on the sides instead of the true corners). The draggable handle
 * `<button>`s and `toSourcePoint` both use the SAME
 * `computeLetterboxMapping`/`sourceToDisplay`/`displayToSource` helpers
 * (`geometry.ts`) against the container's LIVE measured box (`ResizeObserver`,
 * see `setContainerRef` below) instead of a stretch-mapping percentage, so
 * the handles and the pointer-to-source conversion always agree with what is
 * actually drawn.
 *
 * `magnifierSampleRect` below is a deliberate DUPLICATE of the pure function
 * of the same name in `lib/editRecipe.ts` (covered by
 * `tests/unit/editRecipe.test.ts`), not an import — this file must not
 * depend on the recipe module (see above), and the function is small, pure,
 * and has zero recipe-domain coupling. Keep both copies in sync if the
 * sampling math ever changes.
 */

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/shared/i18n';
import {
  computeLetterboxMapping,
  sourceToDisplay,
  displayToSource,
  isConvex,
  type LetterboxMapping,
} from '@/features/scanner/lib/geometry';
import type { Point, Quad } from '@/shared/types/geometry';

/** Magnifier canvas size (CSS px) and zoom factor (task 5.1.2, "lupa 2-3x"). */
const MAGNIFIER_SIZE = 120;
const MAGNIFIER_ZOOM = 2.5;
const HANDLE_HIT_SIZE = 44; // touch target >= 44px

type CropSide = 'top' | 'right' | 'bottom' | 'left';
type DragTarget = 0 | 1 | 2 | 3 | CropSide;
type SideHandleLabelKey =
  | 'editor.moveTopEdge'
  | 'editor.moveRightEdge'
  | 'editor.moveBottomEdge'
  | 'editor.moveLeftEdge';

const CROP_SIDES: readonly CropSide[] = ['top', 'right', 'bottom', 'left'];

const SIDE_HANDLE_LABEL_KEYS: Record<CropSide, SideHandleLabelKey> = {
  top: 'editor.moveTopEdge',
  right: 'editor.moveRightEdge',
  bottom: 'editor.moveBottomEdge',
  left: 'editor.moveLeftEdge',
};

export interface CropOverlayProps {
  /** Full-res, immutable bitmap drawn as the crop background. Never mutated or closed by this component — ownership stays with the caller. */
  readonly bitmap: ImageBitmap;
  /** `bitmap`'s intrinsic pixel dimensions — the coordinate space `corners`/`onCornersChange` operate in. */
  readonly width: number;
  readonly height: number;
  /** Current corner positions in SOURCE (full-res) pixel space, `[topLeft, topRight, bottomRight, bottomLeft]`. This component is CONTROLLED — it renders exactly these corners and never mutates them itself. */
  readonly corners: Quad;
  /** Fired with the full next `Quad` on every drag move, not just on release (task 5.1.4: "update the visual quad on every move"). */
  readonly onCornersChange: (corners: Quad) => void;
  /** Fired `true` when a handle drag starts (pointerdown) and `false` when it ends (pointerup/pointercancel). Optional — lets the caller decide what, if anything, happens on release; this component never warps or otherwise reacts to its own value. */
  readonly onDragStateChange?: (dragging: boolean) => void;
  /** Drives handle/polygon color. The caller computes what "valid" means (e.g. `isConvex(corners)`) — this component has no opinion on convexity. Defaults to `true`. */
  readonly valid?: boolean;
}

export function CropOverlay({
  bitmap,
  width,
  height,
  corners,
  onCornersChange,
  onDragStateChange,
  valid = true,
}: CropOverlayProps): ReactNode {
  const { t } = useTranslation();

  const [draggingTarget, setDraggingTarget] = useState<DragTarget | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * The container's LIVE measured CSS box, used to compute the letterbox
   * mapping the handles are positioned with. A `ResizeObserver` (attached via
   * the `setContainerRef` callback ref below, not a mount-only `useEffect`)
   * keeps this correct across viewport/orientation changes, and re-measures
   * on every remount.
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

  // Draw the source bitmap into the backing canvas so the user can SEE the
  // page while adjusting the corner handles (the overlay/handles alone would
  // float over an empty surface otherwise). `bitmap` is immutable and not
  // closed here, so it stays drawable across re-renders. A CALLBACK ref (not
  // a `useEffect` keyed on the canvas) since this component's canvas can
  // unmount/remount independently of its props (Fase 2.1 item 2's
  // 'corners' <-> 'adjust' step switch in `CornerEditor`) — an effect keyed
  // on `[bitmap, width, height]` would NOT re-fire on a bare remount with
  // unchanged deps and the canvas would come back blank. A callback ref fires
  // on every mount, mirroring the pattern `Magnifier`/`WarpedPreview` use.
  const drawSourceCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
      }
    },
    [bitmap, width, height],
  );

  /**
   * Converts a pointer event's client coordinates into the frame's source
   * pixel space, using the SAME letterbox mapping the handles are drawn
   * with — reads the container's LIVE rect on every call rather than the
   * (possibly one-frame-stale) `containerSize` state, so a drag mid-resize
   * never disagrees with what is currently on screen.
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

  const handlePointerDown = useCallback(
    (target: DragTarget) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (activePointerIdRef.current !== null) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerIdRef.current = event.pointerId;
      setDraggingTarget(target);
      onDragStateChange?.(true);
      const point = toSourcePoint(event.clientX, event.clientY);
      if (point) setDragPoint(point);
    },
    [toSourcePoint, onDragStateChange],
  );

  const handlePointerMove = useCallback(
    (target: DragTarget) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (draggingTarget !== target || activePointerIdRef.current !== event.pointerId) {
        return;
      }
      const point = toSourcePoint(event.clientX, event.clientY);
      if (!point) return;
      setDragPoint(point);
      const next = [...corners] as [Point, Point, Point, Point];
      if (typeof target === 'number') {
        next[target] = point;
        // Corner handles intentionally remain unconstrained: callers use the
        // resulting invalid state to show the existing convexity guidance.
        onCornersChange(next as Quad);
        return;
      } else if (target === 'top') {
        next[0] = { ...next[0], y: point.y };
        next[1] = { ...next[1], y: point.y };
      } else if (target === 'right') {
        next[1] = { ...next[1], x: point.x };
        next[2] = { ...next[2], x: point.x };
      } else if (target === 'bottom') {
        next[2] = { ...next[2], y: point.y };
        next[3] = { ...next[3], y: point.y };
      } else {
        next[3] = { ...next[3], x: point.x };
        next[0] = { ...next[0], x: point.x };
      }

      // Side drags move a pair together, so never report a degenerate or
      // concave candidate. A valid candidate is emitted in full on every move.
      if (isConvex(next)) onCornersChange(next as Quad);
    },
    [draggingTarget, toSourcePoint, corners, onCornersChange],
  );

  const handlePointerUp = useCallback(
    () => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (activePointerIdRef.current !== event.pointerId) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      activePointerIdRef.current = null;
      setDraggingTarget(null);
      setDragPoint(null);
      onDragStateChange?.(false);
    },
    [onDragStateChange],
  );

  const handleSideKeyDown = useCallback(
    (side: CropSide) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const movement =
        (side === 'top' && event.key === 'ArrowUp') ||
        (side === 'bottom' && event.key === 'ArrowUp') ||
        (side === 'left' && event.key === 'ArrowLeft') ||
        (side === 'right' && event.key === 'ArrowLeft')
          ? -1
          : (side === 'top' && event.key === 'ArrowDown') ||
              (side === 'bottom' && event.key === 'ArrowDown') ||
              (side === 'left' && event.key === 'ArrowRight') ||
              (side === 'right' && event.key === 'ArrowRight')
            ? 1
            : 0;
      if (movement === 0) return;
      event.preventDefault();
      const next = [...corners] as [Point, Point, Point, Point];
      const step = (side === 'top' || side === 'bottom' ? height : width) * 0.01 * movement;
      if (side === 'top') {
        next[0] = { ...next[0], y: next[0].y + step };
        next[1] = { ...next[1], y: next[1].y + step };
      } else if (side === 'right') {
        next[1] = { ...next[1], x: next[1].x + step };
        next[2] = { ...next[2], x: next[2].x + step };
      } else if (side === 'bottom') {
        next[2] = { ...next[2], y: next[2].y + step };
        next[3] = { ...next[3], y: next[3].y + step };
      } else {
        next[3] = { ...next[3], x: next[3].x + step };
        next[0] = { ...next[0], x: next[0].x + step };
      }
      if (!isConvex(next)) return;
      onDragStateChange?.(true);
      onCornersChange(next as Quad);
      onDragStateChange?.(false);
    },
    [corners, height, onCornersChange, onDragStateChange, width],
  );

  const magnifierRect =
    draggingTarget !== null && dragPoint
      ? magnifierSampleRect(dragPoint.x, dragPoint.y, MAGNIFIER_SIZE, MAGNIFIER_ZOOM, width, height)
      : null;

  const sideMidpoints: Record<CropSide, Point> = {
    top: midpoint(corners[0], corners[1]),
    right: midpoint(corners[1], corners[2]),
    bottom: midpoint(corners[2], corners[3]),
    left: midpoint(corners[3], corners[0]),
  };

  return (
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
        // The handle's DISPLAY position uses the SAME letterbox mapping as
        // the canvas/SVG (falls back to the identity mapping for the brief
        // window before the container is measured), positioned in PX (not
        // %) relative to this container — `sourceToDisplay` already
        // accounts for the letterbox offset, which a percentage of
        // container size alone cannot express.
        const display = sourceToDisplay(point, letterboxMapping ?? { scale: 1, offsetX: 0, offsetY: 0 });
        return (
          <button
            key={index}
            type="button"
            aria-label={t('editor.cornerHandle', { n: index + 1 })}
            data-testid={`corner-handle-${index}`}
            onPointerDown={handlePointerDown(index as 0 | 1 | 2 | 3)}
            onPointerMove={handlePointerMove(index as 0 | 1 | 2 | 3)}
            onPointerUp={handlePointerUp()}
            onPointerCancel={handlePointerUp()}
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

      {CROP_SIDES.map((side) => {
        const display = sourceToDisplay(sideMidpoints[side], letterboxMapping ?? { scale: 1, offsetX: 0, offsetY: 0 });
        return (
          <button
            key={side}
            type="button"
            aria-label={t(SIDE_HANDLE_LABEL_KEYS[side])}
            data-testid={`crop-side-handle-${side}`}
            onPointerDown={handlePointerDown(side)}
            onPointerMove={handlePointerMove(side)}
            onPointerUp={handlePointerUp()}
            onPointerCancel={handlePointerUp()}
            onKeyDown={handleSideKeyDown(side)}
            style={{
              left: `${display.x}px`,
              top: `${display.y}px`,
              width: HANDLE_HIT_SIZE,
              height: HANDLE_HIT_SIZE,
              touchAction: 'none',
            }}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-surface/80
                ${valid ? 'border-primary-light' : 'border-danger'}`}
            />
          </button>
        );
      })}

      {magnifierRect && dragPoint && (
        <Magnifier
          source={bitmap}
          rect={magnifierRect}
          size={MAGNIFIER_SIZE}
          anchor={sourceToDisplay(dragPoint, letterboxMapping ?? { scale: 1, offsetX: 0, offsetY: 0 })}
        />
      )}
    </div>
  );
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

interface MagnifierProps {
  readonly source: ImageBitmap;
  readonly rect: { readonly sx: number; readonly sy: number; readonly sWidth: number; readonly sHeight: number };
  readonly size: number;
  /**
   * Anchor in DISPLAY (letterboxed container) px space — already converted
   * via `sourceToDisplay` at the call site, since the container is not a
   * naive stretch-mapping of the source frame.
   */
  readonly anchor: Point;
}

/**
 * Floating circular magnifier canvas, drawn via `drawImage` cropping a
 * 2-3x region under the drag point (task 5.1.2). Purely presentational and
 * DOM-driven — this is intentionally not unit-tested (real drag + canvas
 * pixel output is out of scope); the pure coordinate math it depends on
 * (`magnifierSampleRect`) is unit-tested (`tests/unit/editRecipe.test.ts`).
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

interface MagnifierSampleRect {
  readonly sx: number;
  readonly sy: number;
  readonly sWidth: number;
  readonly sHeight: number;
}

/**
 * DUPLICATE of `lib/editRecipe.ts`'s `magnifierSampleRect` (see this file's
 * module doc comment for why this is copied rather than imported). Given a
 * handle's position in source-image space and the desired zoom, returns the
 * source-image rectangle to sample for the magnifier's `drawImage` crop.
 */
function magnifierSampleRect(
  handleSourceX: number,
  handleSourceY: number,
  magnifierSize: number,
  zoom: number,
  sourceWidth: number,
  sourceHeight: number,
): MagnifierSampleRect {
  const sampleSize = magnifierSize / zoom;
  const half = sampleSize / 2;

  const sx = Math.min(Math.max(handleSourceX - half, 0), Math.max(sourceWidth - sampleSize, 0));
  const sy = Math.min(Math.max(handleSourceY - half, 0), Math.max(sourceHeight - sampleSize, 0));

  return {
    sx,
    sy,
    sWidth: Math.min(sampleSize, sourceWidth),
    sHeight: Math.min(sampleSize, sourceHeight),
  };
}
