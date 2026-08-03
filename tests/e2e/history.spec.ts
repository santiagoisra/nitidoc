import { expect, test, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'document.png');

/**
 * Scan history end-to-end (history design section 8).
 *
 * The unit suite exercises the schema against `fake-indexeddb`; this one runs
 * the SAME code against real Chromium IndexedDB, driven through the real UI,
 * and — crucially — across a genuine page reload. Persistence that only works
 * within one session is not persistence, and a reload is the only way to prove
 * the difference.
 *
 * The camera is denied with Chromium's own fake-UI flag (the same approach
 * `importFixture.spec.ts` uses and documents), so the run reaches the document
 * grid through the deterministic import path rather than depending on whatever
 * camera this machine happens to have.
 */

test.describe('scan history: save, survive a reload, reopen', () => {
  // Well past Playwright's 30s default: reaching the grid means waiting on the
  // deferred batch step, which in turn waits out an OpenCV init that does not
  // complete in headless Chromium (documented at length in
  // importFixture.spec.ts). Two of those, plus two reloads, per test.
  test.describe.configure({ timeout: 180_000 });

  test('a finished document is listed after a reload and reopens into its grid', async () => {
    const browser = await chromium.launch({
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream=deny'],
    });
    try {
      const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
      const page = await context.newPage();

      const pageErrors: Error[] = [];
      page.on('pageerror', (error) => pageErrors.push(error));

      await page.goto('/');

      // An untouched profile must show the empty state, not a broken list —
      // this also proves opening the database on a cold origin works.
      await page.getByTestId('welcome-history').click();
      await expect(page.getByTestId('history-empty')).toBeVisible();
      await page.getByTestId('history-back').click();

      // Import the fixture straight from the welcome screen: decode ->
      // materialize -> 'processing' -> 'adjust'. The batch step waits on an
      // OpenCV init that may or may not succeed in headless Chromium (see
      // importFixture.spec.ts's docstring); either way it terminates in the
      // adjust screen, hence the generous timeout.
      await page.getByTestId('welcome-import-input').setInputFiles(FIXTURE_PATH);
      await expect(page.getByTestId('adjust-screen')).toBeVisible({ timeout: 45_000 });

      await page.getByTestId('adjust-next').click();
      await expect(page.getByTestId('page-grid')).toBeVisible();

      // "Listo" is the non-export way to finish a document, and one of the two
      // moments that writes to the history.
      await page.getByTestId('grid-finish').click();
      // The done screen only appears once the history write has settled, so
      // waiting for it is what makes the reload below meaningful rather than a
      // race against an in-flight transaction.
      await expect(page.getByTestId('done-export-pdf')).toBeVisible({ timeout: 15_000 });

      // THE POINT OF THIS TEST: a full reload drops every in-memory blob,
      // bitmap and store value. Anything still present afterwards came out of
      // IndexedDB.
      await page.reload();

      await page.getByTestId('welcome-history').click();
      const card = page.getByTestId('history-card');
      await expect(card).toHaveCount(1, { timeout: 10_000 });
      await expect(page.getByTestId('history-usage')).toBeVisible();

      // Reopening rehydrates the pages and lands on the grid, which only
      // renders when `pages` is non-empty — so seeing it IS the assertion that
      // the page blobs came back, not just the metadata row.
      await page.getByTestId('history-open').click();
      await expect(page.getByTestId('page-grid')).toBeVisible({ timeout: 15_000 });

      expect(pageErrors, `Unhandled page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  test('deleting a scan removes it and returns the list to its empty state', async () => {
    const browser = await chromium.launch({
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream=deny'],
    });
    try {
      const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
      const page = await context.newPage();
      await page.goto('/');

      await page.getByTestId('welcome-import-input').setInputFiles(FIXTURE_PATH);
      await expect(page.getByTestId('adjust-screen')).toBeVisible({ timeout: 45_000 });
      await page.getByTestId('adjust-next').click();
      await page.getByTestId('grid-finish').click();
      // The done screen only appears once the history write has settled, so
      // waiting for it is what makes the reload below meaningful rather than a
      // race against an in-flight transaction.
      await expect(page.getByTestId('done-export-pdf')).toBeVisible({ timeout: 15_000 });

      await page.reload();
      await page.getByTestId('welcome-history').click();
      await expect(page.getByTestId('history-card')).toHaveCount(1, { timeout: 10_000 });

      await page.getByTestId('history-delete').click();
      await expect(page.getByTestId('history-empty')).toBeVisible();

      // And it must STAY deleted — an optimistic UI removal that never reached
      // the database would reappear here.
      await page.reload();
      await page.getByTestId('welcome-history').click();
      await expect(page.getByTestId('history-empty')).toBeVisible({ timeout: 10_000 });
    } finally {
      await browser.close();
    }
  });
});
