import { expect, test } from '@playwright/test';

/**
 * Corner-editor wiring, verified through the CURRENT capture flow.
 *
 * These tests used to assert that tapping the capture button opened the corner
 * editor. Fase 2.3 (capture-ux-redesign.md) made capture deferred, and that
 * assumption died with it: a capture now accumulates a `RawCapture` and leaves
 * you on the camera. Detection and warping happen later, in a batch
 * `processing` step, which lands on `adjust`. The corner editor is reached from
 * the GRID — tapping a page's edit control activates it and opens the editor,
 * returning to the grid on cancel or confirm (`ScannerScreen.handleActivatePageTap`).
 *
 * The specs failed on that stale route rather than on a real regression, and
 * they failed unnoticed because CI does not run the E2E suite — the same way
 * `detection.spec.ts` outlived its own assertions until it was repaired.
 *
 * SCOPE — unchanged from before: this verifies WIRING, not detection quality.
 * Chromium's `--use-fake-device-for-media-stream` renders a synthetic pattern
 * with no document in it, so the batch detect finds no quad and every page
 * falls back to `frameCorners` (and is flagged `needsReview`). Whether OpenCV
 * finds a REAL document is covered by
 * `tests/unit/detectRealCameraCapture.test.ts`; extend that, not this file.
 */

// Headroom for the batch `processing` step, which cannot start until OpenCV
// has loaded its ~10MB bundle. On this machine that completes in seconds and
// the whole file runs well inside the default budget — but the init has
// historically been the slowest and least predictable part of the pipeline
// (see importFixture.spec.ts's account of it hanging outright), and a spec
// that fails on a cold cache teaches nothing about the code.
test.describe.configure({ timeout: 180_000 });

/** Drives capture -> processing -> adjust -> grid, leaving the page grid on screen. */
async function captureOnePageIntoTheGrid(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('open-scanner').click();

  const video = page.getByTestId('camera-view-video');
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);

  const captureButton = page.getByTestId('capture-button');
  await expect(captureButton).toBeEnabled();
  await captureButton.click();

  // Deferred capture: the shot lands in `rawCaptures` and the camera stays up.
  // The count tile appearing is the proof the capture actually landed.
  await expect(page.getByTestId('capture-count-thumbnail')).toBeVisible({ timeout: 15_000 });

  // "Next" is what leaves the camera and starts the batch detect -> warp.
  await page.getByTestId('capture-next').click();
  await expect(page.getByTestId('adjust-screen')).toBeVisible({ timeout: 120_000 });

  await page.getByTestId('adjust-next').click();
  await expect(page.getByTestId('page-grid')).toBeVisible();
}

test('a grid page opens the corner editor with 4 handles and Back/Next controls', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await captureOnePageIntoTheGrid(page);

  // Page ids are minted at runtime, so the edit control is matched by prefix.
  await page.locator('[data-testid^="page-grid-edit-"]').first().click();

  const editor = page.getByTestId('corner-editor');
  await expect(editor).toBeVisible({ timeout: 30_000 });

  for (let i = 0; i < 4; i += 1) {
    await expect(page.getByTestId(`corner-handle-${i}`)).toBeVisible();
  }

  // Step 'corners' of the two-step editor: Back/Next only — the aspect-ratio
  // selector and Confirm live in step 'adjust', reached via "Next".
  await expect(page.getByTestId('corner-editor-cancel')).toBeVisible();
  await expect(page.getByTestId('corner-editor-next')).toBeAttached();

  expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});

test('backing out of the corner editor returns to the page grid', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await captureOnePageIntoTheGrid(page);

  await page.locator('[data-testid^="page-grid-edit-"]').first().click();
  await expect(page.getByTestId('corner-editor')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('corner-editor-cancel').click();

  // Cancel returns to `editReturnPhase`, which the grid path sets to 'grid'
  // (the adjust screen's own crop chip is the one that returns to 'adjust').
  // The old assertion expected the camera viewfinder here — that was the
  // pre-Fase-2.3 route, where the editor was entered straight from capture.
  await expect(page.getByTestId('page-grid')).toBeVisible();
  await expect(page.getByTestId('corner-editor')).toBeHidden();

  expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});
