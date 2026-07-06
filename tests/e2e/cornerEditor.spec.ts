import { expect, test } from '@playwright/test';

/**
 * Group 5 (Slice E) smoke test: verifies the corner editor WIRING reaches
 * the 'editing-corners' phase and renders correctly against Chromium's fake
 * camera stream.
 *
 * IMPORTANT — what this test explicitly does NOT and CANNOT verify: as in
 * `detection.spec.ts`, Chromium's fake device produces a synthetic pattern
 * with no real document, so `rawCorners` stays null and the editor always
 * falls back to `frameCorners` (distributed across the full frame) rather
 * than pre-seeded detected corners. The actual OpenCV `warpPerspective`
 * output is also NOT verified pixel-by-pixel here — that requires a real
 * document fixture (Slice F, task 7.2) or manual device QA. What this test
 * DOES verify: the manual capture button transitions the screen into the
 * corner editor, 4 draggable handles render, the aspect-ratio selector and
 * Confirm/Back controls render, and the wiring survives without an
 * unhandled page error.
 */
test('manual capture opens the corner editor with 4 handles and a confirm button', async ({ page }) => {
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

  const editor = page.getByTestId('corner-editor');
  await expect(editor).toBeVisible({ timeout: 10_000 });

  for (let i = 0; i < 4; i += 1) {
    await expect(page.getByTestId(`corner-handle-${i}`)).toBeVisible();
  }

  await expect(page.getByTestId('aspect-ratio-selector')).toBeVisible();
  await expect(page.getByTestId('corner-editor-cancel')).toBeVisible();
  await expect(page.getByTestId('corner-editor-confirm')).toBeAttached();

  expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});

/**
 * Verifies backing out of the editor resumes the live-detection loop (Slice
 * E scope: "reanudar el loop de deteccion si el usuario vuelve atras") by
 * checking the screen returns to the camera viewfinder.
 */
test('backing out of the corner editor resumes the camera viewfinder', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await page.getByTestId('open-scanner').click();

  const video = page.getByTestId('camera-view-video');
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);

  await page.getByTestId('capture-button').click();
  await expect(page.getByTestId('corner-editor')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('corner-editor-cancel').click();

  await expect(page.getByTestId('camera-view-video')).toBeVisible();
  await expect(page.getByTestId('capture-button')).toBeVisible();

  expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});
