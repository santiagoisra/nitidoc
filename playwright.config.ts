import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/bwPreviewCanvas.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        // Fake camera stream so useCamera's happy path (getUserMedia,
        // enumerateDevices, track.getSettings) can be exercised headlessly
        // without a real device or an OS permission dialog (design section
        // 11 — "nada de mocks inventados de camara"; this uses Chromium's
        // OWN fake-device implementation, not a hand-rolled mock).
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
    {
      name: 'bw-preview-chromium',
      testMatch: '**/bwPreviewCanvas.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      name: 'bw-preview-webkit',
      testMatch: '**/bwPreviewCanvas.spec.ts',
      use: {
        ...devices['Desktop Safari'],
      },
    },
    {
      name: 'toolbar-webkit',
      testMatch: '**/captureToolbar.spec.ts',
      use: {
        ...devices['Desktop Safari'],
      },
    },
  ],
});
