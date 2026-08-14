import { describe, expect, it } from 'vitest';
import { mapObjectCoverGuideToSourceQuad } from '@/features/scanner/lib/cameraGuideGeometry';

describe('mapObjectCoverGuideToSourceQuad', () => {
  it('maps a portrait CSS guide through negative object-cover offsets into the exact 1920 × 1080 source quad', () => {
    const quad = mapObjectCoverGuideToSourceQuad(
      { width: 1920, height: 1080 },
      { left: 0, top: 0, width: 390, height: 844 },
      { left: 40, top: 160, width: 310, height: 440 },
    );

    expect(quad).toEqual([
      { x: 761.6587677725119, y: 204.739336492891 },
      { x: 1158.341232227488, y: 204.739336492891 },
      { x: 1158.341232227488, y: 767.7725118483413 },
      { x: 761.6587677725119, y: 767.7725118483413 },
    ]);
  });

  it('clamps guides that extend beyond the displayed camera and rejects degenerate dimensions', () => {
    expect(
      mapObjectCoverGuideToSourceQuad(
        { width: 100, height: 50 },
        { left: 10, top: 20, width: 100, height: 100 },
        { left: -20, top: 10, width: 140, height: 80 },
      ),
    ).toEqual([
      { x: 25, y: 0 },
      { x: 75, y: 0 },
      { x: 75, y: 35 },
      { x: 25, y: 35 },
    ]);
    expect(
      mapObjectCoverGuideToSourceQuad(
        { width: 0, height: 50 },
        { left: 0, top: 0, width: 100, height: 100 },
        { left: 10, top: 10, width: 80, height: 80 },
      ),
    ).toBeNull();
  });
});
