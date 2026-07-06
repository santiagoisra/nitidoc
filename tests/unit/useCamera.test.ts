import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCamera } from '@/features/scanner/hooks/useCamera';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

/**
 * Lifecycle regression tests for useCamera (Slice C adversarial review
 * fixes C1 / C2 / H1).
 *
 * These control exactly when `getUserMedia` resolves via a manually
 * resolved/rejected promise queue, so we can simulate:
 *  - C1: unmount happening BEFORE a pending getUserMedia resolves.
 *  - C2/H1: two overlapping opens (StrictMode double-invoke / fast device
 *    switch) where the first must lose and be stopped, and only the last
 *    survives.
 *
 * A fake MediaStream is used — tracks expose `stop: vi.fn()` plus the
 * minimal `getSettings`/`getCapabilities` surface `useCamera` reads. This is
 * NOT a hand-rolled mock of a whole browser API surface; it is the smallest
 * fake needed to observe cleanup calls, consistent with how
 * captureFeatureDetect.test.ts fakes `globalThis`.
 */

interface FakeTrack {
  readonly stop: ReturnType<typeof vi.fn>;
  readonly getSettings: ReturnType<typeof vi.fn>;
  readonly getCapabilities: ReturnType<typeof vi.fn>;
  readonly readyState: 'live' | 'ended';
}

function createFakeTrack(deviceId: string): FakeTrack {
  return {
    stop: vi.fn(),
    getSettings: vi.fn(() => ({ deviceId, width: 1920, height: 1080 })),
    getCapabilities: vi.fn(() => ({})),
    readyState: 'live',
  };
}

function createFakeStream(deviceId: string): MediaStream {
  const track = createFakeTrack(deviceId);
  return {
    getVideoTracks: () => [track as unknown as MediaStreamTrack],
    getTracks: () => [track as unknown as MediaStreamTrack],
  } as unknown as MediaStream;
}

/** A getUserMedia call we can resolve/reject on demand from the test body. */
interface PendingCall {
  resolve: (stream: MediaStream) => void;
  reject: (error: unknown) => void;
}

/** Non-null accessor so strict TS doesn't force optional-chaining noise at every call site. */
function getPendingCall(calls: readonly PendingCall[], index: number): PendingCall {
  const call = calls[index];
  if (!call) {
    throw new Error(`Expected a pending getUserMedia call at index ${index}`);
  }
  return call;
}

describe('useCamera lifecycle (C1 / C2 / H1)', () => {
  let pendingCalls: PendingCall[];
  let getUserMediaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pendingCalls = [];
    getUserMediaMock = vi.fn(
      () =>
        new Promise<MediaStream>((resolve, reject) => {
          pendingCalls.push({ resolve, reject });
        }),
    );

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: getUserMediaMock,
        enumerateDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('C1: stops the stream if getUserMedia resolves after unmount', async () => {
    const { result, unmount } = renderHook(() => useCamera());

    let openPromise: Promise<void>;
    act(() => {
      openPromise = result.current.openCamera();
    });

    expect(pendingCalls).toHaveLength(1);

    // Unmount BEFORE getUserMedia resolves — this is the exact race C1
    // describes: cleanup runs first, then the stale promise settles.
    unmount();

    const orphanStream = createFakeStream('device-orphan');
    const orphanTrack = orphanStream.getVideoTracks()[0] as unknown as FakeTrack;

    await act(async () => {
      getPendingCall(pendingCalls, 0).resolve(orphanStream);
      await openPromise;
    });

    expect(orphanTrack.stop).toHaveBeenCalledTimes(1);
    // Store must not have been updated with a stream nobody owns anymore.
    expect(useScannerStore.getState().stream).toBeNull();
  });

  it('C2/H1: two concurrent opens — the first (loser) stream is stopped, only the last wins', async () => {
    const { result, unmount } = renderHook(() => useCamera());

    let firstOpen!: Promise<void>;
    let secondOpen!: Promise<void>;

    act(() => {
      firstOpen = result.current.openCamera('device-a');
    });
    act(() => {
      secondOpen = result.current.openCamera('device-b');
    });

    // Both calls issued their own getUserMedia before either resolved.
    expect(pendingCalls).toHaveLength(2);

    const firstStream = createFakeStream('device-a');
    const secondStream = createFakeStream('device-b');
    const firstTrack = firstStream.getVideoTracks()[0] as unknown as FakeTrack;
    const secondTrack = secondStream.getVideoTracks()[0] as unknown as FakeTrack;

    // Resolve the FIRST (older) call last, and the SECOND (newer) call
    // first, to prove the guard is based on generation order, not
    // resolution order.
    await act(async () => {
      getPendingCall(pendingCalls, 1).resolve(secondStream);
      await secondOpen;
    });

    expect(useScannerStore.getState().stream).toBe(secondStream);
    expect(secondTrack.stop).not.toHaveBeenCalled();

    await act(async () => {
      getPendingCall(pendingCalls, 0).resolve(firstStream);
      await firstOpen;
    });

    // The stale (first) call's stream must be stopped and must NOT have
    // clobbered the winning stream in the store.
    expect(firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().stream).toBe(secondStream);

    unmount();
  });

  it('M1: a non-permission/non-notfound getUserMedia rejection sets lastCameraError instead of throwing unhandled', async () => {
    const { result, unmount } = renderHook(() => useCamera());

    let openPromise: Promise<void>;
    act(() => {
      openPromise = result.current.openCamera();
    });

    const notReadableError = new DOMException('Could not start video source', 'NotReadableError');

    await act(async () => {
      getPendingCall(pendingCalls, 0).reject(notReadableError);
      // Must resolve (not reject) — this assertion alone proves openCamera
      // no longer rethrows for this error class.
      await expect(openPromise).resolves.toBeUndefined();
    });

    await waitFor(() => {
      expect(useScannerStore.getState().lastCameraError).toBe('Could not start video source');
    });

    unmount();
  });
});
