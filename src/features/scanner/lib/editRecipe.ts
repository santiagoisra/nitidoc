/**
 * Pure, DOM-free helpers for the corner editor and its non-destructive edit
 * recipe (design section 5.2; design ADR-005; Group 5 / Slice E).
 *
 * Kept separate from `geometry.ts` (which owns corner ORDERING/convexity/
 * aspect-ratio inference used by the warp pipeline itself) because this
 * module is about the EDITOR's own concerns: seeding initial handle
 * positions, building/evolving the `EditRecipe`, and the rotation/flip
 * cycle that never touches the worker. Both modules are DOM-free and
 * testable in Node.
 */

import type { AspectRatioName, Quad } from '@/shared/types/geometry';
import type { EditRecipe, FilterParams } from '@/shared/types/scanner';
import { NEUTRAL_FILTER } from '@/shared/types/scanner';

/**
 * Distributes 4 corners across the full frame rectangle
 * (perspective spec "Sin deteccion previa, editor con frame completo").
 * Used when there is no valid prior detection (5s no-detection timeout,
 * non-convex contour, or a manual import with no pre-run DETECT).
 *
 * A small inset keeps the initial handles draggable without immediately
 * sitting on the frame's exact edge (still fully user-adjustable).
 */
export function frameCorners(
  width: number,
  height: number,
  insetRatio = 0.05,
): Quad {
  const insetX = width * insetRatio;
  const insetY = height * insetRatio;
  return [
    { x: insetX, y: insetY },
    { x: width - insetX, y: insetY },
    { x: width - insetX, y: height - insetY },
    { x: insetX, y: height - insetY },
  ] as Quad;
}

/**
 * Creates the initial `EditRecipe` once a warp completes
 * (task 5.2.3; perspective spec "Warp exitoso con aspect ratio inferido"):
 * `{ corners, aspectRatio, rotation: 0, flipH: false, flipV: false, filter: NEUTRAL_FILTER }`.
 * The filter seeds to `NEUTRAL_FILTER` (design section 1.1) — every page
 * starts unfiltered until the user picks a preset.
 */
export function createInitialRecipe(corners: Quad, aspectRatio: AspectRatioName): EditRecipe {
  return {
    corners,
    aspectRatio,
    rotation: 0,
    flipH: false,
    flipV: false,
    filter: NEUTRAL_FILTER,
  };
}

const ROTATION_CYCLE: readonly [0, 90, 180, 270] = [0, 90, 180, 270];

/** Advances the rotation to the next 90-degree step in the cycle 0 -> 90 -> 180 -> 270 -> 0 (ADR-005). */
export function nextRotation(current: EditRecipe['rotation']): EditRecipe['rotation'] {
  const index = ROTATION_CYCLE.indexOf(current);
  const nextIndex = (index + 1) % ROTATION_CYCLE.length;
  return ROTATION_CYCLE[nextIndex] as EditRecipe['rotation'];
}

/**
 * Returns a new recipe with rotation advanced by one 90-degree step.
 * Non-destructive: does not mutate `recipe`, only derives a new object
 * (perspective spec "Rotacion de 90 grados").
 */
export function rotateRecipe(recipe: EditRecipe): EditRecipe {
  return { ...recipe, rotation: nextRotation(recipe.rotation) };
}

/** Returns a new recipe with `flipH` toggled (perspective spec "Volteo horizontal"). */
export function flipHorizontalRecipe(recipe: EditRecipe): EditRecipe {
  return { ...recipe, flipH: !recipe.flipH };
}

/** Returns a new recipe with `flipV` toggled — vertical flip counterpart, same non-destructive contract. */
export function flipVerticalRecipe(recipe: EditRecipe): EditRecipe {
  return { ...recipe, flipV: !recipe.flipV };
}

/**
 * Returns a new recipe with `filter` replaced (design section 1.1; ADR-009).
 * Non-destructive, JSON-only: never re-invokes the warp — filter changes are
 * a presentation-layer overlay applied on top of the cached warp base.
 */
export function withFilter(recipe: EditRecipe, filter: FilterParams): EditRecipe {
  return { ...recipe, filter };
}

/**
 * Builds the CSS `transform` value for the non-destructive rotation/flip
 * preview (ADR-005: rotation/flip live in the recipe and are applied in the
 * presentation layer, never re-invoking the worker). Order matters: flips
 * are applied before rotation so a horizontal flip stays "horizontal" from
 * the viewer's perspective regardless of the current rotation step.
 */
export function recipeToCssTransform(recipe: Pick<EditRecipe, 'rotation' | 'flipH' | 'flipV'>): string {
  const parts: string[] = [];
  if (recipe.flipH) parts.push('scaleX(-1)');
  if (recipe.flipV) parts.push('scaleY(-1)');
  if (recipe.rotation !== 0) parts.push(`rotate(${recipe.rotation}deg)`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/**
 * Magnifier sampling rect (task 5.1.2 — "lupa magnificadora"). Given a
 * handle's position in the editor's displayed (CSS pixel) space and the
 * scale factor from displayed space to source-image space, returns the
 * source-image rectangle to sample for the magnifier's `drawImage` crop.
 * `zoom` is the magnification factor (2-3x per spec); the sampled rect is
 * sized so that, once drawn at `zoom`x into a fixed-size magnifier canvas,
 * it fills that canvas.
 */
export interface MagnifierSampleRect {
  readonly sx: number;
  readonly sy: number;
  readonly sWidth: number;
  readonly sHeight: number;
}

export function magnifierSampleRect(
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
