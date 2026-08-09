import type { ReactNode } from 'react';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { ApplyFilterResponse } from '@/features/scanner/worker/messages';
import type { FilterParams } from '@/shared/types/scanner';
import { NEUTRAL_FILTER } from '@/shared/types/scanner';
import { paperSelection } from '@/features/scanner/lib/paperFormats';
import type { PaperSelection } from '@/shared/types/paper';

/**
 * Group 4 / PR7 unit tests for `FilterPanel` (design section 3.4/5.4, spec
 * `filters`). Covers task 4.6:
 *  - preset selection calls `onChange` (never any warp-related function —
 *    `FilterPanel` does not even import `workerClient.warp`, so this is
 *    structurally guaranteed; the assertion proves it reaches `onChange`
 *    with the right value instead).
 *  - slider debounce: rapid slider changes coalesce into ONE batched
 *    `APPLY_FILTER` call after `FILTER.SLIDER_DEBOUNCE_MS` (design section
 *    3.4/4.3, mirrors `CornerEditor.runWarp`'s stale-result discipline).
 *  - "Apply to all" confirmation invokes `onApplyToAll` synchronously with
 *    ZERO worker calls (D7/D8, ADR-011 — instant recipe rewrite, no batch).
 */

const makeThumbnailMock = vi.fn();
vi.mock('@/features/scanner/lib/pageResources', () => ({
  makeThumbnail: (...args: unknown[]) => makeThumbnailMock(...args),
}));

const applyFilterMock = vi.fn();
vi.mock('@/features/scanner/lib/workerClient', () => ({
  getSharedWorkerClient: () => ({
    applyFilter: (...args: unknown[]) => applyFilterMock(...args),
  }),
}));

import { FilterPanel } from '@/features/scanner/components/FilterPanel';

function makeBitmap(width = 150, height = 200): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function fakeApplyFilterResponse(): ApplyFilterResponse {
  const image = { width: 150, height: 200, data: new Uint8ClampedArray(150 * 200 * 4) };
  return {
    id: 1,
    type: 'APPLY_FILTER_RESULT',
    results: [
      { kind: 'imagedata', image },
      { kind: 'imagedata', image },
      { kind: 'imagedata', image },
    ],
  };
}

function installCanvasShims(): void {
  const fakeCtx = {
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    putImageData: vi.fn(),
    filter: 'none',
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    'ImageData',
    class {
      width: number;
      height: number;
      data: Uint8ClampedArray;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
}

/** Controlled-component test harness — mirrors how `CornerEditor` owns `recipe.filter` and re-renders `FilterPanel` on every `onChange`. */
function Harness({
  baseBitmap,
  onChangeSpy,
  onApplyToAllSpy,
  initialFilter = NEUTRAL_FILTER,
  initialPaper,
  onPaperChangeSpy,
}: {
  readonly baseBitmap: ImageBitmap;
  readonly onChangeSpy: (filter: FilterParams) => void;
  readonly onApplyToAllSpy?: (filter: FilterParams) => void;
  readonly initialFilter?: FilterParams;
  readonly initialPaper?: PaperSelection;
  readonly onPaperChangeSpy?: (paper: PaperSelection) => void;
}): ReactNode {
  const [filter, setFilter] = useState<FilterParams>(initialFilter);
  const [paper, setPaper] = useState<PaperSelection | undefined>(initialPaper);
  return (
    <FilterPanel
      baseBitmap={baseBitmap}
      filter={filter}
      onChange={(next) => {
        setFilter(next);
        onChangeSpy(next);
      }}
      onApplyToAll={onApplyToAllSpy}
      paper={paper}
      onPaperChange={
        onPaperChangeSpy
          ? (next) => {
              setPaper(next);
              onPaperChangeSpy(next);
            }
          : undefined
      }
    />
  );
}

describe('FilterPanel (Group 4 / PR7, design section 3.4/5.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installCanvasShims();
    makeThumbnailMock.mockResolvedValue(makeBitmap());
    applyFilterMock.mockResolvedValue(fakeApplyFilterResponse());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('selecting a preset calls onChange with the preset applied — never a warp call', async () => {
    const onChangeSpy = vi.fn();
    render(<Harness baseBitmap={makeBitmap()} onChangeSpy={onChangeSpy} />);

    await waitFor(() => expect(makeThumbnailMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('filter-preset-enhanced'));

    expect(onChangeSpy).toHaveBeenCalledWith({ ...NEUTRAL_FILTER, preset: 'enhanced' });
    // FilterPanel has no access to warp at all (not imported), so reaching
    // onChange is the only possible effect of a preset tap — structurally
    // proves no re-warp can be triggered from this path (D4).
  });

  it('debounces worker preview calls: rapid slider changes coalesce into ONE APPLY_FILTER round-trip', async () => {
    vi.useFakeTimers();
    const onChangeSpy = vi.fn();
    render(<Harness baseBitmap={makeBitmap()} onChangeSpy={onChangeSpy} />);

    // Flush the thumbnail promise's microtask so the initial preview effect arms.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Let the FIRST (mount-triggered) batched preview fire and resolve.
    await act(async () => {
      vi.advanceTimersByTime(FILTER.SLIDER_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(applyFilterMock).toHaveBeenCalledTimes(1);
    applyFilterMock.mockClear();

    const brightnessInput = screen.getByTestId('brightness-input');

    // Three rapid changes, each well within the debounce window of the next.
    act(() => {
      fireEvent.change(brightnessInput, { target: { value: '10' } });
    });
    act(() => {
      vi.advanceTimersByTime(FILTER.SLIDER_DEBOUNCE_MS / 2);
    });
    act(() => {
      fireEvent.change(brightnessInput, { target: { value: '20' } });
    });
    act(() => {
      vi.advanceTimersByTime(FILTER.SLIDER_DEBOUNCE_MS / 2);
    });
    act(() => {
      fireEvent.change(brightnessInput, { target: { value: '30' } });
    });

    // `onChange` (the recipe write) fires on every change — instant, not debounced.
    expect(onChangeSpy).toHaveBeenCalledTimes(3);
    // No worker call yet — the debounce window keeps getting reset by each change.
    expect(applyFilterMock).not.toHaveBeenCalled();

    // Let the debounce window elapse once with no further changes.
    await act(async () => {
      vi.advanceTimersByTime(FILTER.SLIDER_DEBOUNCE_MS);
      await Promise.resolve();
    });

    // Exactly ONE batched call for the 3 rapid changes, using the FINAL value.
    expect(applyFilterMock).toHaveBeenCalledTimes(1);
    const [, variants] = applyFilterMock.mock.calls[0] as [unknown, Array<{ brightness: number }>];
    // 5 worker-rendered presets batched in one round-trip: enhanced + grayscale
    // (iOS/WebKit ctx.filter fix) plus the 3 adaptive presets. Only `original`
    // is excluded (drawn raw).
    expect(variants).toHaveLength(5);
    expect(variants.every((v) => v.brightness === 30)).toBe(true);
  });

  it('"Apply to all" confirmation writes instantly via onApplyToAll with ZERO worker calls', async () => {
    const onChangeSpy = vi.fn();
    const onApplyToAllSpy = vi.fn();
    render(
      <Harness baseBitmap={makeBitmap()} onChangeSpy={onChangeSpy} onApplyToAllSpy={onApplyToAllSpy} />,
    );

    await waitFor(() => expect(makeThumbnailMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('apply-to-all-button'));
    expect(screen.getByTestId('apply-to-all-confirm')).toBeTruthy();

    const callsBeforeConfirm = applyFilterMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('apply-to-all-confirm-button'));

    expect(onApplyToAllSpy).toHaveBeenCalledTimes(1);
    expect(onApplyToAllSpy).toHaveBeenCalledWith(NEUTRAL_FILTER);
    // Apply-to-all is a synchronous callback invocation only — it must not
    // have triggered any ADDITIONAL worker call itself.
    expect(applyFilterMock.mock.calls.length).toBe(callsBeforeConfirm);
    // The confirm step collapses back after confirming.
    expect(screen.queryByTestId('apply-to-all-confirm')).toBeNull();
  });

  it('does not render the "Apply to all" action when onApplyToAll is omitted', async () => {
    const onChangeSpy = vi.fn();
    render(<Harness baseBitmap={makeBitmap()} onChangeSpy={onChangeSpy} />);

    await waitFor(() => expect(makeThumbnailMock).toHaveBeenCalledTimes(1));

    expect(screen.queryByTestId('apply-to-all-button')).toBeNull();
  });

  it('shows detected confidence, persists a manual Oficio choice, and clears it back to automatic detection', async () => {
    const onChangeSpy = vi.fn();
    const onPaperChangeSpy = vi.fn();
    render(
      <Harness
        baseBitmap={makeBitmap()}
        onChangeSpy={onChangeSpy}
        onPaperChangeSpy={onPaperChangeSpy}
        initialPaper={paperSelection('letter', 'auto', 'high', 215.9 / 279.4)}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('paper-detection')).toHaveTextContent('Detected: Letter (high confidence)'));

    fireEvent.change(screen.getByTestId('paper-format-select'), { target: { value: 'oficio' } });

    expect(onPaperChangeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'legal', alias: 'oficio', source: 'manual', confidence: 'none' }),
    );
    expect(screen.getByTestId('paper-manual-selection')).toHaveTextContent('Manual: Oficio');
    expect(screen.getByTestId('paper-format-select')).toHaveValue('oficio');

    fireEvent.click(screen.getByTestId('paper-clear-auto'));

    expect(onPaperChangeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'letter', alias: 'letter', source: 'auto', confidence: 'high' }),
    );
    expect(screen.queryByTestId('paper-manual-selection')).toBeNull();
    expect(screen.getByTestId('paper-format-select')).toHaveValue('letter');
  });

  it('labels automatic A-series evidence as A4 probable in English', async () => {
    render(
      <Harness
        baseBitmap={makeBitmap()}
        onChangeSpy={vi.fn()}
        onPaperChangeSpy={vi.fn()}
        initialPaper={paperSelection('a4', 'auto', 'low', 210 / 297)}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('paper-detection')).toHaveTextContent('Detected: A4 probable (low confidence)'));
  });

  it('keeps a persisted canonical Legal alias selectable instead of leaving the control unmatched', async () => {
    const onChangeSpy = vi.fn();
    render(
      <Harness
        baseBitmap={makeBitmap()}
        onChangeSpy={onChangeSpy}
        onPaperChangeSpy={vi.fn()}
        initialPaper={paperSelection('legal', 'auto', 'high', 216 / 356)}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('paper-format-select')).toHaveValue('legal'));
    expect(screen.getByRole('option', { name: 'Legal' })).toHaveValue('legal');
  });
});
