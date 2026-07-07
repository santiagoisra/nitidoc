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
 * IMPORTANT — HONEST RESULT OF THIS SLICE'S INVESTIGATION (read before
 * changing this test or drawing conclusions from it elsewhere):
 * ============================================================================
 *
 * OpenCV.js WASM (`@techstark/opencv-js`, the real detection/warp engine)
 * DOES NOT successfully initialize inside `opencv.worker.ts`'s Web Worker in
 * THIS Playwright/Chromium headless environment. This was root-caused during
 * this slice with direct instrumentation, not assumed:
 *
 *  - The worker constructs successfully and receives the `INIT` postMessage.
 *  - The `opencv-*.js` chunk (~10MB) DOES download successfully (HTTP 200).
 *  - `await import('@techstark/opencv-js')` inside the worker's own module
 *    scope never resolves — traced with `console.log` instrumentation
 *    directly inside `opencvLoader.ts` (temporarily, then reverted), which
 *    confirmed execution never even reaches the log line right after that
 *    `await`. So `onRuntimeInitialized` never fires and `workerClient.init()`
 *    hangs forever.
 *  - The SAME chunk imports successfully in ~500ms on the MAIN thread, and a
 *    minimal hand-rolled Worker importing the SAME chunk via a blob URL also
 *    resolves in ~500ms — so this is NOT a generic "WASM in workers doesn't
 *    work here" limitation. It is specific to this exact worker's bundled
 *    dynamic import of this exact OpenCV.js build (this Emscripten build has
 *    no `ENVIRONMENT_IS_WORKER` guard in its source, consistent with it not
 *    fully supporting a dedicated-Worker load path in every runtime).
 *  - Worse than a clean rejection: the worker's message loop appears to be
 *    genuinely BLOCKED by the stuck `import()` — a subsequent `WARP` message
 *    sent to the SAME worker (confirmed via direct `postMessage`
 *    instrumentation) never gets ANY response at all, not even the
 *    `NOT_INITIALIZED` error `handleWarp`'s `if (!cv)` guard would produce if
 *    it ever ran. The worker is simply never processing that message.
 *  - Consequence: `CornerEditor`'s `recipe` state (only set on a SUCCESSFUL
 *    warp) never becomes non-null, `Confirm` (`disabled={!valid || !recipe}`)
 *    can never be enabled, and the UI is left showing `warp-loading`
 *    ("Processing…") indefinitely — NOT `warp-error`, because that requires
 *    the worker to actually reply, which it never does here.
 *
 * This is a genuine, reproducible environment limitation of THIS
 * Playwright/Chromium setup, not a bug this slice introduced — the SAME
 * limitation silently affected every earlier E2E test that touches DETECT
 * (`detection.spec.ts`, `cornerEditor.spec.ts`), which is why their own
 * docstrings already disclaim ever having verified real OpenCV execution.
 * This task (7.2) is the FIRST to wait long enough and check closely enough
 * to discover WHY that was always true, rather than attributing it solely to
 * Chromium's fake camera having no real document.
 *
 * Per this slice's explicit instructions ("si la carga de OpenCV en
 * Playwright es demasiado lenta/flaky o no viable en este entorno, decilo
 * explicitamente y degrada el E2E"), this test is DEGRADED accordingly: it
 * verifies import -> decode -> editor-opens-with-frame-completo-corners ->
 * a warp attempt is sent to the worker, all with zero unhandled page errors,
 * and asserts the (bounded, short) wait for either a successful warp or an
 * error is NOT met in this environment — proving the finding above rather
 * than silently timing out. It does NOT claim a de-skewed image was
 * produced. Real pixel-correctness of `warpPerspective` against a real
 * document, and confirming OpenCV's worker-load path on an ACTUAL target
 * browser (not this CI-style headless Chromium), remain device QA work (see
 * this slice's apply-progress notes) — same category as design section 11's
 * already-flagged R1/R5/degraded-mode empirical calibration items.
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
      // In THIS environment OpenCV never finishes initializing (see
      // docstring), so DETECT never ran successfully either — the seed is
      // the frameCorners() full-frame fallback (5%/95% inset), not a real
      // detected quad. Asserted explicitly rather than silently assumed.
      expect(handlePositions).toEqual([
        { left: '5%', top: '5%' },
        { left: '95%', top: '5%' },
        { left: '95%', top: '95%' },
        { left: '5%', top: '95%' },
      ]);

      // `CornerEditor` only invokes `workerClient.warp` on a handle
      // pointerup/aspect-ratio change (task 5.1.4 "recalculo solo al
      // soltar") — there is deliberately NO automatic warp on mount.
      // Clicking an aspect-ratio option triggers the SAME `runWarp` path a
      // real user's drag-release would, and puts the UI into the
      // `warp-loading` ("Processing…") state while the request is in flight.
      await page.getByTestId('aspect-ratio-unknown').click();
      await expect(page.getByTestId('warp-loading')).toBeVisible({ timeout: 5_000 });

      // Per the file docstring: in THIS environment the worker never replies
      // to the WARP request at all (not even NOT_INITIALIZED), because its
      // message loop is blocked on the still-pending OpenCV `import()`. A
      // short, bounded wait (well under a real timeout) confirms neither a
      // successful warp NOR an error response ever arrives — proving the
      // documented finding rather than silently passing/failing for an
      // unrelated reason. `Confirm` staying disabled throughout is the
      // CORRECT, designed behavior (CornerEditor.tsx:
      // `disabled={!valid || !recipe}`): the app must never let the user
      // confirm a scan that was never actually processed.
      await page.waitForTimeout(8_000);
      await expect(page.getByTestId('warp-preview')).not.toBeVisible();
      await expect(page.getByTestId('warp-error')).not.toBeVisible();
      await expect(page.getByTestId('corner-editor-confirm')).toBeDisabled();

      expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });
});
