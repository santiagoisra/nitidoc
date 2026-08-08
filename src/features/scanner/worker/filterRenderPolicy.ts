import type { FilterVariant } from './messages';

const ADAPTIVE_BLACK_AND_WHITE_PRESETS: ReadonlySet<FilterVariant['preset']> = new Set([
  'bw',
  'bw-high-contrast',
  'eco',
]);

/** Keeps adaptive B&W results binary by excluding them from unsharp convolution. */
export function shouldApplyUnsharpSharpening(variant: FilterVariant): boolean {
  return variant.sharpness > 0 && !ADAPTIVE_BLACK_AND_WHITE_PRESETS.has(variant.preset);
}
