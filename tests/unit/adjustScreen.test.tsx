import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bug 6 + bug 3 (punch-list) unit tests for `AdjustScreen`'s preview strip —
 * previously untested. Covers the two regressions the punch-list asked for:
 *  - bug 6: the strip must be a REAL N-page carousel (one slide per page +
 *    "Agregar más"), not a fixed 2-slide toggle that only ever showed the
 *    current page vs. add-more regardless of `pages.length`.
 *  - bug 3: a "swipe for more" affordance must exist so the add-more panel
 *    is discoverable.
 *
 * Environment limitation (documented per the punch-list's own instruction):
 * happy-dom's `IntersectionObserver.observe()` is a stub that never invokes
 * its callback (see `node_modules/happy-dom/lib/intersection-observer/
 * IntersectionObserver.js`), and `scrollIntoView`/`scrollTo` never actually
 * move `scrollLeft`. So SWIPE-driven active-index sync and real visual
 * scroll position are NOT exercised here — these tests instead assert the
 * structural contract (slide count, which bitmap each slide draws, counter
 * text, chevron-driven `scrollIntoView` calls, disabled-state clamping) and
 * confirm the IntersectionObserver feature-detect path doesn't crash when
 * the API is entirely absent. Real swipe/scroll behavior needs a real
 * browser (or Playwright) to verify.
 */

const decodeBlobToBitmapMock = vi.fn();

vi.mock('@/features/scanner/lib/pageResources', async () => {
  const actual = await vi.importActual<typeof import('@/features/scanner/lib/pageResources')>(
    '@/features/scanner/lib/pageResources',
  );
  return {
    ...actual,
    decodeBlobToBitmap: (...args: unknown[]) => decodeBlobToBitmapMock(...args),
  };
});

// FilterPanel pulls in the worker/preset-tile pipeline (already covered by
// its own suite) — stubbed here so this file stays focused on the preview
// strip / carousel itself.
vi.mock('@/features/scanner/components/FilterPanel', () => ({
  FilterPanel: ({ paper, onPaperChange }: { paper?: { evidence: unknown }; onPaperChange?: (paper: unknown) => void }) =>
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'filter-panel-stub',
        onClick: () =>
          onPaperChange?.({
            id: 'legal',
            alias: 'oficio',
            source: 'manual',
            confidence: 'none',
            evidence: paper?.evidence ?? { measuredRatio: 0, scaleInferred: false },
          }),
      },
      'filter panel',
    ),
}));

import { AdjustScreen } from '@/features/scanner/components/AdjustScreen';
import { ToastHost } from '@/shared/ui';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';
import { createInitialRecipe } from '@/features/scanner/lib/editRecipe';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { Quad } from '@/shared/types/geometry';

function fakeBitmap(width = 150, height = 200): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

const PAGE_CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

function fakePage(overrides: Partial<DocumentPage> = {}): DocumentPage {
  return {
    id: overrides.id ?? 'page-1',
    order: overrides.order ?? 0,
    recipe: overrides.recipe ?? createInitialRecipe(PAGE_CORNERS, 'a4'),
    thumbnail: overrides.thumbnail ?? fakeBitmap(),
    originalBlob: overrides.originalBlob ?? ({} as Blob),
    warpedBlob: overrides.warpedBlob ?? ({} as Blob),
    originalWidth: overrides.originalWidth ?? 1000,
    originalHeight: overrides.originalHeight ?? 1400,
    warpedWidth: overrides.warpedWidth ?? 800,
    warpedHeight: overrides.warpedHeight ?? 1200,
  };
}

function renderAdjustScreen(
  props: Partial<{
    initialPageId: string | null;
    onPageChange: (pageId: string) => void;
    onCrop: (pageId: string) => void;
    onNext: () => void;
    onAddMore: () => void;
    onBack: () => void;
  }> = {},
) {
  return render(
    <ToastHost>
      <AdjustScreen
        initialPageId={props.initialPageId ?? null}
        onPageChange={props.onPageChange ?? vi.fn()}
        onCrop={props.onCrop ?? vi.fn()}
        onNext={props.onNext ?? vi.fn()}
        onAddMore={props.onAddMore ?? vi.fn()}
        onBack={props.onBack ?? vi.fn()}
      />
    </ToastHost>,
  );
}

describe('AdjustScreen preview strip (bug 6: real N-page carousel, bug 3: swipe affordance)', () => {
  beforeEach(() => {
    decodeBlobToBitmapMock.mockReset();
    decodeBlobToBitmapMock.mockImplementation(async () => fakeBitmap(800, 1200));
    useScannerStore.setState({ ...scannerStoreInitialState });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders one real slide per page plus the trailing "Agregar más" slide (not a fixed 2-slide toggle)', async () => {
    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1 }), fakePage({ id: 'p3', order: 2 })],
    });
    renderAdjustScreen();

    expect(screen.getByTestId('adjust-page-slide-p1')).toBeTruthy();
    expect(screen.getByTestId('adjust-page-slide-p2')).toBeTruthy();
    expect(screen.getByTestId('adjust-page-slide-p3')).toBeTruthy();
    expect(screen.getByTestId('adjust-add-more')).toBeTruthy();
    expect(screen.getByTestId('adjust-preview-strip')).toBeTruthy();

    // Counter already reads pages.length today, but pre-fix the strip itself
    // only ever had 2 DOM slides regardless of this number — the assertions
    // above are the actual bug 6 regression check.
    expect(screen.getByTestId('adjust-page-counter').textContent).toBe('1 / 3');

    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());
  });

  it('only the active slide renders WarpedPreview; every other page slide renders its own attenuated thumbnail', async () => {
    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1 }), fakePage({ id: 'p3', order: 2 })],
    });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    // p1 is active: no thumbnail fallback for it.
    expect(screen.queryByTestId('adjust-page-slide-thumb-p1')).toBeNull();
    // p2/p3 are not active: thumbnail fallback, no full-res preview for them.
    expect(screen.getByTestId('adjust-page-slide-thumb-p2')).toBeTruthy();
    expect(screen.getByTestId('adjust-page-slide-thumb-p3')).toBeTruthy();
  });

  it('non-active slides draw their OWN page thumbnail bitmap; the active slide draws the decoded warp base', async () => {
    const drawImageSpy = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      { drawImage: drawImageSpy, clearRect: vi.fn() } as unknown as CanvasRenderingContext2D,
    );

    const thumb2 = fakeBitmap(150, 200);
    const decodedBase = fakeBitmap(800, 1200);
    decodeBlobToBitmapMock.mockResolvedValue(decodedBase);

    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1, thumbnail: thumb2 })],
    });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    const drawnBitmaps = drawImageSpy.mock.calls.map((call) => call[0]);
    expect(drawnBitmaps).toContain(decodedBase); // active slide (p1)
    expect(drawnBitmaps).toContain(thumb2); // inactive slide (p2)
  });

  it('D-MEM: switching the active page (chevron) closes the previous decoded base before decoding the next one', async () => {
    const baseP1 = fakeBitmap(800, 1200);
    const baseP2 = fakeBitmap(800, 1200);
    decodeBlobToBitmapMock.mockResolvedValueOnce(baseP1).mockResolvedValueOnce(baseP2);

    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1 })],
    });
    renderAdjustScreen();
    await waitFor(() => expect(decodeBlobToBitmapMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('adjust-next-page'));

    await waitFor(() => expect(decodeBlobToBitmapMock).toHaveBeenCalledTimes(2));
    expect(baseP1.close).toHaveBeenCalledTimes(1); // closed before the new base overwrote it
    expect(baseP2.close).not.toHaveBeenCalled();
    expect(screen.getByTestId('adjust-page-counter').textContent).toBe('2 / 2');
  });

  it('page-switch decode gap: the active slide shows its own thumbnail, never the previous page\'s stale base, until the new decode resolves', async () => {
    const baseP1 = fakeBitmap(800, 1200);
    const baseP2 = fakeBitmap(800, 1200);
    let resolveP2!: (bitmap: ImageBitmap) => void;
    decodeBlobToBitmapMock
      .mockResolvedValueOnce(baseP1)
      .mockImplementationOnce(
        () =>
          new Promise<ImageBitmap>((resolve) => {
            resolveP2 = resolve;
          }),
      );

    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1 })],
    });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    // Switch to p2 — its decode is still pending (never resolved yet).
    fireEvent.click(screen.getByTestId('adjust-next-page'));
    await waitFor(() => expect(decodeBlobToBitmapMock).toHaveBeenCalledTimes(2));

    // The base is tagged with the page it belongs to, so during the decode gap
    // the now-active p2 slide must fall back to its OWN thumbnail rather than
    // drawing p1's still-live bitmap stretched into p2's box (HIGH review find).
    expect(screen.queryByTestId('adjust-warped-preview')).toBeNull();
    expect(screen.getByTestId('adjust-page-slide-thumb-p2')).toBeTruthy();

    // Once p2's own decode lands, the full-res preview takes over.
    resolveP2(baseP2);
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());
  });

  it('D-MEM: unmounting closes whatever base is currently live', async () => {
    const baseP1 = fakeBitmap(800, 1200);
    decodeBlobToBitmapMock.mockResolvedValue(baseP1);
    useScannerStore.setState({ pages: [fakePage({ id: 'p1', order: 0 })] });

    const { unmount } = renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    unmount();
    expect(baseP1.close).toHaveBeenCalledTimes(1);
  });

  it('chevrons scroll the target slide into view, update the counter, and are disabled at the edges', async () => {
    const scrollIntoViewSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1 }), fakePage({ id: 'p3', order: 2 })],
    });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    // Mount already scrolled once (instant, to the initial slide).
    const callsAfterMount = scrollIntoViewSpy.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);
    expect((screen.getByTestId('adjust-prev-page') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('adjust-next-page'));
    expect(screen.getByTestId('adjust-page-counter').textContent).toBe('2 / 3');
    expect(scrollIntoViewSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
    expect(scrollIntoViewSpy.mock.calls.at(-1)?.[0]).toMatchObject({ behavior: 'smooth', inline: 'center' });
    expect((screen.getByTestId('adjust-prev-page') as HTMLButtonElement).disabled).toBe(false);

    await waitFor(() => expect(decodeBlobToBitmapMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId('adjust-next-page'));
    expect(screen.getByTestId('adjust-page-counter').textContent).toBe('3 / 3');
    expect((screen.getByTestId('adjust-next-page') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(decodeBlobToBitmapMock).toHaveBeenCalledTimes(3));
  });

  it('mount scrolls to initialPageId\'s slide (also covers the crop round-trip re-center, which remounts with a fresh initialPageId)', async () => {
    const scrollIntoViewSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1 }), fakePage({ id: 'p3', order: 2 })],
    });
    renderAdjustScreen({ initialPageId: 'p2' });

    expect(screen.getByTestId('adjust-page-counter').textContent).toBe('2 / 3');
    expect(scrollIntoViewSpy).toHaveBeenCalled();
    expect(scrollIntoViewSpy.mock.calls[0]?.[0]).toMatchObject({ behavior: 'auto' });
    await waitFor(() => expect(decodeBlobToBitmapMock).toHaveBeenCalledTimes(1));
  });

  it('reports the active page id up via onPageChange as the active slide changes (existing wiring, must keep working)', async () => {
    const onPageChange = vi.fn();
    useScannerStore.setState({
      pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1 })],
    });
    renderAdjustScreen({ onPageChange });

    await waitFor(() => expect(onPageChange).toHaveBeenCalledWith('p1'));

    fireEvent.click(screen.getByTestId('adjust-next-page'));
    await waitFor(() => expect(onPageChange).toHaveBeenCalledWith('p2'));
  });

  it('persists the manual Oficio selection through the document store', async () => {
    useScannerStore.setState({ pages: [fakePage({ id: 'p1' })] });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('filter-panel-stub')).toBeTruthy());

    fireEvent.click(screen.getByTestId('filter-panel-stub'));

    expect(useScannerStore.getState().pages[0]?.recipe.paper).toMatchObject({
      id: 'legal',
      alias: 'oficio',
      source: 'manual',
    });
  });

  it('bug 3: shows the "swipe for more" hint while on a page slide (hiding it once the add-more slide is actually centered needs real IntersectionObserver support, not exercised under happy-dom)', async () => {
    useScannerStore.setState({ pages: [fakePage({ id: 'p1', order: 0 })] });
    renderAdjustScreen();
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    expect(screen.getByTestId('adjust-more-hint')).toBeTruthy();
    expect(screen.getByTestId('adjust-more-hint').getAttribute('aria-hidden')).toBe('true');
  });

  it('does not crash when IntersectionObserver is entirely unavailable (feature-detect), and chevron navigation still works', async () => {
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    // @ts-expect-error deliberately simulating an environment without IntersectionObserver.
    delete globalThis.IntersectionObserver;

    try {
      useScannerStore.setState({
        pages: [fakePage({ id: 'p1', order: 0 }), fakePage({ id: 'p2', order: 1 })],
      });
      renderAdjustScreen();
      await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

      fireEvent.click(screen.getByTestId('adjust-next-page'));
      expect(screen.getByTestId('adjust-page-counter').textContent).toBe('2 / 2');
      await waitFor(() => expect(decodeBlobToBitmapMock).toHaveBeenCalledTimes(2));
    } finally {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    }
  });

  it('tapping the "Agregar más" slide calls onAddMore', async () => {
    const onAddMore = vi.fn();
    useScannerStore.setState({ pages: [fakePage({ id: 'p1', order: 0 })] });
    renderAdjustScreen({ onAddMore });
    await waitFor(() => expect(screen.getByTestId('adjust-warped-preview')).toBeTruthy());

    fireEvent.click(screen.getByTestId('adjust-add-more'));
    expect(onAddMore).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there are no pages (defensive, unchanged behavior)', () => {
    useScannerStore.setState({ pages: [] });
    const { container } = renderAdjustScreen();
    expect(container.querySelector('[data-testid="adjust-screen"]')).toBeNull();
  });
});
