import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    // PWA / service worker (installability + offline shell).
    //
    // The service worker is what makes the app installable via a custom button
    // on Android/Chromium: Chrome only fires `beforeinstallprompt` when a SW
    // with a fetch handler is present. Workbox (generateSW) provides that.
    //
    // OpenCV.js (~10MB, served at /opencv/opencv.js and loaded with
    // `importScripts` inside the classic worker) is deliberately kept OUT of the
    // precache — precaching 10MB on install would be hostile — and instead
    // cached at runtime with CacheFirst, so the second scanner entry is instant
    // and works offline (the "Fase 4" plan) without bloating SW installation.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Reuse the existing public/manifest.webmanifest (already linked in
      // index.html) instead of generating a second one.
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Never precache the OpenCV UMD bundle — it is runtime-cached below.
        globIgnores: ['**/opencv/**'],
        maximumFileSizeToCacheInBytes: 3_145_728,
        runtimeCaching: [
          {
            urlPattern: /\/opencv\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opencv-wasm',
              expiration: { maxEntries: 3, maxAgeSeconds: 7_776_000 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // No SW in dev — avoids stale-cache/HMR headaches. Ships in build/preview.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    // opencv.worker.ts is a CLASSIC worker: it loads OpenCV.js via
    // `self.importScripts('/opencv/opencv.js')` (a static asset served from
    // `public/`), NOT via a bundled dynamic `import()`. The classic
    // `@techstark/opencv-js` Emscripten build never completes its bootstrap
    // inside an ES-module worker, so we no longer need `format: 'es'` /
    // code-splitting for the worker. `iife` bundles the worker's own TS
    // imports (messages, geometry, cvBindings…) into one classic script in
    // which `importScripts` is available.
    format: 'iife',
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
