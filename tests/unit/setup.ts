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

for (const target of new Set<typeof globalThis>([globalThis, window as unknown as typeof globalThis])) {
  Object.defineProperty(target, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}
