import { expect, test } from '@playwright/test';

/**
 * Trivial E2E harness check (task 1.5.2): loads the app and verifies the
 * welcome screen renders.
 *
 * This used to assert `getByRole('button', { name: 'Open scanner' })`. No such
 * button has existed since the welcome-screen redesign — the CTA reads "Open
 * camera" (`welcome.openCamera`) — so the test failed on a label change rather
 * than on anything being broken. It now selects by `data-testid`, which
 * `WelcomeScreen.tsx` explicitly documents as the contract the E2E suite
 * depends on ("Los tests E2E dependen de data-testid — no tocarlos"), leaving
 * the copy free to change without breaking a smoke test.
 */
test('app loads and renders the shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('welcome-screen')).toBeVisible();
  await expect(page.getByTestId('open-scanner')).toBeVisible();
});
