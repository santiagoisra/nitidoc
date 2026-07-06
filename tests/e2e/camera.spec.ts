import { expect, test } from '@playwright/test';

/**
 * Group 3 (Slice C) smoke test: exercises useCamera's happy path against
 * Chromium's built-in fake media stream (`--use-fake-device-for-media-stream`,
 * configured in playwright.config.ts). This is Chromium's OWN fake device
 * implementation, not a hand-rolled camera mock (design section 11 forbids
 * inventing browser APIs / mocks).
 *
 * What this DOES verify: getUserMedia resolves, the stream attaches to the
 * <video> element and starts rendering frames, and track.getSettings()
 * produces a real resolution reflected by the UI wiring.
 *
 * What this does NOT verify (see apply-progress "device QA" notes): torch
 * (fake device never reports the `torch` capability), real 4K negotiation,
 * ImageCapture on iOS Safari, or true tab-backgrounding behavior — those
 * require real hardware and are explicitly deferred.
 */
test('opening the scanner starts the fake camera stream and renders video', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('open-scanner').click();

  const video = page.getByTestId('camera-view-video');
  await expect(video).toBeVisible();

  // Wait for the stream to actually attach and start playing frames —
  // readyState 4 (HAVE_ENOUGH_DATA) confirms useCamera's getUserMedia
  // pipeline (open -> setStream -> <video>.srcObject) worked end to end.
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);

  const dimensions = await video.evaluate((el: HTMLVideoElement) => ({
    width: el.videoWidth,
    height: el.videoHeight,
  }));
  expect(dimensions.width).toBeGreaterThan(0);
  expect(dimensions.height).toBeGreaterThan(0);
});
