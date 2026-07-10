import { expect, test, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'document.png');

/**
 * Task 7.2 — end-to-end smoke test with a REAL image fixture (proposal
 * section 7, acceptance criterion 9: "Playwright con fixture de imagen").
 *
 * ============================================================================
 * OPENCV LOAD PATH — history and current contract (read before changing this
 * test or drawing conclusions from it elsewhere):
 * ============================================================================
 *
 * PREVIOUS (broken) design: `opencv.worker.ts` was an ES-MODULE worker that
 * loaded OpenCV.js via a bundled dynamic `import('@techstark/opencv-js')`. That
 * `import()` never resolved inside the worker — the classic Emscripten UMD
 * build does not complete its bootstrap in an ES-module worker scope — so
 * `workerClient.init()` hung forever and the worker message loop stayed blocked
 * (no INIT_DONE, and later WARP messages got no reply at all). Root-caused with
 * direct instrumentation during the Slice F investigation.
 *
 * CURRENT design (fix/opencv-classic-worker): the worker is now a CLASSIC
 * worker that loads OpenCV via `self.importScripts('/opencv/opencv.js')` (the
 * canonical opencv.js-in-worker pattern). The asset is served from
 * `public/opencv/opencv.js` (copied from node_modules by
 * `scripts/copy-opencv.mjs` as a pre-* hook) and bundled into `dist/opencv/`.
 * With the WASM embedded inline, no `locateFile`/separate `.wasm` is needed.
 *
 * This test is written to be HONEST about both outcomes rather than hardcoding
 * either: it drives the real import -> decode -> editor -> warp pipeline with
 * zero tolerance for unhandled page errors, and then asserts the worker
 * ACTUALLY RESPONDS to the warp request — success (`warp-preview`) OR a clean
 * error (`warp-error`) — instead of hanging indefinitely as the old ES-module
 * worker did. It does NOT assert pixel-correctness of `warpPerspective` against
 * a real document; that, plus confirming the load path on ACTUAL target
 * browsers (not this CI-style headless Chromium), remains device QA work (see
 * design section 11's R1/R5/degraded-mode calibration items). If OpenCV fails
 * to load in this specific headless environment for an unrelated reason, the
 * warp path degrades to `warp-error` (a reply), which this test still accepts —
 * what it will NOT tolerate is the old silent infinite hang.
 *
 * How the import fallback is reached: via `--use-fake-ui-for-media-stream=deny`
 * (the SAME Chromium fake-UI flag `camera.spec.ts` already uses for its
 * permission-denied test — still Chromium's own flag, not a hand-rolled
 * mock), which deterministically rejects `getUserMedia` with
 * `NotAllowedError`. An approach relying on a genuinely camera-less browser
 * (task 6.2.1's real trigger) was tried and abandoned during this slice: this
 * machine has a real camera that the Playwright-managed browser/webServer
 * combination was able to see and grant in that specific context, making
 * that path environment-dependent and non-reproducible. The
 * `permission-denied` path is deterministic and renders the exact SAME
 * `ImportFallback` component feeding the exact SAME pipeline (ADR-006), so
 * it validates the identical contract without depending on this machine's
 * camera hardware.
 *
 * `tests/e2e/fixtures/document.png` (task 7.2.1) is a generated 800x1000
 * PNG: a light rectangle ("paper") with faint horizontal "text" bands on a
 * dark background — a real image fixture, not a 1x1 placeholder.
 */

test.describe('Phase 1 acceptance: import fallback -> detect -> edit -> warp (task 7.2)', () => {
  test('importing the document fixture reaches the corner editor and sends a warp request without unhandled errors', async () => {
    const browser = await chromium.launch({
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream=deny'],
    });
    try {
      const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
      const page = await context.newPage();

      const pageErrors: Error[] = [];
      page.on('pageerror', (error) => pageErrors.push(error));

      await page.goto('/');
      await page.getByTestId('open-scanner').click();

      // Confirms the permission-denied import fallback was actually reached.
      const fallback = page.getByTestId('import-fallback');
      await expect(fallback).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('permission-denied-instructions')).toBeVisible();

      // Task 6.3.3 negative-behavior contract, verified inline here: the
      // fallback's file input has neither `multiple` nor any drag&drop
      // wiring — checked directly on the DOM element this test is about to
      // drive, not just asserted in isolation elsewhere.
      const input = page.getByTestId('import-fallback-input');
      await expect(input).toHaveAttribute('type', 'file');
      const hasMultiple = await input.evaluate((el: HTMLInputElement) => el.multiple);
      expect(hasMultiple).toBe(false);

      // Task 6.3.1/6.3.2: select the fixture through the real file input.
      // This blocks (up to IMPORT_DETECT_TIMEOUT_MS = 15s, per the fix
      // documented in ScannerScreen.tsx) on an OpenCV init attempt that never
      // succeeds in this environment (see the file-level docstring), then
      // falls through to frame-completo corners — so the corner editor is
      // expected to take up to ~15s to open here, not instantly.
      await input.setInputFiles(FIXTURE_PATH);

      const editor = page.getByTestId('corner-editor');
      await expect(editor).toBeVisible({ timeout: 30_000 });

      const handlePositions: Array<{ left: string; top: string }> = [];
      for (let i = 0; i < 4; i += 1) {
        const handle = page.getByTestId(`corner-handle-${i}`);
        await expect(handle).toBeVisible();
        const style = await handle.evaluate((el) => ({ left: el.style.left, top: el.style.top }));
        handlePositions.push(style);
      }
      // eslint-disable-next-line no-console
      console.log(`[task 7.2] seeded corner-handle positions (percent): ${JSON.stringify(handlePositions)}`);
      // The seed is EITHER a real detected quad (if the one-shot DETECT ran on
      // this fixture) OR the frameCorners() full-frame fallback (5%/95% inset,
      // used when DETECT found nothing / OpenCV was not ready in time). Both
      // are valid — we only assert four positioned handles exist, not their
      // exact coordinates, so this stays honest whether or not detection fired.
      expect(handlePositions).toHaveLength(4);
      for (const pos of handlePositions) {
        expect(pos.left).toMatch(/%$/);
        expect(pos.top).toMatch(/%$/);
      }

      // Fase 2.1 two-step editor: the aspect-ratio selector now lives in step
      // 'adjust', reached via "Next" from step 'corners'. `.click()` auto-waits
      // for the button to become enabled, which happens once the initial
      // mount warp (task 5.2.x) resolves and sets `recipe`.
      await page.getByTestId('corner-editor-next').click();
      await expect(page.getByTestId('aspect-ratio-selector')).toBeVisible();

      // Clicking an aspect-ratio option triggers the SAME `runWarp` path a
      // real user's drag-release would, and puts the UI into the
      // `warp-loading` ("Processing…") state while the request is in flight.
      await page.getByTestId('aspect-ratio-unknown').click();

      // The worker MUST respond to the warp request — the whole point of the
      // classic-worker fix is that `init()` (and therefore the warp pipeline)
      // no longer hangs. We accept EITHER a successful de-skewed preview
      // (`warp-preview`) OR a clean error (`warp-error`); what we do NOT accept
      // is the old silent infinite hang, which this timeout-bounded wait would
      // surface as a failure. (`warp-loading` may flash by faster than a poll
      // can catch on a fast machine, so we wait on the terminal states, not the
      // transient loading state.)
      const warpPreview = page.getByTestId('warp-preview');
      const warpError = page.getByTestId('warp-error');
      await expect(warpPreview.or(warpError)).toBeVisible({ timeout: 30_000 });

      // If the warp succeeded, Confirm becomes enabled (recipe is set); if it
      // errored, Confirm stays disabled. Assert the invariant that matches
      // whichever terminal state was reached, so the test is correct either way.
      if (await warpPreview.isVisible()) {
        await expect(page.getByTestId('corner-editor-confirm')).toBeEnabled();
      } else {
        await expect(page.getByTestId('corner-editor-confirm')).toBeDisabled();
      }

      expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });
});
