import '@testing-library/jest-dom/vitest';

/**
 * happy-dom v20 exposes `window.localStorage` as a getter that defers to Node's
 * experimental Web Storage (`globalThis.localStorage`), which stays `undefined`
 * unless Node is launched with `--localstorage-file`. Under vitest that leaves
 * `window.localStorage === undefined`, crashing any test that touches it (the
 * i18n locale-persistence suite calls `window.localStorage.clear()`). Install a
 * minimal in-memory `Storage` so tests get real, isolated storage without a
 * Node flag — `LocaleProvider` itself already degrades gracefully when storage
 * throws, this only fixes the test environment.
 */
function createMemoryStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store = new Map();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number): string | null {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  } as Storage;
}

/**
 * `window` is absent in files that opt into `// @vitest-environment node`
 * (the OpenCV suites: the Emscripten build never finishes bootstrapping
 * under happy-dom, so they must run on plain Node). Those files need no DOM
 * storage at all — patch whichever globals actually exist.
 */
const storageTargets: Array<typeof globalThis> = [globalThis];
if (typeof window !== 'undefined') {
  storageTargets.push(window as unknown as typeof globalThis);
}

for (const target of new Set<typeof globalThis>(storageTargets)) {
  Object.defineProperty(target, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}
