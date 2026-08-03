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
 * either: it drives the real import -> batch-process pipeline with zero
 * tolerance for unhandled page errors, and asserts the pipeline ACTUALLY
 * TERMINATES — the batch either warps the page or degrades to the
 * frame-corners fallback, and both land on the adjust screen. What it will NOT
 * tolerate is the old silent infinite hang, which the timeout-bounded wait
 * surfaces as a failure. It does NOT assert pixel-correctness of
 * `warpPerspective` against a real document; that, plus confirming the load
 * path on ACTUAL target browsers (not this CI-style headless Chromium), remains
 * device QA work (see design section 11's R1/R5/degraded-mode calibration
 * items).
 *
 * ============================================================================
 * FLOW — updated for Fase 2.3 (capture-ux-redesign.md):
 * ============================================================================
 *
 * This test used to assert that selecting the fixture landed directly on
 * `corner-editor`. That route no longer exists: importing adds a `RawCapture`
 * and leaves you on the no-camera screen, where "Next" starts the deferred
 * batch `processing` step (detect -> warp -> thumbnail), which lands on
 * `adjust`. The corner editor is now reached deliberately, from the adjust
 * screen's crop chip or from a grid page — see `cornerEditor.spec.ts`.
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

test.describe('Phase 1 acceptance: import fallback -> batch process -> adjust (task 7.2)', () => {
  // Headroom, not an expectation: the batch step cannot start until OpenCV has
  // loaded, which currently completes in seconds here. The generous budget
  // exists because this is the exact path that once hung forever, and a bound
  // far above the normal case still catches a regression to that behavior
  // while never failing on a merely slow machine.
  test.describe.configure({ timeout: 180_000 });

  test('importing the document fixture runs the batch pipeline through to the adjust screen without unhandled errors', async () => {
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
      // Deferred capture (Fase 2.3): this decodes and materializes a
      // `RawCapture` and STAYS on the no-camera screen — it does not process
      // anything yet.
      await input.setInputFiles(FIXTURE_PATH);

      // The thumbnail strip appearing is the proof the import produced a real
      // raw capture rather than failing quietly.
      await expect(page.getByTestId('capture-no-camera-thumbs')).toBeVisible({ timeout: 30_000 });

      // "Next" starts the batch detect -> warp -> thumbnail step. THIS is the
      // OpenCV round-trip the whole file is about.
      await page.getByTestId('capture-next').click();

      // The pipeline MUST terminate. It reaches `adjust` whether the warp
      // succeeded or detection degraded to `frameCorners` — both are valid
      // outcomes here, and the fixture is not a real photographed document.
      // What is NOT acceptable is never arriving, which is exactly the old
      // ES-module-worker hang this bounded wait exists to catch.
      await expect(page.getByTestId('adjust-screen')).toBeVisible({ timeout: 120_000 });

      // A page actually exists downstream: the adjust screen advances into a
      // grid holding at least one page, so the batch produced a `DocumentPage`
      // and not just a screen transition.
      await page.getByTestId('adjust-next').click();
      await expect(page.getByTestId('page-grid')).toBeVisible();
      await expect(page.locator('[data-testid^="page-grid-item-"]')).toHaveCount(1);

      expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });
});
