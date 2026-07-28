// @vitest-environment node
/**
 * The detection pipeline against a REAL camera capture.
 *
 * ============================================================================
 * WHY THIS TEST EXISTS
 * ============================================================================
 * The scanner never auto-cropped anything a user photographed, and the whole
 * suite stayed green through two separate "fixes" because nothing ever
 * asserted that detection FINDS a document. `tests/e2e/detection.spec.ts`
 * says so explicitly in its own docstring — it verifies the DETECT wiring
 * against Chromium's fake camera and states that confirming OpenCV actually
 * finds a page "requires ... manual device QA". So the one behaviour that
 * mattered was the one behaviour nobody tested.
 *
 * `tests/e2e/fixtures/document.png` did not catch it either: it is a
 * synthetic light rectangle on a dark background whose Canny edges form a
 * perfectly CLOSED loop, so `contourArea` reports ~49% of the frame and the
 * pipeline passes. Real paper does not behave like that.
 *
 * ============================================================================
 * THE BUG THIS PINS DOWN
 * ============================================================================
 * `runDetectPipeline` ranks contours by `contourArea()` computed over a RAW
 * CANNY EDGE MAP. Canny yields 1px-wide OPEN polylines: a border traced
 * out-and-back encloses no area, so `contourArea` collapses to ~0 even
 * though the outline is plainly there. Only small CLOSED shapes — a glyph, a
 * logo — report real area, so the "largest-area contour" is always an
 * interior detail and never the page.
 *
 * Measured on this exact fixture (detection frame 640x1137):
 *
 *   paper outline : bbox 365x610 (30.6% of frame) -> contourArea    6.0 px²
 *   winner        : bbox 104x19  (a WORD)         -> contourArea  442.0 px²
 *
 *   0.061% < MIN_CONTOUR_AREA_RATIO (6%) -> rejected -> needsReview -> no crop
 *
 * ============================================================================
 * THE FIXTURE
 * ============================================================================
 * `fixtures/camera-capture-lorem.jpg` is the byte-for-byte blob the pipeline
 * consumed on a real iPhone (iOS 18.7 / Safari 26.6) via
 * `ImageCapture.grabFrame()`, pulled off the device and downscaled from
 * 2160x3840 to 720x1280 purely to keep the repository light — the failure
 * reproduces identically at 1080x1920, 810x1440, 720x1280 and 640x1137.
 *
 * It is deliberately an EASY case: a full sheet of Lorem Ipsum on a plain
 * light desk, evenly lit, no clutter, nothing cropped off. If detection
 * cannot handle this, it cannot handle anything a user will photograph. The
 * page is placeholder text, so the fixture carries no personal data.
 *
 * Sibling coverage: the same document IMPORTED from the photo library did
 * detect correctly, which is exactly how this bug hid for so long.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runDetectPipeline } from '@/features/scanner/worker/detectPipeline';
import { DETECTION } from '@/features/scanner/lib/detectionConstants';
import type { CvBindings } from '@/features/scanner/worker/cvBindings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'camera-capture-lorem.jpg');

let cv: CvBindings;

beforeAll(async () => {
  // `import('@techstark/opencv-js')` never settles under Vitest: Vite tries to
  // transform the 10MB Emscripten UMD bundle. `createRequire` loads the built
  // artifact the way Node does (~350ms). This also needs the `node`
  // environment declared at the top of this file — OpenCV.js does not finish
  // its bootstrap under happy-dom either.
  const require = createRequire(import.meta.url);
  const loaded = require('@techstark/opencv-js') as { default?: unknown };
  const resolved = (loaded.default ?? loaded) as {
    Mat?: unknown;
    onRuntimeInitialized?: () => void;
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('OpenCV.js failed to initialise within 60s'));
    }, 60_000);
    const settle = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const tick = (): void => {
      if (resolved.Mat) {
        settle();
        return;
      }
      setTimeout(tick, 50);
    };
    resolved.onRuntimeInitialized = settle;
    tick();
  });

  cv = resolved as unknown as CvBindings;
}, 90_000);

/**
 * Decodes the fixture and downscales it exactly as `useBatchProcess` does
 * before calling DETECT (`createImageBitmap` with
 * `resizeWidth: DETECTION.DOWNSCALE_WIDTH`), so the pipeline sees the same
 * pixels it sees in the app. Uses a box filter, matching the browser's
 * high-quality downscale closely enough for a contour-area assertion.
 */
function loadDetectionFrame(): ImageData {
  const require = createRequire(import.meta.url);
  const jpeg = require('jpeg-js') as {
    decode: (data: Buffer, opts?: { useTArray?: boolean }) => {
      width: number;
      height: number;
      data: Uint8Array;
    };
  };

  const raw = jpeg.decode(readFileSync(FIXTURE), { useTArray: true });
  const targetWidth = Math.min(DETECTION.DOWNSCALE_WIDTH, raw.width);
  const scale = targetWidth / raw.width;
  const targetHeight = Math.round(raw.height * scale);

  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const boxW = raw.width / targetWidth;
  const boxH = raw.height / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * boxH);
    const y1 = Math.min(raw.height, Math.max(y0 + 1, Math.floor((y + 1) * boxH)));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * boxW);
      const x1 = Math.min(raw.width, Math.max(x0 + 1, Math.floor((x + 1) * boxW)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * raw.width + sx) * 4;
          r += raw.data[i] as number;
          g += raw.data[i + 1] as number;
          b += raw.data[i + 2] as number;
          n += 1;
        }
      }
      const o = (y * targetWidth + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }

  return { data: out, width: targetWidth, height: targetHeight, colorSpace: 'srgb' } as ImageData;
}

describe('runDetectPipeline against a real camera capture', () => {
  it('finds the page', () => {
    const frame = loadDetectionFrame();
    const { corners } = runDetectPipeline(cv, frame, false);

    expect(
      corners,
      'Detection returned no quad for a plainly-visible sheet of paper. ' +
        'The page outline IS in the Canny edge map, but contourArea() of an ' +
        'open polyline collapses to ~0, so a word of body text outranks it.',
    ).not.toBeNull();
  });

  it('returns a quad covering most of the page rather than an interior detail', () => {
    const frame = loadDetectionFrame();
    const { corners } = runDetectPipeline(cv, frame, false);
    expect(corners).not.toBeNull();

    const quad = corners as NonNullable<typeof corners>;
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const coverage =
      ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) /
      (frame.width * frame.height);

    // The sheet spans ~30% of this frame by bounding box. Anything far below
    // that means the pipeline latched onto a glyph or a logo instead — the
    // precise failure this test exists to prevent — while a value near 1.0
    // would mean it returned the whole frame, which is the `frameCorners`
    // fallback wearing a detection costume.
    expect(coverage).toBeGreaterThan(0.15);
    expect(coverage).toBeLessThan(0.95);
  });
});

/**
 * Guards the upper area gate.
 *
 * Sourcing contours from closed regions (rather than an open edge map) makes
 * a NEW failure mode possible: a frame whose background thresholds into one
 * big blob yields a quad spanning nearly the entire image. That is not a
 * detection — it is `frameCorners` wearing a detection costume, and it is
 * worse than admitting defeat, because the page would be reported as
 * detected, skip the `needsReview` badge, and still crop nothing.
 *
 * Measured quad areas: genuine captures land at 33-52% of the frame,
 * background-blob frames at 92-94%. `MAX_CONTOUR_AREA_RATIO` sits between.
 */
describe('runDetectPipeline area gates', () => {
  /** A light rectangle inset by `inset` px on every side of a dark frame. */
  function syntheticPage(width: number, height: number, inset: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const inside = x >= inset && x < width - inset && y >= inset && y < height - inset;
        const v = inside ? 240 : 20;
        const i = (y * width + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return { data, width, height, colorSpace: 'srgb' } as ImageData;
  }

  it('detects a page that occupies a plausible share of the frame', () => {
    const { corners } = runDetectPipeline(cv, syntheticPage(640, 800, 90), false);
    expect(corners).not.toBeNull();
  });

  it('rejects a quad spanning essentially the whole frame', () => {
    // 4px inset => ~98% of the frame, above MAX_CONTOUR_AREA_RATIO.
    const { corners } = runDetectPipeline(cv, syntheticPage(640, 800, 4), false);
    expect(
      corners,
      'A near-full-frame quad must fall through to the frameCorners fallback ' +
        'so the page keeps its needsReview badge instead of silently ' +
        'reporting a detection that crops nothing.',
    ).toBeNull();
  });
});
