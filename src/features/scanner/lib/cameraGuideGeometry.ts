import type { Quad } from '@/shared/types/geometry';

export interface CssRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Converts the visible CSS guide rectangle into source-image pixels for a
 * camera preview rendered with `object-fit: cover`. The camera source stays
 * full-size; this function records the guide as the authoritative crop.
 */
export function mapObjectCoverGuideToSourceQuad(
  source: ImageDimensions,
  display: CssRect,
  guide: CssRect,
): Quad | null {
  if (![source.width, source.height, display.width, display.height, guide.width, guide.height].every(isPositiveFinite)) {
    return null;
  }

  const scale = Math.max(display.width / source.width, display.height / source.height);
  if (!isPositiveFinite(scale)) return null;

  const offsetX = (display.width - source.width * scale) / 2;
  const offsetY = (display.height - source.height * scale) / 2;
  const left = clamp(guide.left - display.left, 0, display.width);
  const top = clamp(guide.top - display.top, 0, display.height);
  const right = clamp(guide.left + guide.width - display.left, 0, display.width);
  const bottom = clamp(guide.top + guide.height - display.top, 0, display.height);
  if (right <= left || bottom <= top) return null;

  const toSource = (x: number, y: number) => ({
    x: clamp((x - offsetX) / scale, 0, source.width),
    y: clamp((y - offsetY) / scale, 0, source.height),
  });

  return [toSource(left, top), toSource(right, top), toSource(right, bottom), toSource(left, bottom)];
}
