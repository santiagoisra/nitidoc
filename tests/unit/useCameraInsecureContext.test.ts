import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCamera } from '@/features/scanner/hooks/useCamera';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

/**
 * Regression: the whole app rendered a BLANK SCREEN on any non-secure origin.
 *
 * `navigator.mediaDevices` is `undefined` outside a secure context — browsers
 * gate the entire Media Devices API behind HTTPS (plain `http://` on a LAN IP
 * does NOT qualify; only `localhost` is exempt). `useCamera`'s `devicechange`
 * effect dereferenced it unconditionally, so mounting the hook threw
 * `TypeError: Cannot read properties of undefined (reading 'addEventListener')`
 * during render. React unwound the whole tree and `#root` stayed empty — no UI
 * at all, no error message, nothing actionable for the user.
 *
 * Reproduced by serving the production build over `http://<lan-ip>:4173`: the
 * page painted the background colour and nothing else. This blocks testing the
 * app on real phones over a LAN, which is exactly how the mobile-only
 * detection bug has to be diagnosed.
 *
 * A camera-less environment is a legitimate degraded mode the app already
 * handles everywhere else (`ImportFallback` exists precisely for it), so
 * missing `mediaDevices` must degrade, never crash.
 */
describe('useCamera in a non-secure context (navigator.mediaDevices undefined)', () => {
  let originalMediaDevices: PropertyDescriptor | undefined;

  beforeEach(() => {
    useScannerStore.setState({ ...scannerStoreInitialState });
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    // Mirror what a browser does over plain http:// — the property is absent
    // entirely, not merely an object whose methods reject.
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'mediaDevices');
    }
  });

  it('mounts without throwing so the app still renders', () => {
    expect(() => renderHook(() => useCamera())).not.toThrow();
  });

  it('unmounts cleanly without throwing', () => {
    const { unmount } = renderHook(() => useCamera());
    expect(() => {
      unmount();
    }).not.toThrow();
  });
});
