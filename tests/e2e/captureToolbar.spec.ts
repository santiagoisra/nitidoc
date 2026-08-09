import { expect, test } from '@playwright/test';

const VIEWPORT = { width: 320, height: 568 } as const;
const LONG_REAR_LABEL = 'Back Triple Camera with an intentionally long device label';

test.use({ viewport: VIEWPORT, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

async function installCameraFixture(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(
    ({ longRearLabel }) => {
      const devices = [
        { deviceId: 'rear', label: longRearLabel, kind: 'videoinput', groupId: 'camera-group' },
        { deviceId: 'front', label: 'Front Camera', kind: 'videoinput', groupId: 'camera-group' },
      ].map((device) => ({ ...device, toJSON: () => device }));

      function requestedDeviceId(constraints?: MediaStreamConstraints): string {
        const video = constraints?.video;
        if (!video || typeof video === 'boolean') return 'rear';
        const requested = video.deviceId;
        if (typeof requested === 'string') return requested;
        if (Array.isArray(requested)) return requested[0] ?? 'rear';
        if (requested && typeof requested === 'object') {
          const exact = requested.exact;
          if (typeof exact === 'string') return exact;
          if (Array.isArray(exact) && typeof exact[0] === 'string') return exact[0];
        }
        return 'rear';
      }

      function cameraStream(deviceId: string): MediaStream {
        const track = {
          readyState: 'live',
          stop: () => undefined,
          getSettings: () => ({ deviceId, width: 1920, height: 1080 }),
          getCapabilities: () => ({ torch: true }),
          applyConstraints: async () => undefined,
        } as unknown as MediaStreamTrack;
        const stream = new MediaStream();
        Object.defineProperties(stream, {
          getVideoTracks: { value: () => [track] },
          getTracks: { value: () => [track] },
        });
        return stream;
      }

      const mediaDevices = new EventTarget() as MediaDevices;
      Object.defineProperties(mediaDevices, {
        getUserMedia: {
          value: async (constraints?: MediaStreamConstraints) => cameraStream(requestedDeviceId(constraints)),
        },
        enumerateDevices: { value: async () => devices },
      });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    },
    { longRearLabel: LONG_REAR_LABEL },
  );
}

test('keeps the long camera selector and 44px torch inside a narrow toolbar', async ({ page }) => {
  await installCameraFixture(page);
  await page.goto('/');
  await page.getByTestId('open-scanner').click();

  const toolbar = page.getByTestId('capture-toolbar');
  const select = page.getByTestId('camera-selector-select');
  const selectedLabel = page.getByTestId('camera-selector-label');
  const torch = page.getByTestId('torch-toggle');

  await expect(toolbar).toBeVisible();
  await expect(select).toHaveValue('rear');
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option').first()).toHaveText(LONG_REAR_LABEL);
  await expect(torch).toHaveAccessibleName(/torch|linterna/i);
  await expect(torch).toHaveAttribute('aria-pressed', 'false');

  const geometry = await page.evaluate(() => {
    const toolbarElement = document.querySelector<HTMLElement>('[data-testid="capture-toolbar"]');
    const selectorElement = document.querySelector<HTMLElement>('[data-testid="camera-selector"]');
    const labelElement = document.querySelector<HTMLElement>('[data-testid="camera-selector-label"]');
    const torchElement = document.querySelector<HTMLElement>('[data-testid="torch-toggle"]');
    if (!toolbarElement || !selectorElement || !labelElement || !torchElement) {
      throw new Error('Capture toolbar fixture did not render all required controls.');
    }

    const toolbarRect = toolbarElement.getBoundingClientRect();
    const selectorRect = selectorElement.getBoundingClientRect();
    const torchRect = torchElement.getBoundingClientRect();
    const toolbarStyle = getComputedStyle(toolbarElement);
    const labelStyle = getComputedStyle(labelElement);
    return {
      viewportWidth: window.innerWidth,
      toolbar: { left: toolbarRect.left, right: toolbarRect.right, width: toolbarRect.width },
      selector: { left: selectorRect.left, right: selectorRect.right, width: selectorRect.width },
      torch: { left: torchRect.left, right: torchRect.right, width: torchRect.width, height: torchRect.height },
      toolbarClientWidth: toolbarElement.clientWidth,
      toolbarScrollWidth: toolbarElement.scrollWidth,
      paddingLeft: Number.parseFloat(toolbarStyle.paddingLeft),
      paddingRight: Number.parseFloat(toolbarStyle.paddingRight),
      labelClientWidth: labelElement.clientWidth,
      labelScrollWidth: labelElement.scrollWidth,
      textOverflow: labelStyle.textOverflow,
      overflowX: labelStyle.overflowX,
      whiteSpace: labelStyle.whiteSpace,
      safeAreaClasses: toolbarElement.className,
    };
  });
  await test.info().attach('toolbar-geometry', {
    body: JSON.stringify(geometry, null, 2),
    contentType: 'application/json',
  });

  expect(geometry.viewportWidth).toBe(VIEWPORT.width);
  expect(geometry.toolbar.left).toBeGreaterThanOrEqual(0);
  expect(geometry.toolbar.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.toolbarScrollWidth).toBeLessThanOrEqual(geometry.toolbarClientWidth);
  expect(geometry.selector.width).toBeGreaterThan(0);
  expect(geometry.selector.right).toBeLessThanOrEqual(geometry.torch.left);
  expect(geometry.labelScrollWidth).toBeGreaterThan(geometry.labelClientWidth);
  expect(geometry.torch.width).toBeGreaterThanOrEqual(44);
  expect(geometry.torch.height).toBeGreaterThanOrEqual(44);
  expect(geometry.torch.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.textOverflow).toBe('ellipsis');
  expect(geometry.overflowX).toBe('hidden');
  expect(geometry.whiteSpace).toBe('nowrap');

  // Desktop browser automation resolves safe-area env() values to zero. The
  // computed 12px fallback and shipped env() utilities are both asserted;
  // nonzero iPhone insets remain an explicit Phase 4 physical-device check.
  expect(geometry.paddingLeft).toBeCloseTo(12, 1);
  expect(geometry.paddingRight).toBeCloseTo(12, 1);
  expect(geometry.safeAreaClasses).toContain('env(safe-area-inset-left)');
  expect(geometry.safeAreaClasses).toContain('env(safe-area-inset-right)');

  await select.selectOption('front');
  await expect(select).toHaveValue('front');
  await expect(selectedLabel).toHaveText('Front Camera');
});
