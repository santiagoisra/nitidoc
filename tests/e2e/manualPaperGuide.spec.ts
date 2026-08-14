import { expect, test } from '@playwright/test';
import { inflateSync } from 'node:zlib';

interface RgbaPixel {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft;
}

/** Decode Playwright's RGBA PNG in-process so this test asserts composited pixels, not DOM attributes. */
function pixelAt(png: Buffer, x: number, y: number): RgbaPixel {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += length + 12;
  }

  if (bitDepth !== 8 || colorType !== 6 || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('Expected an in-bounds 8-bit RGBA Playwright screenshot.');
  }

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const source = inflateSync(Buffer.concat(idat));
  const decoded = Buffer.alloc(height * stride);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = source[sourceOffset++] ?? 0;
    const rowStart = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = source[sourceOffset++] ?? 0;
      const left = column >= bytesPerPixel ? decoded[rowStart + column - bytesPerPixel] ?? 0 : 0;
      const above = row > 0 ? decoded[rowStart - stride + column] ?? 0 : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel ? decoded[rowStart - stride + column - bytesPerPixel] ?? 0 : 0;
      decoded[rowStart + column] = filter === 0 ? raw : filter === 1 ? (raw + left) & 0xff : filter === 2 ? (raw + above) & 0xff : filter === 3 ? (raw + Math.floor((left + above) / 2)) & 0xff : (raw + paeth(left, above, upperLeft)) & 0xff;
    }
  }

  const pixelOffset = y * stride + x * bytesPerPixel;
  return {
    red: decoded[pixelOffset] ?? 0,
    green: decoded[pixelOffset + 1] ?? 0,
    blue: decoded[pixelOffset + 2] ?? 0,
    alpha: decoded[pixelOffset + 3] ?? 0,
  };
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });

test.beforeEach(async ({ page, browserName }) => {
  if (browserName !== 'webkit') return;
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get: () => null,
      set: () => undefined,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [], getVideoTracks: () => [] }),
        enumerateDevices: async () => [{ deviceId: 'playwright-camera', groupId: '', kind: 'videoinput', label: 'Test camera' }],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
  });
  await page.goto('data:text/html,<html></html>');
  await expect(page.evaluate(() => ({
    mediaDevices: typeof navigator.mediaDevices,
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
  }))).resolves.toEqual({ mediaDevices: 'object', getUserMedia: 'function' });
});

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

test('composites an undimmed guide interior and a visibly dimmed exterior in mobile WebKit', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'The raw PNG pixel decoder intentionally covers the Safari/WebKit regression target.');
  await page.goto('/');
  await page.getByTestId('open-scanner').click();
  await expect(page.getByTestId('capture-paper-guide')).toBeVisible();
  await page.getByTestId('camera-view-video').evaluate((video) => {
    (video as HTMLElement).style.setProperty('background', 'rgb(200, 180, 160)', 'important');
  });

  const guide = await page.getByTestId('capture-paper-guide').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
  const interiorX = Math.floor(Math.min(guide.right - 16, guide.left + Math.max(16, (guide.right - guide.left) / 2)));
  const interiorY = Math.floor(guide.top + (guide.bottom - guide.top) / 2);
  const exteriorY = Math.floor(guide.top - 16);
  const screenshot = await page.screenshot();
  const interior = pixelAt(screenshot, interiorX, interiorY);
  const exterior = pixelAt(screenshot, interiorX, exteriorY);

  // A filled guide hole regresses to the same dark luminance as the exterior.
  expect(interior.red).toBeGreaterThan(170);
  expect(interior.green).toBeGreaterThan(150);
  expect(interior.blue).toBeGreaterThan(130);
  expect(exterior.red).toBeLessThan(interior.red - 55);
  expect(exterior.green).toBeLessThan(interior.green - 55);
  expect(exterior.blue).toBeLessThan(interior.blue - 55);
});

test('reserves separated rows for toolbar, guide, picker and shutter in each mobile guide format', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('welcome-paper-format')).toHaveCount(0);
  await page.getByTestId('open-scanner').click();

  for (const format of ['A4 / A3', 'Legal', 'Card / ID']) {
    await page.getByRole('radio', { name: format }).click();
    await expect(page.getByTestId('capture-paper-guide')).toHaveAttribute('vector-effect', 'non-scaling-stroke');
    const geometry = await page.evaluate(() => {
      const bounds = (testId: string) => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (!element) throw new Error(`Missing ${testId}`);
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      };
      return {
        toolbar: bounds('capture-toolbar'),
        guide: bounds('capture-paper-guide-frame'),
        picker: bounds('capture-paper-format'),
        shutter: bounds('capture-button'),
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });

    expect(geometry.guide.top).toBeGreaterThan(geometry.toolbar.bottom + 4);
    expect(geometry.guide.bottom).toBeLessThan(geometry.picker.top - 4);
    expect(geometry.picker.bottom).toBeLessThanOrEqual(geometry.shutter.top);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  }
});
