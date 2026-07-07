/**
 * Copies the prebuilt OpenCV.js UMD asset into `public/opencv/opencv.js` so
 * Vite serves it at `/opencv/opencv.js` (dev and in the production build, where
 * everything under `public/` is copied verbatim into `dist/`).
 *
 * WHY this exists: OpenCV.js is loaded inside a CLASSIC Web Worker via
 * `self.importScripts('/opencv/opencv.js')` (see `opencv.worker.ts`). A classic
 * worker cannot `import()` an ES module, and the `@techstark/opencv-js` build is
 * a classic Emscripten UMD bundle that never completes its bootstrap inside an
 * ES-module worker. Serving it as a plain static script sidesteps that entirely.
 *
 * The asset (~10MB, WASM embedded inline — no separate `.wasm`) is NOT committed:
 * `public/opencv/` is git-ignored. This script regenerates it and is wired as a
 * `predev` / `prebuild` / `pretest:e2e` hook, so the file is always present
 * before dev, build, or E2E runs. Idempotent: safe to run repeatedly.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');

const source = resolve(
  projectRoot,
  'node_modules',
  '@techstark',
  'opencv-js',
  'dist',
  'opencv.js',
);
const destDir = resolve(projectRoot, 'public', 'opencv');
const dest = resolve(destDir, 'opencv.js');

if (!existsSync(source)) {
  console.error(
    `[copy-opencv] Source asset not found at ${source}. ` +
      'Did `npm install` run? Expected @techstark/opencv-js in node_modules.',
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);

console.log(`[copy-opencv] Copied opencv.js -> ${dest}`);
