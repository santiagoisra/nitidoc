import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

for (const scenario of ['success', 'degraded', 'warp-failure'] as const) {
  test(`keeps outside-guide raster colors out of the ${scenario} manual batch result`, async ({ page }) => {
    await page.goto(`/__e2e_manual_guide_raster__?scenario=${scenario}`);
    await expect(page.getByTestId('manual-guide-raster-result')).toHaveAttribute('data-status', 'complete', { timeout: 90_000 });
    await expect(page.getByTestId('manual-guide-raster-result')).toHaveAttribute('data-outside-red-pixels', '0');
    await expect(page.getByTestId('manual-guide-raster-result')).toHaveAttribute('data-inside-green-pixels', /[1-9]\d*/);
    const expectedWarp =
      scenario === 'success'
        ? { calls: '1', resolved: 'true', rejection: 'false' }
        : scenario === 'degraded'
          ? { calls: '0', resolved: 'false', rejection: 'false' }
          : { calls: '1', resolved: 'false', rejection: 'true' };
    await expect(page.getByTestId('manual-guide-raster-result')).toHaveAttribute('data-warp-calls', expectedWarp.calls);
    await expect(page.getByTestId('manual-guide-raster-result')).toHaveAttribute('data-warp-resolved', expectedWarp.resolved);
    await expect(page.getByTestId('manual-guide-raster-result')).toHaveAttribute('data-warp-intentional-rejection', expectedWarp.rejection);
  });
}
