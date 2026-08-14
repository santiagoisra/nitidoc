// @vitest-environment node
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { outputSize } from '@/features/scanner/lib/geometry';
import type { CvBindings } from '@/features/scanner/worker/cvBindings';
import type { Quad } from '@/shared/types/geometry';

let cv: CvBindings;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const loaded = require('@techstark/opencv-js') as { default?: unknown };
  const resolved = (loaded.default ?? loaded) as { Mat?: unknown; onRuntimeInitialized?: () => void };
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OpenCV.js failed to initialise within 60s')), 60_000);
    const ready = (): void => { clearTimeout(timeout); resolve(); };
    if (resolved.Mat) ready();
    else resolved.onRuntimeInitialized = ready;
  });
  cv = resolved as unknown as CvBindings;
}, 90_000);

describe('manual guide warp pixels', () => {
  it('warps only a selected guide quad, excluding distinct outside-frame pixels rather than squashing the full source', () => {
    const width = 100;
    const height = 100;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const inside = x >= 20 && x < 80 && y >= 20 && y < 80;
        pixels[index] = inside ? 0 : 255;
        pixels[index + 1] = inside ? 220 : 0;
        pixels[index + 2] = 0;
        pixels[index + 3] = 255;
      }
    }

    const guideQuad: Quad = [
      { x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 },
    ];
    const { outW, outH } = outputSize(guideQuad, { mode: 'measured' });
    const source = cv.matFromImageData({ width, height, data: pixels } as ImageData);
    const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, guideQuad.flatMap((point) => [point.x, point.y]));
    const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
    const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
    const warped = new cv.Mat();

    try {
      cv.warpPerspective(source, warped, transform, new cv.Size(outW, outH));
      const reds = Array.from(warped.data).filter((_value, index) => index % 4 === 0 && warped.data[index]! > 200);
      const greens = Array.from(warped.data).filter((_value, index) => index % 4 === 1 && warped.data[index]! > 180);
      expect({ outW, outH }).toEqual({ outW: 60, outH: 60 });
      expect(reds).toHaveLength(0);
      expect(greens.length).toBeGreaterThan(3_000);
    } finally {
      source.delete(); sourcePoints.delete(); destinationPoints.delete(); transform.delete(); warped.delete();
    }
  });
});
