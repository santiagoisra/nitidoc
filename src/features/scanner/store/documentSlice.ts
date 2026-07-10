import type { EditRecipe, FilterParams } from '@/shared/types/scanner';
import { FILTER } from '@/features/scanner/lib/filterConstants';

/**
 * `DocumentSlice` — the multipage document model (Fase 2, design section
 * 1.2-1.5). Replaces F1's single-page capture slice. This file owns
 * ONLY the state shape + SYNCHRONOUS store actions; it does not decode,
 * compress, or otherwise perform async work — that lives in the
 * `useActivePage` controller (Group 2) and `pageResources.ts` helpers.
 *
 * Layered memory model (D-MEM, ADR-007): inactive pages retain a ~150px
 * `thumbnail` bitmap + JPEG `originalBlob`/`warpedBlob`; the ONE active page
 * is materialized full-res in `activeWorking`. "One live page" is a
 * type-level invariant — the slice literally has room for only one
 * `ActivePageResources`, not a convention enforced by discipline.
 *
 * Wired into `scannerStore.ts` as the SOLE store slice governing the
 * document/capture model (Group 1c / PR3, ADR-010) — F1's single-page capture
 * slice has been removed; `ScannerScreen`/`CornerEditor` consume
 * this slice's state/actions directly (optionally via the `useActivePage`
 * controller, Group 2) instead of the old `originalFrame`/`warpedImage`/
 * `recipe`/`phase` fields.
 */

/** Per-page record (design section 1.2). */
export interface DocumentPage {
  /** `crypto.randomUUID()`, assigned by the caller (capture controller) before `addPage`. */
  readonly id: string;
  /** Dense 0..n-1, always re-indexed on any mutation that changes page count/order. */
  readonly order: number;
  /** Includes `filter` (design section 1.1) — single source of truth per page (D1). */
  readonly recipe: EditRecipe;

  // Layered retention (D-MEM). These persist for INACTIVE pages; the live
  // full-res bitmaps for the active page live in `activeWorking`, NOT here.
  /** ~150px longest edge, UNFILTERED warp base, cached once at confirm (D6). */
  readonly thumbnail: ImageBitmap;
  /** JPEG q0.85 of the full-res original (decode on-demand for re-warp). */
  readonly originalBlob: Blob;
  /** JPEG q0.85 of the UNFILTERED warp base (export/preview baseline, D4). */
  readonly warpedBlob: Blob;

  // Dimensions kept so callers can size canvases / map corner coordinates
  // WITHOUT decoding a blob.
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly warpedWidth: number;
  readonly warpedHeight: number;

  /**
   * Deferred-processing redesign (Fase 2.3, D-2/capture-ux-redesign.md).
   * `true` when the per-page detect->warp step (Unit 4) had to fall back to
   * `frameCorners` — either detection returned no quad or the detected quad
   * was non-convex. Optional/back-compatible: pages created by the F1/Fase 2
   * interactive corner-editor flow never set this. Surfaced as a grid badge
   * so the user knows to double-check that page's corners.
   */
  readonly needsReview?: boolean;
}

/**
 * A manually-captured, not-yet-processed shot (Fase 2.3, capture-ux-redesign.md
 * "Data model — RawCapture (light) vs DocumentPage (terminal)"). Accumulates
 * during the persistent `capturing` phase; converted 1:1 into a `DocumentPage`
 * (detect->warp->thumbnail) during the `processing` phase (Unit 4). Deliberately
 * lighter than `DocumentPage`: no `recipe`/`warpedBlob` yet, since no warp has
 * run — the thumbnail is derived from the UNWARPED original so the capture
 * count tile can render instantly without waiting on detection.
 */
export interface RawCapture {
  /** `crypto.randomUUID()`; flows straight into the resulting `DocumentPage.id` at conversion (Unit 4). */
  readonly id: string;
  /** Dense 0..n-1 within `rawCaptures`, re-indexed on any removal (mirrors `DocumentPage.order`). */
  readonly order: number;
  /** JPEG q `FILTER.JPEG_QUALITY` of the (cropped) full-res original. Reused BY REFERENCE into the page's `originalBlob` at conversion — no re-compress (design section "Data model"). */
  readonly originalBlob: Blob;
  /** ~150px longest edge, from the UNWARPED original (design section "Data model") — only used for the capture-count tile, never for detect/warp. */
  readonly thumbnail: ImageBitmap;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

/**
 * The ONLY full-res materialization allowed at any moment (design section
 * 1.3). Because the slice holds at most one of these, "one live page" is a
 * TYPE-LEVEL invariant, not a convention. Peak live full-res memory is
 * bounded to ~1 page (~90MB) regardless of document length (D-MEM).
 */
export interface ActivePageResources {
  readonly pageId: string;
  /** Decoded from `originalBlob` (~48MB @ 12MP), used for re-warp. */
  readonly originalBitmap: ImageBitmap;
  /** UNFILTERED warp base (~tens MB), used for filter preview. */
  readonly warpedBase: ImageBitmap;
}

/**
 * Fase 2.3 (capture-ux-redesign.md "Phase model"): `'warping'` is renamed to
 * `'processing'` (a transient BATCH step over `rawCaptures`, not a single
 * page) and `'tray'` is dropped — `'capturing'` now covers the persistent
 * full-bleed camera screen that used to be split across `'capturing'`
 * (transient, mid-frame-grab) and `'tray'` (resting, camera open). Unit 3
 * rewrites the capture flow to match; until then, `ScannerScreen`'s existing
 * F1/Fase-2 phase-driven rendering keeps working unchanged by mapping every
 * former `'tray'` transition onto `'idle'` (see that file's own comments) —
 * both already rendered the exact same camera+tray view.
 */
export type DocumentPhase =
  | 'idle'
  | 'capturing'
  | 'processing'
  | 'editing-corners'
  | 'grid' // reorder / delete / per-page filter
  | 'done';

export interface DocumentSlice {
  readonly pages: readonly DocumentPage[];
  /**
   * Deferred-processing redesign (Fase 2.3): manual captures accumulate here
   * during `'capturing'` and are converted 1:1 into `pages` during
   * `'processing'` (Unit 4). Empty outside that flow (e.g. the current F1/Fase
   * 2 interactive corner-editor flow never populates it — Unit 3 wires it).
   */
  readonly rawCaptures: readonly RawCapture[];
  readonly activePageId: string | null;
  /** The single live working set for `activePageId`, or null when no page is materialized. */
  readonly activeWorking: ActivePageResources | null;
  /** True when the active page was re-warped since activation → warpedBlob+thumbnail must be regenerated on deactivate. */
  readonly activeDirty: boolean;
  readonly selectedPageIds: readonly string[];
  /** Undo window: retains the deleted page (resources UNRELEASED) until the 5s toast expires. */
  readonly pendingDeletion: DocumentPage | null;
  readonly phase: DocumentPhase;
}

export interface DocumentActions {
  // ── page lifecycle ──────────────────────────────────────────────
  /** Appends an already-compressed page (blobs + thumbnail produced by the capture controller). Enforces the 30 cap (defensive no-op above it). */
  readonly addPage: (page: DocumentPage) => void;

  // ── raw captures (Fase 2.3, capture-ux-redesign.md) ────────────────
  /**
   * Appends an already-compressed raw capture (blob + thumbnail produced by
   * `useActivePage.materializeRawCapture`). Defensive no-op at the COMBINED
   * cap `pages.length + rawCaptures.length >= FILTER.PAGE_CAP` — mirrors
   * `addPage`'s own guard, but counts both collections since a raw capture
   * is a future page.
   */
  readonly addRawCapture: (raw: RawCapture) => void;
  /** Closes every remaining raw capture's `thumbnail`, then empties `rawCaptures`. Used by the processing loop's defensive cleanup and by full teardown. */
  readonly clearRawCaptures: () => void;
  /** Retake-last: closes the LAST raw capture's `thumbnail` and pops it (no-op when empty). */
  readonly removeLastRawCapture: () => void;
  /** Closes the given raw capture's `thumbnail` and removes it by id (no-op when not found), re-indexing the rest densely. Used by the processing loop as it converts each raw into a page. */
  readonly removeRawCapture: (id: string) => void;

  readonly setActivePageId: (id: string | null) => void;
  /** Swaps the live working set. Closes the PREVIOUS working set's bitmaps before overwrite (hygiene, mirrors setWarpedImage). */
  readonly setActiveWorking: (res: ActivePageResources | null) => void;
  readonly setActiveDirty: (dirty: boolean) => void;

  // ── edits ───────────────────────────────────────────────────────
  /** Replaces one page's recipe (corners/aspect/rotation/flip/filter). JSON only. */
  readonly updateRecipe: (pageId: string, recipe: EditRecipe) => void;
  /** After a dirty deactivate: replaces the cached warp base (closes old thumbnail before overwrite). */
  readonly updatePageWarpBase: (
    pageId: string,
    patch: Pick<DocumentPage, 'warpedBlob' | 'thumbnail' | 'warpedWidth' | 'warpedHeight'>,
  ) => void;
  /** D7/D8: writes `filter` into every page's recipe. Instant, no bitmap work. */
  readonly applyFilterToAll: (filter: FilterParams) => void;

  // ── ordering ────────────────────────────────────────────────────
  /** onDragEnd: caller passes the FULL new id order; slice re-indexes `order` densely (no partial patch). */
  readonly reorderPages: (orderedIds: readonly string[]) => void;

  // ── deletion + undo ─────────────────────────────────────────────
  /**
   * Moves the page to `pendingDeletion`, removes it from `pages`, re-indexes.
   * Closes `activeWorking` if that page was active. Resources otherwise
   * UNRELEASED. If a deletion is already pending (only one slot exists), the
   * older pending page is HARD released first (design section 1.5: "a second
   * deletePage while one is pending" row).
   */
  readonly deletePage: (pageId: string) => void;
  /** Undo: reinserts `pendingDeletion` at its `order`, re-indexes, clears the slot. */
  readonly restorePage: () => void;
  /** Toast expiry / superseded: HARD release — close thumbnail, drop blobs, clear the slot. */
  readonly hardReleaseDeletion: () => void;

  // ── selection + phase ───────────────────────────────────────────
  readonly setSelectedPageIds: (ids: readonly string[]) => void;
  readonly setPhase: (phase: DocumentPhase) => void;
  /** Full teardown: close activeWorking, close all thumbnails, close pendingDeletion, reset to initial. */
  readonly resetDocument: () => void;
}

export const initialDocumentSlice: DocumentSlice = {
  pages: [],
  rawCaptures: [],
  activePageId: null,
  activeWorking: null,
  activeDirty: false,
  selectedPageIds: [],
  pendingDeletion: null,
  phase: 'idle',
};

/**
 * Re-indexes an array of order-bearing items (pages OR raw captures) to a
 * dense `order` of 0..n-1, preserving the given array's order. Used
 * everywhere pages/raw captures are inserted/removed so no mutation ever
 * leaves gaps or duplicate `order` values.
 */
function reindex<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => (item.order === index ? item : { ...item, order: index }));
}

/**
 * Zustand slice-creator (standard "slices pattern"). This file never imports
 * `ScannerStore` and stays free of circular module references — no action
 * here needs to read a field outside `DocumentSlice`'s own shape, so
 * `set`/`get` are typed purely in terms of `DocumentSlice`. `scannerStore.ts`
 * wires this in via a thin adapter around its combined `set`/`get` (Group 1c:
 * `DocumentSlice.phase`/`setPhase` is now the SOLE `phase` owner in the
 * combined store — no adapter/`Omit<>` needed anymore).
 */
export function createDocumentActions(
  set: (partial: Partial<DocumentSlice> | ((state: DocumentSlice) => Partial<DocumentSlice>)) => void,
  // Accepted for API symmetry with zustand's `StateCreator` shape (and future
  // actions that may need direct reads); unused today since every action
  // reads state via the `set` updater's `state` argument. Prefixed with `_`
  // so `noUnusedParameters` doesn't flag it.
  _get: () => DocumentSlice,
): DocumentActions {
  return {
    addPage: (page) =>
      set((state) => {
        if (state.pages.length >= FILTER.PAGE_CAP) {
          // Defensive no-op: the capture controller is expected to block
          // BEFORE capturing (spec "Cap duro de 30 paginas alcanzado"); this
          // guard exists so the store itself can never exceed the cap even
          // if a caller forgets the pre-check.
          return {};
        }
        return { pages: [...state.pages, page] };
      }),

    addRawCapture: (raw) =>
      set((state) => {
        if (state.pages.length + state.rawCaptures.length >= FILTER.PAGE_CAP) {
          // Defensive no-op (mirrors `addPage`'s own guard): the capture
          // controller (Unit 3) is expected to block BEFORE capturing via
          // the combined `pages.length + rawCaptures.length` cap. Ownership
          // of the caller's live bitmap is NOT this action's concern — the
          // async orchestrator (`useActivePage.materializeRawCapture`) owns
          // closing it on a blocked cap, same split of responsibility as
          // `addPage` has with its own caller.
          return {};
        }
        return { rawCaptures: [...state.rawCaptures, raw] };
      }),

    clearRawCaptures: () =>
      set((state) => {
        state.rawCaptures.forEach((raw) => raw.thumbnail.close());
        return { rawCaptures: [] };
      }),

    removeLastRawCapture: () =>
      set((state) => {
        if (state.rawCaptures.length === 0) return {};
        const last = state.rawCaptures[state.rawCaptures.length - 1] as RawCapture;
        last.thumbnail.close();
        return { rawCaptures: state.rawCaptures.slice(0, -1) };
      }),

    removeRawCapture: (id) =>
      set((state) => {
        const target = state.rawCaptures.find((raw) => raw.id === id);
        if (!target) return {};
        target.thumbnail.close();
        return { rawCaptures: reindex(state.rawCaptures.filter((raw) => raw.id !== id)) };
      }),

    setActivePageId: (id) => set({ activePageId: id }),

    setActiveWorking: (res) =>
      set((state) => {
        // Close-before-overwrite hygiene (design section 1.5), mirrors
        // F1's legacy `setWarpedImage`/`setOriginalFrame` actions. Checked
        // independently per bitmap field since `res` may reuse one of the
        // two prior bitmaps in principle.
        const prev = state.activeWorking;
        if (prev && prev.originalBitmap !== res?.originalBitmap) {
          prev.originalBitmap.close();
        }
        if (prev && prev.warpedBase !== res?.warpedBase) {
          prev.warpedBase.close();
        }
        return { activeWorking: res };
      }),

    setActiveDirty: (dirty) => set({ activeDirty: dirty }),

    updateRecipe: (pageId, recipe) =>
      set((state) => ({
        pages: state.pages.map((page) => (page.id === pageId ? { ...page, recipe } : page)),
      })),

    updatePageWarpBase: (pageId, patch) =>
      set((state) => ({
        pages: state.pages.map((page) => {
          if (page.id !== pageId) return page;
          // Close the page's PREVIOUS thumbnail before assigning the new one
          // (design section 1.5). `warpedBlob` is GC'd (no close() on Blob).
          if (page.thumbnail !== patch.thumbnail) {
            page.thumbnail.close();
          }
          return { ...page, ...patch };
        }),
      })),

    applyFilterToAll: (filter) =>
      set((state) => ({
        pages: state.pages.map((page) => ({ ...page, recipe: { ...page.recipe, filter } })),
      })),

    reorderPages: (orderedIds) =>
      set((state) => {
        const byId = new Map(state.pages.map((page) => [page.id, page] as const));
        const reordered: DocumentPage[] = [];
        orderedIds.forEach((id) => {
          const page = byId.get(id);
          if (page) reordered.push(page);
        });
        return { pages: reindex(reordered) };
      }),

    deletePage: (pageId) =>
      set((state) => {
        const target = state.pages.find((page) => page.id === pageId);
        if (!target) return {};

        // A second delete while one is already pending must not silently
        // drop the older pendingDeletion slot's resources — hard-release it
        // first (design section 1.5), since only one pendingDeletion slot
        // exists at a time.
        if (state.pendingDeletion && state.pendingDeletion.id !== target.id) {
          state.pendingDeletion.thumbnail.close();
        }

        const remaining = reindex(state.pages.filter((page) => page.id !== pageId));
        const patch: Partial<DocumentSlice> = { pages: remaining, pendingDeletion: target };

        if (state.activePageId === pageId && state.activeWorking) {
          state.activeWorking.originalBitmap.close();
          state.activeWorking.warpedBase.close();
          return {
            ...patch,
            activeWorking: null,
            activePageId: null,
            activeDirty: false,
          };
        }

        return patch;
      }),

    restorePage: () =>
      set((state) => {
        if (!state.pendingDeletion) return {};
        const page = state.pendingDeletion;
        const insertIndex = Math.min(page.order, state.pages.length);
        const withInserted = [...state.pages];
        withInserted.splice(insertIndex, 0, page);
        return { pages: reindex(withInserted), pendingDeletion: null };
      }),

    hardReleaseDeletion: () =>
      set((state) => {
        if (!state.pendingDeletion) return {};
        state.pendingDeletion.thumbnail.close();
        return { pendingDeletion: null };
      }),

    setSelectedPageIds: (ids) => set({ selectedPageIds: ids }),

    setPhase: (phase) => set({ phase }),

    resetDocument: () =>
      set((state) => {
        // Full teardown (design section 1.5, extended Fase 2.3 for
        // `rawCaptures`): close activeWorking, every page's thumbnail, every
        // raw capture's thumbnail, and pendingDeletion's thumbnail before
        // resetting — never leave a live bitmap for the GC to eventually
        // reclaim.
        if (state.activeWorking) {
          state.activeWorking.originalBitmap.close();
          state.activeWorking.warpedBase.close();
        }
        state.pages.forEach((page) => page.thumbnail.close());
        state.rawCaptures.forEach((raw) => raw.thumbnail.close());
        if (state.pendingDeletion) {
          state.pendingDeletion.thumbnail.close();
        }
        return { ...initialDocumentSlice };
      }),
  };
}
