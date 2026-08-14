import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });

test('renders the A4 live guide at the selected physical ratio within a 390 x 844 viewport', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-scanner').click();
  const guide = page.getByTestId('capture-paper-guide');
  await expect(guide).toBeVisible();

  const bounds = await guide.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, pointerEvents: getComputedStyle(element).pointerEvents };
  });
  expect(bounds.width / bounds.height).toBeCloseTo(210 / 297, 2);
  expect(bounds.pointerEvents).toBe('none');
});
