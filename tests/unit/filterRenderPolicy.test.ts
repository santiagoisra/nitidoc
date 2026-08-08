import { describe, expect, it } from 'vitest';
import { shouldApplyUnsharpSharpening } from '@/features/scanner/worker/filterRenderPolicy';
import type { FilterVariant } from '@/features/scanner/worker/messages';

function variant(preset: FilterVariant['preset'], sharpness: number): FilterVariant {
  return { preset, brightness: 0, contrast: 0, sharpness };
}

const POSITIVE_SHARPNESS_POLICY = {
  original: true,
  enhanced: true,
  grayscale: true,
  bw: false,
  'bw-high-contrast': false,
  eco: false,
} satisfies Record<FilterVariant['preset'], boolean>;

const ALL_PRESETS = Object.keys(POSITIVE_SHARPNESS_POLICY) as FilterVariant['preset'][];
const POSITIVE_SHARPNESS_POLICY_CASES = Object.entries(POSITIVE_SHARPNESS_POLICY) as [
  FilterVariant['preset'],
  boolean,
][];

describe('shouldApplyUnsharpSharpening', () => {
  it.each(ALL_PRESETS)('preset=%s never sharpens at zero sharpness', (preset) => {
    expect(shouldApplyUnsharpSharpening(variant(preset, 0))).toBe(false);
  });

  it.each(POSITIVE_SHARPNESS_POLICY_CASES)(
    'preset=%s applies the explicit positive-sharpness policy',
    (preset, expected) => {
      expect(shouldApplyUnsharpSharpening(variant(preset, 25))).toBe(expected);
    },
  );
});
