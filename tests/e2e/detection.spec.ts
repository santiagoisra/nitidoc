import { expect, test } from '@playwright/test';

/**
 * Smoke test: opening the scanner against Chromium's fake camera stream
 * must not crash the page.
 *
 * SCOPE — this file verifies WIRING, not detection quality. Chromium's
 * `--use-fake-device-for-media-stream` produces a synthetic rolling-colour
 * pattern, not a document, so no detection heuristic can find a page in it.
 *
 * That used to be the end of the story: this docstring claimed that
 * confirming OpenCV actually FINDS a document "requires manual device QA",
 * and no automated test ever checked it. That gap is exactly how a pipeline
 * which never detected a real document stayed green through two attempted
 * fixes — it ranked contours by `contourArea` over a raw Canny edge map,
 * whose open polylines enclose no area, so a word of body text outranked
 * the page itself.
 *
 * Detection BEHAVIOUR is now covered by
 * `tests/unit/detectRealCameraCapture.test.ts`, which drives the production
 * `runDetectPipeline` against a real camera capture using a real OpenCV
 * build. Extend that suite — not this file — when changing detection.
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 6) removed the live-detection loop
 * entirely; capture is manual-only and per-page detection runs in the
 * deferred batch step. This test's original assertions on `detection-overlay`
 * and `quality-hints` outlived the UI they targeted and would fail today —
 * unnoticed, because CI does not run the e2e suite. They are gone; what
 * remains is what still exists.
 */
test('opening the scanner attaches the camera without crashing', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await page.getByTestId('open-scanner').click();

  const video = page.getByTestId('camera-view-video');
  await expect(video).toBeVisible();
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);

  // Capture is manual-only since Unit 6, so the capture button is the whole
  // interactive surface this screen still exposes.
  await expect(page.getByTestId('capture-button')).toBeVisible();

  // Let the worker finish its INIT round-trip (lazy OpenCV.js load) so a
  // failure in that path surfaces as a page error rather than passing
  // silently because the test ended first.
  await page.waitForTimeout(3000);

  expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});

/**
 * Verifies the capture button drives a full capture without throwing.
 *
 * Capture is manual-only (Unit 6), so this is the real entry point into
 * `captureFullResFrame` -> `RawCapture`: nothing here depends on a detected
 * contour, since detection happens later, in the deferred batch step.
 */
test('the capture button runs a capture without crashing', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await page.getByTestId('open-scanner').click();

  const video = page.getByTestId('camera-view-video');
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);

  const captureButton = page.getByTestId('capture-button');
  await expect(captureButton).toBeEnabled();
  await captureButton.click();

  // Give the capture sequence (pause loop -> captureFullResFrame -> store
  // update) time to run.
  await page.waitForTimeout(1000);

  expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});
