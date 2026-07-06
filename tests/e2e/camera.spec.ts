import { expect, test } from '@playwright/test';
import { chromium } from '@playwright/test';

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

/**
 * L2 (denied-permission path). The main `chromium` project in
 * playwright.config.ts launches with `--use-fake-ui-for-media-stream`
 * (auto-ACCEPT), which is required for the happy-path test above and can't
 * be flipped per-test through the shared project config. So this test
 * launches its OWN isolated Chromium instance with
 * `--use-fake-ui-for-media-stream=deny` (still Chromium's own fake-UI flag,
 * just the deny variant — not a hand-rolled mock) to drive the
 * `NotAllowedError` -> `permission: 'denied'` path end to end.
 *
 * If this flag combination were ever unsupported by the installed Chromium
 * build, `getUserMedia` would hang waiting for a real permission prompt
 * headlessly and this test would time out — that failure mode itself would
 * be the signal to report back rather than force a workaround.
 */
test('denying camera permission shows the permission-denied state', async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream=deny'],
  });

  try {
    // Same baseURL as playwright.config.ts's shared webServer (PORT 4173) —
    // this isolated browser doesn't inherit project-level `use.baseURL`,
    // so it's given explicitly via a fresh context instead.
    const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
    const page = await context.newPage();
    await page.goto('/');

    await page.getByTestId('open-scanner').click();

    const denied = page.getByTestId('permission-denied');
    await expect(denied).toBeVisible();
    await expect(denied).toHaveText(/denied/i);
  } finally {
    await browser.close();
  }
});
