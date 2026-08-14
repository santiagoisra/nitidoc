/**
 * Per-page filter panel (Group 4 / PR7; design section 3.4/5.4, ADR-008/009.
 * Rendered INLINE inside `CornerEditor`'s 'adjust' step since the Fase 2.1
 * punch-list restructure — item 2 moved this out of a `Sheet` modal into a
 * prominent, always-visible panel next to the aspect/rotate/flip controls,
 * instead of hidden behind a "Filters" button).
 * Fully CONTROLLED over its `filter` prop — mirrors `CornerEditor`'s own
 * controlled contract (design section 5.4): this component never touches
 * `DocumentSlice` directly. Preset/slider edits flow out via `onChange`,
 * which the caller folds into its own local `EditRecipe` (via
 * `editRecipe.withFilter`) exactly like `CornerEditor`'s rotate/flip
 * handlers — so filter edits are non-destructive and NEVER trigger a
 * re-warp (D4), and only reach the store once the caller's own Confirm flow
 * commits the recipe (`useActivePage.rewarpActivePage` -> `updateRecipe`).
 *
 * The one exception is "Apply to all" (D7/ADR-011): it is a DOCUMENT-WIDE
 * bulk rewrite across every page's recipe, not a per-session edit, so it is
 * exposed as a distinct `onApplyToAll` callback the caller wires directly to
 * `DocumentSlice.applyFilterToAll` — this keeps `CornerEditor` itself free of
 * any store import (it only forwards the callback prop) while still letting
 * this document-wide action reach the store from `ScannerScreen`.
 *
 * Preview routing (design section 3.4, spec `filters` "Preview de los 6
 * presets sin recompute full-res"): all 6 preset tiles render on a derived
 * ~150px thumbnail (`pageResources.makeThumbnail`), never on the full-res
 * base. The 3 CSS-routable presets (`original`/`enhanced`/`grayscale`) are
 * instant `ctx.filter` draws; the 3 adaptive presets (`bw`/`bw-high-contrast`/
 * `eco`) are computed in ONE batched `APPLY_FILTER` call sharing the same
 * base image (design section 4.3). Slider-driven re-batches are debounced at
 * `FILTER.SLIDER_DEBOUNCE_MS` (design section 3.4) using a monotonic sequence
 * guard, mirroring `CornerEditor.runWarp`'s stale-result discipline (design
 * section 4.5: "latest-wins-per-target owned by the caller").
 */

import type { ChangeEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/shared/ui';
import { useTranslation } from '@/shared/i18n';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import { buildCssFilter } from '@/features/scanner/lib/filterPipeline';
import { makeThumbnail } from '@/features/scanner/lib/pageResources';
import { getSharedWorkerClient } from '@/features/scanner/lib/workerClient';
import type { FilteredResult, FilterVariant, ImageDataLike } from '@/features/scanner/worker/messages';
import type { FilterParams, FilterPreset } from '@/shared/types/scanner';

const CSS_PRESETS: readonly FilterPreset[] = ['original', 'enhanced', 'grayscale'];
const ADAPTIVE_PRESETS: readonly FilterPreset[] = ['bw', 'bw-high-contrast', 'eco'];
const ALL_PRESETS: readonly FilterPreset[] = [...CSS_PRESETS, ...ADAPTIVE_PRESETS];
/**
 * Presets rendered by the OpenCV worker (baked pixels) — everything except
 * `original`. Mirrors `filterPipeline.needsWorker`: `enhanced`/`grayscale` are
 * here (not the CSS `ctx.filter` path) because that path is a silent no-op on
 * WebKit/iOS before Safari 17. Order matches the batched `APPLY_FILTER`
 * request/response indexing below.
 */
const WORKER_PRESETS: readonly FilterPreset[] = ALL_PRESETS.filter((preset) => preset !== 'original');

export interface FilterPanelProps {
  /** UNFILTERED warp base (design section 3, ADR-009) — a small thumbnail is derived from this for previews. */
  readonly baseBitmap: ImageBitmap;
  readonly filter: FilterParams;
  /** Fires on every preset tap / slider change. Caller folds this into its own recipe — never re-warps (D4). */
  readonly onChange: (filter: FilterParams) => void;
  /** Document-wide bulk rewrite (D7/ADR-011). Omit to hide the "Apply to all" action entirely. */
  readonly onApplyToAll?: (filter: FilterParams) => void;
  /**
   * `'grid'` (default): the full editor panel — 3-column preset grid +
   * brightness/contrast/sharpness sliders + optional "Apply to all"
   * (`CornerEditor`'s inline adjust step). `'row'`: a compact,
   * horizontally-scrollable strip of ONLY the preset tiles (the `AdjustScreen`
   * CamScanner-style filter bar) — title, sliders and "Apply to all" are
   * hidden so the strip stays a thin, swipeable row over the page preview.
   * Both variants share the exact same preset-preview pipeline (CSS-routable
   * tiles instant; adaptive tiles via the same debounced worker batch).
   */
  readonly orientation?: 'grid' | 'row';
}

/**
 * Extracts `ImageDataLike` from a bitmap WITHOUT closing it (unlike
 * `mainThreadImageData.bitmapToImageData`, which is written for one-shot
 * DETECT payloads that own their bitmap). The panel's thumbnail is reused
 * across every debounced worker call, so it must stay alive after
 * extraction — mirrors `CornerEditor`'s own private `extractImageData`.
 */
function extractImageData(bitmap: ImageBitmap): ImageDataLike {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('FilterPanel: failed to acquire 2d context to extract thumbnail ImageData.');
  }
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: imageData.width, height: imageData.height, data: imageData.data };
}

export function FilterPanel({
  baseBitmap,
  filter,
  onChange,
  onApplyToAll,
  orientation = 'grid',
}: FilterPanelProps): ReactNode {
  const { t } = useTranslation();
  const PRESET_LABELS: Record<FilterPreset, string> = {
    original: t('filter.presetOriginal'),
    enhanced: t('filter.presetEnhanced'),
    grayscale: t('filter.presetGrayscale'),
    bw: t('filter.presetBw'),
    'bw-high-contrast': t('filter.presetBwHighContrast'),
    eco: t('filter.presetEco'),
  };
  // Close-before-overwrite hygiene for the derived thumbnail (design section
  // 1.5/7), held in a ref (not state) so cleanup/replacement always sees the
  // CURRENT live bitmap rather than a stale render's closure.
  const thumbnailRef = useRef<ImageBitmap | null>(null);
  const [thumbnailVersion, setThumbnailVersion] = useState(0);

  const applyThumbnail = useCallback((next: ImageBitmap | null) => {
    const prev = thumbnailRef.current;
    if (prev && prev !== next) {
      prev.close();
    }
    thumbnailRef.current = next;
    setThumbnailVersion((v) => v + 1);
  }, []);

  // Same ref+version pattern for the batched adaptive-preset results — each
  // entry may carry an `ImageBitmap` that must be closed before replacement
  // (design section 1.5 hygiene) or on unmount.
  const adaptiveResultsRef = useRef<Partial<Record<FilterPreset, FilteredResult>>>({});
  const [adaptiveVersion, setAdaptiveVersion] = useState(0);

  const applyAdaptiveResults = useCallback((next: Partial<Record<FilterPreset, FilteredResult>>) => {
    const prev = adaptiveResultsRef.current;
    for (const preset of WORKER_PRESETS) {
      const oldResult = prev[preset];
      const nextResult = next[preset];
      if (oldResult && oldResult.kind === 'bitmap') {
        const stillSame = nextResult?.kind === 'bitmap' && nextResult.bitmap === oldResult.bitmap;
        if (!stillSame) {
          oldResult.bitmap.close();
        }
      }
    }
    adaptiveResultsRef.current = next;
    setAdaptiveVersion((v) => v + 1);
  }, []);

  // Monotonic sequence guards (mirrors `CornerEditor.runWarp`'s C1/C2
  // pattern, design section 4.5 "latest-wins-per-target owned by the
  // caller"): a stale thumbnail or a superseded batched preview must never
  // overwrite a newer one, and any bitmap it carries must be closed instead
  // of leaked.
  const thumbnailSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const [confirmingApplyAll, setConfirmingApplyAll] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Regenerate the ~150px thumbnail whenever the base bitmap changes (design
  // section 2.3/3.4) — never re-derive previews from the full-res base.
  useEffect(() => {
    const seq = (thumbnailSeqRef.current += 1);
    void makeThumbnail(baseBitmap, FILTER.THUMBNAIL_MAX_EDGE)
      .then((bitmap) => {
        if (!mountedRef.current || seq !== thumbnailSeqRef.current) {
          bitmap.close();
          return;
        }
        applyThumbnail(bitmap);
      })
      .catch(() => {
        // Thumbnail generation failure leaves the panel without previews —
        // non-fatal; preset/slider selection still works via `onChange`.
      });
  }, [baseBitmap, applyThumbnail]);

  // Release whatever thumbnail/adaptive bitmaps are alive on unmount.
  useEffect(
    () => () => {
      thumbnailRef.current?.close();
      thumbnailRef.current = null;
      for (const preset of WORKER_PRESETS) {
        const result = adaptiveResultsRef.current[preset];
        if (result?.kind === 'bitmap') {
          result.bitmap.close();
        }
      }
      adaptiveResultsRef.current = {};
    },
    [],
  );

  // Batched adaptive-preset preview (design section 4.3, spec "Preview de
  // los 6 presets sin recompute full-res"): re-renders all 3 adaptive tiles
  // in ONE `APPLY_FILTER` round-trip, debounced at `FILTER.SLIDER_DEBOUNCE_MS`
  // whenever the thumbnail or the brightness/contrast/sharpness sliders
  // change (preset switching alone does not need a re-batch: the same 3
  // adaptive tiles are always shown regardless of which preset is currently
  // selected).
  useEffect(() => {
    const thumbnail = thumbnailRef.current;
    if (!thumbnail) return;

    const timer = setTimeout(() => {
      const seq = (previewSeqRef.current += 1);
      const image = extractImageData(thumbnail);
      const variants: FilterVariant[] = WORKER_PRESETS.map((preset) => ({
        preset,
        brightness: filter.brightness,
        contrast: filter.contrast,
        sharpness: filter.sharpness,
      }));
      const outputBitmap = typeof OffscreenCanvas !== 'undefined';

      void getSharedWorkerClient()
        .applyFilter(image, variants, outputBitmap)
        .then((response) => {
          if (!mountedRef.current || seq !== previewSeqRef.current) {
            // Superseded by a newer debounced request — never let a stale
            // result leak its bitmaps (design section 4.5).
            for (const result of response.results) {
              if (result.kind === 'bitmap') {
                result.bitmap.close();
              }
            }
            return;
          }
          const next: Partial<Record<FilterPreset, FilteredResult>> = {};
          WORKER_PRESETS.forEach((preset, index) => {
            const result = response.results[index];
            if (result) {
              next[preset] = result;
            }
          });
          applyAdaptiveResults(next);
        })
        .catch(() => {
          // Preview failure leaves the adaptive tiles blank — non-fatal for
          // editing; the user can still pick any preset via `onChange`.
        });
    }, FILTER.SLIDER_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `thumbnailVersion` re-arms this effect once a fresh thumbnail lands;
    // `adaptiveVersion` is intentionally NOT a dependency (it is this
    // effect's own output).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbnailVersion, filter.brightness, filter.contrast, filter.sharpness, applyAdaptiveResults]);

  const handleSelectPreset = useCallback(
    (preset: FilterPreset) => {
      onChange({ ...filter, preset });
    },
    [filter, onChange],
  );

  const handleBrightnessChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ ...filter, brightness: Number(event.target.value) });
    },
    [filter, onChange],
  );

  const handleContrastChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ ...filter, contrast: Number(event.target.value) });
    },
    [filter, onChange],
  );

  const handleSharpnessChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ ...filter, sharpness: Number(event.target.value) });
    },
    [filter, onChange],
  );

  const handleApplyToAllClick = useCallback(() => {
    setConfirmingApplyAll(true);
  }, []);

  const handleApplyToAllCancel = useCallback(() => {
    setConfirmingApplyAll(false);
  }, []);

  const handleApplyToAllConfirm = useCallback(() => {
    // D7/D8, ADR-011: instant recipe rewrite across every page, NO worker
    // batch — this is a plain callback invocation, never touches
    // `getSharedWorkerClient()`.
    onApplyToAll?.(filter);
    setConfirmingApplyAll(false);
  }, [filter, onApplyToAll]);

  // Re-render the tiles whenever the thumbnail or adaptive results change —
  // these version counters exist purely to trigger a re-render off ref
  // mutations (the refs themselves hold the actual bitmaps/results).
  void thumbnailVersion;
  void adaptiveVersion;
  const thumbnail = thumbnailRef.current;

  const presetTiles = ALL_PRESETS.map((preset) => {
    const isWorkerRendered = WORKER_PRESETS.includes(preset);
    const cssFilter = isWorkerRendered ? 'none' : buildCssFilter({ ...filter, preset });
    const adaptiveResult = adaptiveResultsRef.current[preset];
    return (
      <PresetTile
        key={preset}
        preset={preset}
        label={PRESET_LABELS[preset]}
        active={filter.preset === preset}
        thumbnail={thumbnail}
        cssFilter={isWorkerRendered ? null : cssFilter}
        adaptiveResult={isWorkerRendered ? adaptiveResult : undefined}
        onSelect={() => handleSelectPreset(preset)}
        sizeClass={orientation === 'row' ? 'w-14 shrink-0' : undefined}
      />
    );
  });

  if (orientation === 'row') {
    // CamScanner-style filter strip (AdjustScreen): a thin, horizontally
    // scrollable row of just the preset tiles — no title/sliders/apply-to-all.
    return (
      <div
        className="flex w-full gap-2 overflow-x-auto px-1 pb-1 pt-2"
        data-testid="filter-preset-row"
        aria-label={t('filter.title')}
      >
        {presetTiles}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4" data-testid="filter-panel">
      <h3 className="text-sm font-medium text-text">{t('filter.title')}</h3>
      <div className="grid grid-cols-3 gap-2" data-testid="filter-preset-grid">
        {presetTiles}
      </div>

      <label className="flex flex-col gap-1 text-sm text-text-muted" data-testid="filter-slider-brightness">
        {t('filter.brightness')}
        <input
          type="range"
          min={-100}
          max={100}
          value={filter.brightness}
          onChange={handleBrightnessChange}
          aria-label={t('filter.brightness')}
          data-testid="brightness-input"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-text-muted" data-testid="filter-slider-contrast">
        {t('filter.contrast')}
        <input
          type="range"
          min={-100}
          max={100}
          value={filter.contrast}
          onChange={handleContrastChange}
          aria-label={t('filter.contrast')}
          data-testid="contrast-input"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-text-muted" data-testid="filter-slider-sharpness">
        {t('filter.sharpness')}
        <input
          type="range"
          min={0}
          max={100}
          value={filter.sharpness}
          onChange={handleSharpnessChange}
          aria-label={t('filter.sharpness')}
          data-testid="sharpness-input"
        />
      </label>

      {onApplyToAll && (
        <div className="flex flex-col gap-2 border-t border-text-muted/20 pt-4">
          {!confirmingApplyAll ? (
            <Button
              type="button"
              variant="secondary"
              onClick={handleApplyToAllClick}
              data-testid="apply-to-all-button"
            >
              {t('filter.applyToAll')}
            </Button>
          ) : (
            <div className="flex flex-col gap-2" data-testid="apply-to-all-confirm">
              <p className="text-sm text-text-muted">
                {t('filter.applyToAllConfirmText')}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleApplyToAllCancel}
                  data-testid="apply-to-all-cancel"
                >
                  {t('filter.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleApplyToAllConfirm}
                  data-testid="apply-to-all-confirm-button"
                >
                  {t('filter.applyToAllConfirmButton')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface PresetTileProps {
  readonly preset: FilterPreset;
  readonly label: string;
  readonly active: boolean;
  readonly thumbnail: ImageBitmap | null;
  /** CSS `ctx.filter` string, or `null` for an adaptive preset (rendered from `adaptiveResult` instead). */
  readonly cssFilter: string | null;
  readonly adaptiveResult: FilteredResult | undefined;
  readonly onSelect: () => void;
  /** Extra width/shrink classes for the horizontal-strip variant (default lets the grid size the tile). */
  readonly sizeClass?: string;
}

/**
 * One preview tile (design section 3.4). CSS-routable presets draw the
 * shared thumbnail through `ctx.filter` (instant, main thread); adaptive
 * presets draw the worker's precomputed `FilteredResult` for this preset
 * (`bitmap` via `drawImage`, or `imagedata` via `putImageData` — design
 * section 8 parity, mirrors `CornerEditor`'s WARP_RESULT/WARP_RESULT_IMAGEDATA
 * handling).
 */
function PresetTile({ preset, label, active, thumbnail, cssFilter, adaptiveResult, onSelect, sizeClass }: PresetTileProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (cssFilter !== null) {
      if (!thumbnail) return;
      canvas.width = thumbnail.width;
      canvas.height = thumbnail.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.filter = cssFilter;
      ctx.drawImage(thumbnail, 0, 0);
      ctx.filter = 'none';
      return;
    }

    if (!adaptiveResult) return;
    if (adaptiveResult.kind === 'bitmap') {
      canvas.width = adaptiveResult.bitmap.width;
      canvas.height = adaptiveResult.bitmap.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(adaptiveResult.bitmap, 0, 0);
    } else {
      canvas.width = adaptiveResult.image.width;
      canvas.height = adaptiveResult.image.height;
      const pixelData = new Uint8ClampedArray(adaptiveResult.image.data);
      const imageData = new ImageData(pixelData, adaptiveResult.image.width, adaptiveResult.image.height);
      ctx.putImageData(imageData, 0, 0);
    }
  }, [thumbnail, cssFilter, adaptiveResult]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-testid={`filter-preset-${preset}`}
      className={`flex flex-col items-center gap-1 rounded-lg p-1 transition-all duration-[250ms]
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light
        ${sizeClass ?? ''} ${
          active
            ? '-translate-y-[5px] shadow-[0_8px_18px_rgba(46,196,173,0.35)] ring-2 ring-primary'
            : 'ring-1 ring-text/10'
        }`}
    >
      <canvas ref={canvasRef} className="aspect-[3/4] w-full rounded bg-surface object-cover" aria-hidden="true" />
      <span className={`text-xs ${active ? 'font-semibold text-primary' : 'text-text-muted'}`}>{label}</span>
    </button>
  );
}
