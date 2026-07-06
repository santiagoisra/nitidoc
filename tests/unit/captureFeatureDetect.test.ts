import { describe, expect, it } from 'vitest';
import {
  detectImageCaptureSupport,
  detectOffscreenCanvasSupport,
} from '@/features/scanner/lib/captureFeatureDetect';

/**
 * These tests exercise the detection LOGIC with plain mock scopes (task
 * 3.4.1) — they do NOT attempt to assert real browser support, which
 * differs across engines and is explicitly out of reach for a jsdom/happy-dom
 * unit test (see apply-progress: deferred to device QA).
 */
describe('detectImageCaptureSupport (task 3.4.1)', () => {
  it('returns true when ImageCapture is defined on the scope', () => {
    const mockScope = { ImageCapture: function ImageCapture() {} } as unknown as typeof globalThis;
    expect(detectImageCaptureSupport(mockScope)).toBe(true);
  });

  it('returns false when ImageCapture is undefined on the scope', () => {
    const mockScope = {} as unknown as typeof globalThis;
    expect(detectImageCaptureSupport(mockScope)).toBe(false);
  });
});

describe('detectOffscreenCanvasSupport (task 3.4.1)', () => {
  it('returns true when OffscreenCanvas is defined on the scope', () => {
    const mockScope = { OffscreenCanvas: function OffscreenCanvas() {} } as unknown as typeof globalThis;
    expect(detectOffscreenCanvasSupport(mockScope)).toBe(true);
  });

  it('returns false when OffscreenCanvas is undefined on the scope', () => {
    const mockScope = {} as unknown as typeof globalThis;
    expect(detectOffscreenCanvasSupport(mockScope)).toBe(false);
  });
});
