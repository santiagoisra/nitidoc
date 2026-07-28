import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomId } from '@/shared/lib/randomId';

/**
 * Regression: importing an image threw
 * `TypeError: crypto.randomUUID is not a function` on any non-secure origin.
 *
 * `crypto.randomUUID` is gated behind a secure context, exactly like
 * `navigator.mediaDevices` (see `useCameraInsecureContext.test.ts`). Over
 * plain `http://` it is `undefined`, so every `crypto.randomUUID()` call site
 * — capture ids, page ids, toast ids — threw and took the flow down with it.
 *
 * `crypto.getRandomValues` is NOT gated, so the fallback stays
 * cryptographically sound rather than degrading to `Math.random()`.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId', () => {
  let originalCrypto: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  });

  afterEach(() => {
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    }
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when the platform provides it', () => {
    const spy = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    Object.defineProperty(globalThis, 'crypto', {
      value: { ...globalThis.crypto, randomUUID: spy },
      configurable: true,
      writable: true,
    });

    expect(randomId()).toBe('11111111-2222-4333-8444-555555555555');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('still returns a valid v4 UUID when crypto.randomUUID is missing (non-secure origin)', () => {
    const { getRandomValues } = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: getRandomValues.bind(globalThis.crypto) },
      configurable: true,
      writable: true,
    });

    const id = randomId();
    expect(id).toMatch(UUID_V4);
  });

  it('does not collide across many calls without crypto.randomUUID', () => {
    const { getRandomValues } = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: getRandomValues.bind(globalThis.crypto) },
      configurable: true,
      writable: true,
    });

    const ids = new Set(Array.from({ length: 1000 }, () => randomId()));
    expect(ids.size).toBe(1000);
  });

  it('still works when crypto itself is unavailable', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    expect(randomId()).toMatch(UUID_V4);
  });
});
