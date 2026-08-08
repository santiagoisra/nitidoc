import { describe, expect, it, vi } from 'vitest';
import { convertSingleChannelToRgba } from '@/features/scanner/worker/convertSingleChannelToRgba';
import type { CvBindings, CvMat } from '@/features/scanner/worker/cvBindings';

function createMat(options: { readonly isDeleted?: () => boolean; readonly delete?: () => void } = {}): CvMat & {
  readonly deleteSpy: ReturnType<typeof vi.fn>;
} {
  const deleteSpy = vi.fn(options.delete);
  return {
    rows: 1,
    cols: 1,
    data: new Uint8Array(4),
    data32F: new Float32Array(),
    data32S: new Int32Array(),
    data64F: new Float64Array(),
    delete: deleteSpy,
    isDeleted: options.isDeleted ?? (() => deleteSpy.mock.calls.length > 0),
    deleteSpy,
  };
}

describe('convertSingleChannelToRgba', () => {
  it('transfers the allocated RGBA Mat to the caller after a successful conversion', () => {
    const source = createMat();
    const destination = createMat();
    const cv = {
      Mat: vi.fn(() => destination),
      cvtColor: vi.fn(),
      COLOR_GRAY2RGBA: 42,
    } as unknown as CvBindings;

    const result = convertSingleChannelToRgba(cv, source);

    expect(result).toBe(destination);
    expect(cv.cvtColor).toHaveBeenCalledWith(source, destination, 42);
    expect(destination.deleteSpy).not.toHaveBeenCalled();
    expect(source.deleteSpy).not.toHaveBeenCalled();
  });

  it('propagates a Mat-constructor failure without touching the caller-owned source', () => {
    const source = createMat();
    const constructorFailure = new Error('OpenCV Mat allocation failed');
    const cvtColor = vi.fn();
    const cv = {
      Mat: vi.fn(() => {
        throw constructorFailure;
      }),
      cvtColor,
      COLOR_GRAY2RGBA: 42,
    } as unknown as CvBindings;

    let caught: unknown;
    try {
      convertSingleChannelToRgba(cv, source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(constructorFailure);
    expect(cvtColor).not.toHaveBeenCalled();
    expect(source.deleteSpy).not.toHaveBeenCalled();
  });

  it('deletes its allocated destination and preserves the conversion error identity when conversion throws', () => {
    const source = createMat();
    const destination = createMat();
    const conversionFailure = new Error('OpenCV conversion failed');
    const cv = {
      Mat: vi.fn(() => destination),
      cvtColor: vi.fn(() => {
        throw conversionFailure;
      }),
      COLOR_GRAY2RGBA: 42,
    } as unknown as CvBindings;

    let caught: unknown;
    try {
      convertSingleChannelToRgba(cv, source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(conversionFailure);
    expect(destination.deleteSpy).toHaveBeenCalledTimes(1);
    expect(source.deleteSpy).not.toHaveBeenCalled();
  });

  it('preserves the conversion error identity when destination deletion throws during cleanup', () => {
    const source = createMat();
    const conversionFailure = new Error('OpenCV conversion failed');
    const cleanupFailure = new Error('OpenCV delete failed');
    const destination = createMat({
      delete: () => {
        throw cleanupFailure;
      },
    });
    const cv = {
      Mat: vi.fn(() => destination),
      cvtColor: vi.fn(() => {
        throw conversionFailure;
      }),
      COLOR_GRAY2RGBA: 42,
    } as unknown as CvBindings;

    let caught: unknown;
    try {
      convertSingleChannelToRgba(cv, source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(conversionFailure);
    expect(destination.deleteSpy).toHaveBeenCalledTimes(1);
    expect(source.deleteSpy).not.toHaveBeenCalled();
  });

  it('preserves the conversion error identity when destination deletion-state inspection throws', () => {
    const source = createMat();
    const conversionFailure = new Error('OpenCV conversion failed');
    const cleanupFailure = new Error('OpenCV isDeleted failed');
    const destination = createMat({
      isDeleted: () => {
        throw cleanupFailure;
      },
    });
    const cv = {
      Mat: vi.fn(() => destination),
      cvtColor: vi.fn(() => {
        throw conversionFailure;
      }),
      COLOR_GRAY2RGBA: 42,
    } as unknown as CvBindings;

    let caught: unknown;
    try {
      convertSingleChannelToRgba(cv, source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(conversionFailure);
    expect(destination.deleteSpy).not.toHaveBeenCalled();
    expect(source.deleteSpy).not.toHaveBeenCalled();
  });

  it('does not delete an already-deleted destination and preserves the conversion error identity', () => {
    const source = createMat();
    const destination = createMat({ isDeleted: () => true });
    const conversionFailure = new Error('OpenCV conversion failed');
    const cv = {
      Mat: vi.fn(() => destination),
      cvtColor: vi.fn(() => {
        throw conversionFailure;
      }),
      COLOR_GRAY2RGBA: 42,
    } as unknown as CvBindings;

    let caught: unknown;
    try {
      convertSingleChannelToRgba(cv, source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(conversionFailure);
    expect(destination.deleteSpy).not.toHaveBeenCalled();
    expect(source.deleteSpy).not.toHaveBeenCalled();
  });
});
