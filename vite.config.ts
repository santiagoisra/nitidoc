import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
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
