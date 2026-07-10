import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureTray } from '@/features/scanner/components/CaptureTray';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

/**
 * Group 5 / PR8 unit tests for `CaptureTray` (design section 5.2, spec
 * `document` "Bandeja de captura continua"). Covers task 5.6:
 *  - the cap-30 hint renders when `isAtCap` is true.
 *  - thumbnail-only render: the strip draws each page's cached `thumbnail`
 *    bitmap via `drawImage` — it never calls `createImageBitmap` on a
 *    `Blob` (no full-res decode ever happens in this component).
 */

function makeBitmap(width = 150, height = 200): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function makePage(id: string, order: number): DocumentPage {
  return {
    id,
    order,
    recipe: {} as DocumentPage['recipe'],
    thumbnail: makeBitmap(),
    originalBlob: {} as Blob,
    warpedBlob: {} as Blob,
    originalWidth: 1000,
    originalHeight: 1400,
    warpedWidth: 1000,
    warpedHeight: 1400,
  };
}

const drawImageSpy = vi.fn();

function installCanvasShims(): void {
  const fakeCtx = {
    drawImage: drawImageSpy,
    clearRect: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
}

describe('CaptureTray (Group 5 / PR8, design section 5.2)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    drawImageSpy.mockClear();
  });

  it('renders nothing when no pages have been captured yet', () => {
    installCanvasShims();
    const onDone = vi.fn();
    const { container } = render(<CaptureTray pages={[]} isAtCap={false} onDone={onDone} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the cap-30 hint when isAtCap is true (spec "Cap duro de 30 paginas alcanzado")', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0)];
    render(<CaptureTray pages={pages} isAtCap onDone={vi.fn()} />);

    const hint = screen.getByTestId('capture-tray-cap-hint');
    expect(hint.textContent).toContain(String(FILTER.PAGE_CAP));
  });

  it('does not show the cap hint when isAtCap is false', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0)];
    render(<CaptureTray pages={pages} isAtCap={false} onDone={vi.fn()} />);

    expect(screen.queryByTestId('capture-tray-cap-hint')).toBeNull();
  });

  it('renders one thumbnail per page via drawImage — never decodes a Blob (D6, thumbnail-only)', () => {
    installCanvasShims();
    const pages = [makePage('p1', 0), makePage('p2', 1), makePage('p3', 2)];
    render(<CaptureTray pages={pages} isAtCap={false} onDone={vi.fn()} />);

    for (const page of pages) {
      expect(screen.getByTestId(`capture-tray-thumb-${page.id}`)).toBeTruthy();
    }
    // One drawImage call per page thumbnail — the ONLY draw source is the
    // already-cached `thumbnail` ImageBitmap, never a decoded original/warped Blob.
    expect(drawImageSpy).toHaveBeenCalledTimes(pages.length);
    pages.forEach((page, index) => {
      expect(drawImageSpy.mock.calls[index]?.[0]).toBe(page.thumbnail);
    });
  });

  it('"Listo" calls onDone and shows the page counter', () => {
    installCanvasShims();
    const onDone = vi.fn();
    const pages = [makePage('p1', 0), makePage('p2', 1)];
    render(<CaptureTray pages={pages} isAtCap={false} onDone={onDone} />);

    expect(screen.getByText('2 pages captured')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tray-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
