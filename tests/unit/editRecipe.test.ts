import { describe, expect, it } from 'vitest';
import {
  createInitialRecipe,
  flipHorizontalRecipe,
  flipVerticalRecipe,
  frameCorners,
  magnifierSampleRect,
  nextRotation,
  recipeToCssTransform,
  rotateRecipe,
} from '@/features/scanner/lib/editRecipe';
import { isConvex } from '@/features/scanner/lib/geometry';
import type { Quad } from '@/shared/types/geometry';
import type { EditRecipe } from '@/shared/types/scanner';

describe('frameCorners (task 5.1.1 — no valid detection fallback)', () => {
  it('distributes 4 corners across the full frame with a small inset', () => {
    const corners = frameCorners(1000, 2000);
    expect(corners[0]).toEqual({ x: 50, y: 100 });
    expect(corners[1]).toEqual({ x: 950, y: 100 });
    expect(corners[2]).toEqual({ x: 950, y: 1900 });
    expect(corners[3]).toEqual({ x: 50, y: 1900 });
  });

  it('produces a convex quad (reuses geometry.isConvex — the same gate the editor uses)', () => {
    const corners = frameCorners(1200, 1600);
    expect(isConvex(corners)).toBe(true);
  });

  it('respects a custom inset ratio', () => {
    const corners = frameCorners(100, 100, 0.1);
    expect(corners[0]).toEqual({ x: 10, y: 10 });
    expect(corners[2]).toEqual({ x: 90, y: 90 });
  });
});

describe('isConvex applied to editor-produced quads (task 5.1.3 gate, reused from geometry.ts)', () => {
  it('accepts a convex quad the user could plausibly drag into', () => {
    const dragged: Quad = [
      { x: 10, y: 10 },
      { x: 90, y: 5 },
      { x: 95, y: 95 },
      { x: 5, y: 90 },
    ];
    expect(isConvex(dragged)).toBe(true);
  });

  it('rejects a self-intersecting quad produced by dragging a handle across an adjacent one', () => {
    // Swapping handle 1 (top-right) and handle 3 (bottom-left)'s positions on
    // an otherwise-rectangular quad turns it into a classic bowtie: edges
    // 0->1 and 2->3 now cross each other.
    const crossed: Quad = [
      { x: 0, y: 0 },
      { x: 90, y: 90 },
      { x: 90, y: 0 },
      { x: 0, y: 90 },
    ];
    expect(isConvex(crossed)).toBe(false);
  });
});

describe('createInitialRecipe (task 5.2.3)', () => {
  it('builds the initial recipe with rotation 0 and no flips', () => {
    const corners = frameCorners(800, 1000);
    const recipe = createInitialRecipe(corners, 'a4');
    expect(recipe).toEqual({
      corners,
      aspectRatio: 'a4',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });

  it('is JSON-serializable (no binary handles)', () => {
    const corners = frameCorners(800, 1000);
    const recipe = createInitialRecipe(corners, 'letter');
    expect(() => JSON.stringify(recipe)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(recipe)) as EditRecipe;
    expect(roundTripped).toEqual(recipe);
  });
});

describe('nextRotation / rotateRecipe (task 5.4.1 — cycle 0 -> 90 -> 180 -> 270 -> 0)', () => {
  it('cycles through all four steps and back to 0', () => {
    expect(nextRotation(0)).toBe(90);
    expect(nextRotation(90)).toBe(180);
    expect(nextRotation(180)).toBe(270);
    expect(nextRotation(270)).toBe(0);
  });

  it('rotateRecipe advances rotation without mutating the input recipe', () => {
    const corners = frameCorners(800, 1000);
    const recipe = createInitialRecipe(corners, 'a4');
    const rotated = rotateRecipe(recipe);

    expect(rotated.rotation).toBe(90);
    expect(recipe.rotation).toBe(0); // original untouched
    expect(rotated).not.toBe(recipe); // new object, not a mutation
    expect(rotated.corners).toBe(recipe.corners); // corners unchanged by rotation
  });

  it('four rotations return to the original rotation value', () => {
    const corners = frameCorners(800, 1000);
    let recipe = createInitialRecipe(corners, 'a4');
    for (let i = 0; i < 4; i += 1) {
      recipe = rotateRecipe(recipe);
    }
    expect(recipe.rotation).toBe(0);
  });
});

describe('flipHorizontalRecipe / flipVerticalRecipe (task 5.4.2)', () => {
  it('toggles flipH without touching other fields, without mutating input', () => {
    const corners = frameCorners(800, 1000);
    const recipe = createInitialRecipe(corners, 'a4');
    const flipped = flipHorizontalRecipe(recipe);

    expect(flipped.flipH).toBe(true);
    expect(flipped.flipV).toBe(false);
    expect(flipped.rotation).toBe(0);
    expect(recipe.flipH).toBe(false); // original untouched
    expect(flipped).not.toBe(recipe);
  });

  it('toggles flipH back to false on a second call', () => {
    const corners = frameCorners(800, 1000);
    const recipe = createInitialRecipe(corners, 'a4');
    const twice = flipHorizontalRecipe(flipHorizontalRecipe(recipe));
    expect(twice.flipH).toBe(false);
  });

  it('flipVerticalRecipe toggles flipV independently of flipH', () => {
    const corners = frameCorners(800, 1000);
    const recipe = createInitialRecipe(corners, 'a4');
    const flippedH = flipHorizontalRecipe(recipe);
    const flippedBoth = flipVerticalRecipe(flippedH);

    expect(flippedBoth.flipH).toBe(true);
    expect(flippedBoth.flipV).toBe(true);
  });
});

describe('non-destructive contract (task 5.4.3 — never mutates CapturedFrame.source)', () => {
  it('rotate/flip helpers only produce new recipe objects; there is no source/bitmap parameter for them to touch', () => {
    // This is a structural/contract test: rotateRecipe, flipHorizontalRecipe,
    // and flipVerticalRecipe all take ONLY an EditRecipe (JSON-only, per
    // design section 5.2) and return a new EditRecipe. There is no
    // ImageBitmap/CapturedFrame argument anywhere in their signatures for a
    // real implementation to accidentally reach into and mutate — the type
    // signature itself is the guarantee, verified here by asserting the
    // functions never receive or need frame/bitmap data to do their job.
    const corners = frameCorners(800, 1000);
    let recipe = createInitialRecipe(corners, 'a4');

    const originalCorners = recipe.corners;
    recipe = rotateRecipe(recipe);
    recipe = flipHorizontalRecipe(recipe);
    recipe = flipVerticalRecipe(recipe);

    // The corners reference itself is never reassigned by rotation/flip —
    // only rotation/flipH/flipV fields change.
    expect(recipe.corners).toBe(originalCorners);
  });
});

describe('recipeToCssTransform (ADR-005 — presentation-layer only, no re-warp)', () => {
  it('returns "none" for the identity recipe', () => {
    expect(recipeToCssTransform({ rotation: 0, flipH: false, flipV: false })).toBe('none');
  });

  it('includes rotate() for a non-zero rotation', () => {
    expect(recipeToCssTransform({ rotation: 90, flipH: false, flipV: false })).toBe('rotate(90deg)');
    expect(recipeToCssTransform({ rotation: 270, flipH: false, flipV: false })).toBe('rotate(270deg)');
  });

  it('includes scaleX(-1) for flipH and scaleY(-1) for flipV, before rotation', () => {
    expect(recipeToCssTransform({ rotation: 0, flipH: true, flipV: false })).toBe('scaleX(-1)');
    expect(recipeToCssTransform({ rotation: 0, flipH: false, flipV: true })).toBe('scaleY(-1)');
    expect(recipeToCssTransform({ rotation: 180, flipH: true, flipV: true })).toBe(
      'scaleX(-1) scaleY(-1) rotate(180deg)',
    );
  });
});

describe('magnifierSampleRect (task 5.1.2 — pure coordinate math for the loupe)', () => {
  it('centers the sample rect on the handle position when not near an edge', () => {
    const rect = magnifierSampleRect(500, 500, 120, 2.5, 1000, 1000);
    const sampleSize = 120 / 2.5;
    expect(rect.sWidth).toBeCloseTo(sampleSize, 5);
    expect(rect.sHeight).toBeCloseTo(sampleSize, 5);
    expect(rect.sx).toBeCloseTo(500 - sampleSize / 2, 5);
    expect(rect.sy).toBeCloseTo(500 - sampleSize / 2, 5);
  });

  it('clamps the sample rect to stay within the source bounds near the top-left corner', () => {
    const rect = magnifierSampleRect(0, 0, 120, 2.5, 1000, 1000);
    expect(rect.sx).toBe(0);
    expect(rect.sy).toBe(0);
  });

  it('clamps the sample rect to stay within the source bounds near the bottom-right corner', () => {
    const rect = magnifierSampleRect(1000, 1000, 120, 2.5, 1000, 1000);
    const sampleSize = 120 / 2.5;
    expect(rect.sx).toBeCloseTo(1000 - sampleSize, 5);
    expect(rect.sy).toBeCloseTo(1000 - sampleSize, 5);
  });

  it('never returns a sample rect larger than the source dimensions', () => {
    const rect = magnifierSampleRect(50, 50, 500, 1, 100, 100);
    expect(rect.sWidth).toBeLessThanOrEqual(100);
    expect(rect.sHeight).toBeLessThanOrEqual(100);
  });
});
