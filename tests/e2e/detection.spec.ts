import { expect, test } from '@playwright/test';

/**
 * Group 4 (Slice D) smoke test: verifies the live-detection WIRING doesn't
 * crash when the scanner opens against Chromium's fake camera stream.
 *
 * IMPORTANT — what this test explicitly does NOT and CANNOT verify:
 * Chromium's `--use-fake-device-for-media-stream` produces a synthetic
 * rolling-color test pattern, not a real document. OpenCV's contour
 * detection pipeline (Canny/findContours/approxPolyDP) will never find a
 * valid 4-sided document contour in that pattern, so `DetectResponse.corners`
 * will consistently be null in this environment. That is NOT a bug being
 * masked here — it is a fundamental limitation of testing a document-shaped
 * heuristic against a fake camera with no document in frame. Verifying that
 * OpenCV actually FINDS a document requires either a real document fed to
 * the import fallback (Slice F, task 7.2) or manual device QA.
 *
 * What this test DOES verify: the scanner screen mounts, the fake stream
 * attaches, the detection loop's worker (`workerClient.init()` ->
 * `opencv.worker.ts` -> lazy OpenCV.js load) starts without throwing an
 * unhandled error that would crash the page, and the quality-hints /
 * capture-button UI wired to the detection loop render without crashing
 * even while corners stay null the whole time.
 */
test('opening the scanner starts detection wiring without crashing', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await page.getByTestId('open-scanner').click();

  const video = page.getByTestId('camera-view-video');
  await expect(video).toBeVisible();
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);

  // The capture button and quality-hints region must render — they are
  // wired directly to DetectionSlice state that the (now-running) detection
  // loop writes to on every frame. quality-hints is checked with
  // toBeAttached() rather than toBeVisible(): with no active hint (the
  // common case against the fake camera's non-document pattern) the region
  // is an empty aria-live div with no intrinsic content, which some browser/
  // layout combinations report as zero-size and therefore "hidden" per
  // Playwright's visibility heuristic even though it is correctly mounted.
  await expect(page.getByTestId('capture-button')).toBeVisible();
  await expect(page.getByTestId('quality-hints')).toBeAttached();

  // Give the loop a few real frames' worth of time to run its first DETECT
  // round-trip through the worker (INIT -> OpenCV lazy load -> DETECT_RESULT)
  // against the fake stream, without asserting anything about the (always
  // null, per this test's docstring) detection result itself.
  await page.waitForTimeout(3000);

  // The overlay must still be present (not crashed/unmounted) even with
  // corners staying null the whole time — it should be faded out
  // (opacity-0), not absent from the DOM.
  await expect(page.getByTestId('detection-overlay')).toBeAttached();

  expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});

/**
 * Verifies the manual capture button is clickable and does not throw, even
 * though there is no valid detected contour to scale (rawCorners stays
 * null against the fake camera's synthetic pattern — see this file's
 * top docstring). This exercises `runCaptureSequence`'s null-corners branch
 * (`fullResCorners` stays null) end to end without crashing.
 */
test('manual capture button triggers the capture sequence without a detected contour', async ({ page }) => {
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
