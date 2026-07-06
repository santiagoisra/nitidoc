import { expect, test } from '@playwright/test';

/**
 * Trivial E2E harness check (task 1.5.2): loads the app and verifies it
 * renders. No image fixture yet — that lands in Group 7 alongside the
 * full import-fallback smoke test.
 */
test('app loads and renders the shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Nitidoc')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open scanner' })).toBeVisible();
});
