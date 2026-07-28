/**
 * Secure-context-safe UUID v4 generator.
 *
 * `crypto.randomUUID` is only exposed in a SECURE CONTEXT — over plain
 * `http://` (a LAN IP, a device-testing origin, an intranet deploy) it is
 * `undefined`, and calling it threw `TypeError: crypto.randomUUID is not a
 * function`, taking down whatever flow needed an id (capture ids, page ids,
 * toast ids). Same class of failure as `navigator.mediaDevices` being absent
 * off-HTTPS.
 *
 * `crypto.getRandomValues` is NOT gated behind a secure context, so the
 * fallback stays cryptographically sound instead of degrading to
 * `Math.random()`. The last resort (no `crypto` at all) exists only so an
 * exotic environment degrades rather than crashes.
 */

function bytesToUuidV4(bytes: Uint8Array): string {
  // Per RFC 4122 §4.4: set the version (4) and variant (10xx) bits.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    hex.push((bytes[i] as number).toString(16).padStart(2, '0'));
  }
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-` +
    `${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

export function randomId(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (typeof c?.randomUUID === 'function') {
    return c.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToUuidV4(bytes);
}
