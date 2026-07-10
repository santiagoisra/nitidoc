import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quad } from '@/shared/types/geometry';
import { createInitialRecipe } from '@/features/scanner/lib/editRecipe';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';

/**
 * Group 6 / PR9 unit tests for `usePageDeletion` (design section 5.5, spec
 * `document` Req "Borrado de pagina con undo por toast"; task 6.6).
 *
 * `useToast` is mocked so this suite exercises ONLY the hook's own
 * orchestration contract (which store actions run, in what order, and this
 * hook's OWN 5s timer) — `ToastHost`'s rendering/auto-dismiss timer is
 * covered independently in `toastHost.test.tsx`, mirroring how
 * `useActivePage.test.ts` mocks `pageResources` to isolate orchestration
 * from the underlying primitives.
 */

const showToastMock = vi.fn();
const dismissToastMock = vi.fn();

vi.mock('@/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/ui')>();
  return {
    ...actual,
    useToast: () => ({ showToast: showToastMock, dismissToast: dismissToastMock }),
  };
});

import { usePageDeletion, UNDO_WINDOW_MS } from '@/features/scanner/hooks/usePageDeletion';
import { useScannerStore, scannerStoreInitialState } from '@/features/scanner/store/scannerStore';

function fakeBitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width: 150, height: 200, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function fakeBlob(): Blob {
  return new Blob(['fake'], { type: 'image/jpeg' });
}

const CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

let pageCounter = 0;
function fakePage(overrides: Partial<DocumentPage> = {}): DocumentPage {
  pageCounter += 1;
  return {
    id: overrides.id ?? `page-${pageCounter}`,
    order: overrides.order ?? 0,
    recipe: overrides.recipe ?? createInitialRecipe(CORNERS, 'a4'),
    thumbnail: overrides.thumbnail ?? fakeBitmap(),
    originalBlob: overrides.originalBlob ?? fakeBlob(),
    warpedBlob: overrides.warpedBlob ?? fakeBlob(),
    originalWidth: overrides.originalWidth ?? 1000,
    originalHeight: overrides.originalHeight ?? 1400,
    warpedWidth: overrides.warpedWidth ?? 800,
    warpedHeight: overrides.warpedHeight ?? 1200,
  };
}

/** Retrieves the `action.onClick` handler from the toast the hook most recently requested. */
function getLatestUndoHandler(): () => void {
  const call = showToastMock.mock.calls[showToastMock.mock.calls.length - 1];
  const options = call?.[0] as { action?: { onClick: () => void } } | undefined;
  const onClick = options?.action?.onClick;
  if (!onClick) throw new Error('Expected the latest showToast call to include an action.onClick handler.');
  return onClick;
}

beforeEach(() => {
  pageCounter = 0;
  useScannerStore.setState({ ...scannerStoreInitialState });
  showToastMock.mockReset().mockReturnValue('toast-id');
  dismissToastMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePageDeletion.deletePage', () => {
  it('calls store deletePage and shows a 5s undo toast', () => {
    const page = fakePage({ id: 'a', order: 0 });
    useScannerStore.getState().addPage(page);

    const { result } = renderHook(() => usePageDeletion());
    act(() => {
      result.current.deletePage('a');
    });

    expect(useScannerStore.getState().pages.some((p) => p.id === 'a')).toBe(false);
    expect(useScannerStore.getState().pendingDeletion?.id).toBe('a');
    expect(showToastMock).toHaveBeenCalledTimes(1);
    const options = showToastMock.mock.calls[0]?.[0];
    expect(options.durationMs).toBe(UNDO_WINDOW_MS);
    expect(options.action.label).toBe('Undo');
  });

  it('undo within the window restores the page at its original order with resources intact (spec "Undo dentro de la ventana de 5s")', () => {
    const pageA = fakePage({ id: 'a', order: 0 });
    const pageB = fakePage({ id: 'b', order: 1 });
    const pageC = fakePage({ id: 'c', order: 2 });
    useScannerStore.getState().addPage(pageA);
    useScannerStore.getState().addPage(pageB);
    useScannerStore.getState().addPage(pageC);

    const { result } = renderHook(() => usePageDeletion());
    act(() => {
      result.current.deletePage('b');
    });
    expect(useScannerStore.getState().pages.map((p) => p.id)).toEqual(['a', 'c']);

    // Undo BEFORE the 5s window expires.
    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    });
    const undo = getLatestUndoHandler();
    act(() => {
      undo();
    });

    expect(useScannerStore.getState().pendingDeletion).toBeNull();
    expect(useScannerStore.getState().pages.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(useScannerStore.getState().pages.find((p) => p.id === 'b')?.order).toBe(1);
    // Resources were NEVER released during the undo window.
    expect(pageB.thumbnail.close).not.toHaveBeenCalled();
    expect(dismissToastMock).toHaveBeenCalledWith('toast-id');

    // The hook's own timer must be cancelled — advancing further must NOT
    // hard-release the (already restored) page.
    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(pageB.thumbnail.close).not.toHaveBeenCalled();
  });

  it('expiry without undo hard-releases resources (spec "Expiracion sin undo libera memoria")', () => {
    const page = fakePage({ id: 'a', order: 0 });
    useScannerStore.getState().addPage(page);

    const { result } = renderHook(() => usePageDeletion());
    act(() => {
      result.current.deletePage('a');
    });
    expect(page.thumbnail.close).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });

    expect(page.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().pendingDeletion).toBeNull();
    expect(useScannerStore.getState().pages.some((p) => p.id === 'a')).toBe(false);
  });

  it('a second delete while one is pending supersedes the older one (hard-releases the older page first)', () => {
    const pageA = fakePage({ id: 'a', order: 0 });
    const pageB = fakePage({ id: 'b', order: 1 });
    useScannerStore.getState().addPage(pageA);
    useScannerStore.getState().addPage(pageB);

    const { result } = renderHook(() => usePageDeletion());
    act(() => {
      result.current.deletePage('a');
    });
    expect(pageA.thumbnail.close).not.toHaveBeenCalled();

    // Delete B while A's undo window is still open.
    act(() => {
      vi.advanceTimersByTime(1000);
      result.current.deletePage('b');
    });

    // A was hard-released immediately (superseded), B is now pending.
    expect(pageA.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(useScannerStore.getState().pendingDeletion?.id).toBe('b');
    expect(pageB.thumbnail.close).not.toHaveBeenCalled();

    // A's original timer (armed at t=0, would have fired at t=5000) must have
    // been cancelled — advancing right up to B's OWN fresh window (5s from
    // when IT was deleted, at t=1000) must not release anything yet.
    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    });
    expect(pageB.thumbnail.close).not.toHaveBeenCalled();
    expect(pageA.thumbnail.close).toHaveBeenCalledTimes(1);

    // B's own window (5s from its own deletePage call) now expires.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(pageB.thumbnail.close).toHaveBeenCalledTimes(1);
    expect(pageA.thumbnail.close).toHaveBeenCalledTimes(1);
  });
});
