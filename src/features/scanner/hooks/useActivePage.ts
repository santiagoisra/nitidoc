/**
 * `useActivePage` — layered-memory page lifecycle controller (design section
 * 2.2, D-MEM / ADR-007; Group 2 / PR5). Drives Materialize-on-capture,
 * Activate, Deactivate, and Re-warp against `DocumentSlice`'s synchronous
 * store actions (`documentSlice.ts`) plus the pure async helpers in
 * `pageResources.ts`.
 *
 * Scope: this hook owns compress/decode/close ORCHESTRATION only. It does
 * NOT own the camera, the OpenCV worker, or the WARP call itself — callers
 * (`CaptureScreen`/`ScannerScreen`/`CornerEditor`) capture the live
 * `originalBitmap`/`warpedBase` bitmaps (from the capture sequence / a
 * `WARP_RESULT`) and pass them into `materializeRawCapture`/`rewarpActivePage`.
 * This keeps the hook standalone and unit-testable without a real camera or
 * worker (design section 7, task group 2: "Verify peak-memory behavior on
 * iOS in apply" — deferred manual smoke; the async orchestration itself is
 * covered here).
 *
 * Consumed by `ScannerScreen`/`CornerEditor` since Group 1c (PR3+PR4):
 * `activatePage`/`deactivateActivePage` on entering/leaving the corner editor
 * for an already-materialized page (grid re-entry), `rewarpActivePage` when
 * that re-entry's corner edit is confirmed.
 *
 * Fase 2.3 (capture-ux-redesign.md, Unit 6): `materializeCapture` (the F1/
 * Fase-2 fresh-capture-editor "Materialize on capture" path) is REMOVED —
 * dead since Unit 3's `CaptureScreen` cutover, whose manual captures flow
 * through `materializeRawCapture` (below) instead, converted into pages by
 * the deferred `'processing'` batch step (`useBatchProcess.ts`), never by
 * this hook.
 */

import { useCallback } from 'react';
import { useScannerStore } from '@/features/scanner/store/scannerStore';
import type { ActivePageResources } from '@/features/scanner/store/documentSlice';
import { compressBitmapToJpeg, decodeBlobToBitmap, makeThumbnail } from '@/features/scanner/lib/pageResources';
import { FILTER } from '@/features/scanner/lib/filterConstants';
import type { EditRecipe } from '@/shared/types/scanner';

/**
 * Input for `materializeRawCapture` (Fase 2.3, capture-ux-redesign.md "Memory"
 * — deferred-processing capture flow, Unit 1/3). Deliberately light: only ONE
 * bitmap, since no warp/detect has happened yet at manual-capture time —
 * that runs later, in the `'processing'` batch step (`useBatchProcess.ts`).
 */
export interface MaterializeRawCaptureInput {
  /** `crypto.randomUUID()`, assigned by the caller before calling this — flows into the resulting page's id at conversion (Unit 4). */
  readonly id: string;
  /** Live, from the capture sequence (already cropped to the visible object-cover rect, D-4). OWNERSHIP TRANSFERS to this call — closed once compressed+thumbnailed. */
  readonly originalBitmap: ImageBitmap;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

export interface MaterializeRawCaptureResult {
  /** `'blocked-cap'` when the COMBINED `pages.length + rawCaptures.length` cap was already reached. The live bitmap is still released either way (never leaked). */
  readonly status: 'added' | 'blocked-cap';
}

/** Input for `rewarpActivePage` (design section 2.2 "Re-warp (active)"). */
export interface RewarpActivePageInput {
  readonly pageId: string;
  /** Fresh `warpedBase` returned by the caller's own WARP call. UNFILTERED (D4 — filter changes never re-warp). */
  readonly freshWarpedBase: ImageBitmap;
  /** The page's recipe with updated `corners`/`aspectRatio` already merged in by the caller. */
  readonly recipe: EditRecipe;
}

export interface UseActivePageResult {
  readonly activePageId: string | null;
  readonly activeWorking: ActivePageResources | null;
  readonly activeDirty: boolean;
  /**
   * True once the COMBINED `pages.length + rawCaptures.length` reaches
   * `FILTER.PAGE_CAP` (design section 2.3 / D-MEM, extended Fase 2.3: a raw
   * capture is a future page, so it counts toward the same hard cap).
   */
  readonly isAtCap: boolean;
  /** Convenience negation of `isAtCap` for capture-button gating (task 2.3). */
  readonly canAddPage: boolean;
  /**
   * Materialize a RAW capture (Fase 2.3, capture-ux-redesign.md "Memory"):
   * compresses the UNWARPED original to a blob, thumbnails it, `addRawCapture`s,
   * and closes the live bitmap. No warp/detect happens here — that is Unit 4's
   * `processing`-phase batch step.
   */
  readonly materializeRawCapture: (input: MaterializeRawCaptureInput) => Promise<MaterializeRawCaptureResult>;
  /** Activate a page (design section 2.2). Deactivates the current active page first, then decodes+materializes. */
  readonly activatePage: (pageId: string) => Promise<void>;
  /** Deactivate the current active page (design section 2.2). Recompresses ONLY if `activeDirty`, then closes bitmaps. */
  readonly deactivateActivePage: () => Promise<void>;
  /** Re-warp integration (design section 2.2). Synchronous — swaps `warpedBase`, marks dirty, writes the recipe. */
  readonly rewarpActivePage: (input: RewarpActivePageInput) => void;
}

export function useActivePage(): UseActivePageResult {
  const activePageId = useScannerStore((state) => state.activePageId);
  const activeWorking = useScannerStore((state) => state.activeWorking);
  const activeDirty = useScannerStore((state) => state.activeDirty);
  const pagesLength = useScannerStore((state) => state.pages.length);
  const rawCapturesLength = useScannerStore((state) => state.rawCaptures.length);

  const isAtCap = pagesLength + rawCapturesLength >= FILTER.PAGE_CAP;
  const canAddPage = !isAtCap;

  const materializeRawCapture = useCallback(
    async (input: MaterializeRawCaptureInput): Promise<MaterializeRawCaptureResult> => {
      const { pages, rawCaptures, addRawCapture } = useScannerStore.getState();

      if (pages.length + rawCaptures.length >= FILTER.PAGE_CAP) {
        // Defensive guard (mirrors `addPage`'s own "Cap reached" handling in
        // documentSlice.ts): release the live bitmap rather than leaking it,
        // even though nothing gets added.
        input.originalBitmap.close();
        return { status: 'blocked-cap' };
      }

      // Thumbnail + compress both derive from the UNWARPED original — no
      // warp has happened yet at capture time (design section "Memory").
      const [thumbnail, originalBlob] = await Promise.all([
        makeThumbnail(input.originalBitmap, FILTER.THUMBNAIL_MAX_EDGE),
        compressBitmapToJpeg(input.originalBitmap, FILTER.JPEG_QUALITY),
      ]);

      // Re-read rawCaptures.length right before appending (not the snapshot
      // from above) so the new raw's `order` is correct even if another
      // append happened while the compress/thumbnail work above was in
      // flight.
      const order = useScannerStore.getState().rawCaptures.length;
      addRawCapture({
        id: input.id,
        order,
        originalBlob,
        thumbnail,
        originalWidth: input.originalWidth,
        originalHeight: input.originalHeight,
      });

      // The live capture bitmap is no longer needed once compressed and
      // handed to addRawCapture.
      input.originalBitmap.close();

      return { status: 'added' };
    },
    [],
  );

  const deactivateActivePage = useCallback(async (): Promise<void> => {
    const state = useScannerStore.getState();
    const { activePageId: currentActivePageId, activeWorking: currentActiveWorking, activeDirty: isDirty } = state;

    if (currentActivePageId === null || currentActiveWorking === null) {
      return; // nothing active — no-op
    }

    if (isDirty) {
      const [thumbnail, warpedBlob] = await Promise.all([
        makeThumbnail(currentActiveWorking.warpedBase, FILTER.THUMBNAIL_MAX_EDGE),
        compressBitmapToJpeg(currentActiveWorking.warpedBase, FILTER.JPEG_QUALITY),
      ]);
      useScannerStore.getState().updatePageWarpBase(currentActivePageId, {
        warpedBlob,
        thumbnail,
        warpedWidth: currentActiveWorking.warpedBase.width,
        warpedHeight: currentActiveWorking.warpedBase.height,
      });
    }

    const { setActiveWorking, setActivePageId, setActiveDirty } = useScannerStore.getState();
    // Closes originalBitmap + warpedBase (store hygiene, design section 1.5).
    setActiveWorking(null);
    setActivePageId(null);
    setActiveDirty(false);
  }, []);

  const activatePage = useCallback(
    async (pageId: string): Promise<void> => {
      const state = useScannerStore.getState();
      if (state.activePageId === pageId && state.activeWorking?.pageId === pageId) {
        return; // already active — no-op
      }

      // Deactivate-previous-first (design section 2.2 "Activate" step 1).
      if (state.activePageId !== null) {
        await deactivateActivePage();
      }

      const page = useScannerStore.getState().pages.find((candidate) => candidate.id === pageId);
      if (!page) {
        throw new Error(`useActivePage.activatePage: no page found with id "${pageId}".`);
      }

      const [originalBitmap, warpedBase] = await Promise.all([
        decodeBlobToBitmap(page.originalBlob),
        decodeBlobToBitmap(page.warpedBlob),
      ]);

      const { setActiveWorking, setActivePageId, setActiveDirty } = useScannerStore.getState();
      // setActiveWorking closes any previous working bitmaps (design section
      // 1.5) — a no-op here in practice since deactivateActivePage already
      // cleared them above, but kept as the store's own safety net.
      setActiveWorking({ pageId, originalBitmap, warpedBase });
      setActivePageId(pageId);
      setActiveDirty(false);
    },
    [deactivateActivePage],
  );

  const rewarpActivePage = useCallback((input: RewarpActivePageInput): void => {
    const state = useScannerStore.getState();
    const prev = state.activeWorking;
    if (!prev || prev.pageId !== input.pageId) {
      // Defensive: nothing active to rewarp against (design section 2.2 —
      // re-warp only applies to the currently active page).
      return;
    }

    // Closes the old warpedBase (design section 1.5); originalBitmap is the
    // SAME object so setActiveWorking's close-before-overwrite skips it.
    state.setActiveWorking({
      pageId: prev.pageId,
      originalBitmap: prev.originalBitmap,
      warpedBase: input.freshWarpedBase,
    });
    state.setActiveDirty(true);
    // Filter changes NEVER re-warp (D4) — this path only runs for
    // corner/aspect edits, so the recipe write is always paired with a fresh
    // warpedBase from the caller's own WARP call.
    state.updateRecipe(input.pageId, input.recipe);
  }, []);

  return {
    activePageId,
    activeWorking,
    activeDirty,
    isAtCap,
    canAddPage,
    materializeRawCapture,
    activatePage,
    deactivateActivePage,
    rewarpActivePage,
  };
}
