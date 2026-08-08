import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'document.png');

test.describe('B&W preview backing-store fidelity', () => {
  test.describe.configure({ timeout: 180_000 });

  test('renders the resolved adaptive B&W result as strict binary pixels', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.goto('/');
    await page.getByTestId('welcome-import-input').setInputFiles(FIXTURE_PATH);
    await expect(page.getByTestId('adjust-screen')).toBeVisible({ timeout: 120_000 });

    await page.getByTestId('filter-preset-bw').click();

    const canvas = page.getByTestId('adjust-warped-preview').getByTestId('warped-preview-canvas');
    await expect(canvas).toBeVisible();

    await expect
      .poll(async () =>
        canvas.evaluate((element: HTMLCanvasElement) => {
          const context = element.getContext('2d');
          if (!context || element.width === 0 || element.height === 0) {
            return { grayscale: false, binary: false, black: false, white: false };
          }

          const pixels = context.getImageData(0, 0, element.width, element.height).data;
          let grayscale = true;
          let binary = true;
          let black = false;
          let white = false;

          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            grayscale &&= red === green && green === blue;
            binary &&= red === 0 || red === 255;
            black ||= red === 0;
            white ||= red === 255;
          }

          return { grayscale, binary, black, white };
        }),
      )
      .toEqual({ grayscale: true, binary: true, black: true, white: true });

    expect(pageErrors, `Unhandled page errors: ${pageErrors.map((error) => error.message).join('; ')}`).toHaveLength(0);
  });
});
