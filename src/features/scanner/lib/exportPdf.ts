/**
 * PDF export (Fase 2.1 punch-list item 4, "export all captured pages to a
 * PDF and download/save it on the device").
 *
 * For each page (processed in `order`), decodes the UNFILTERED full-res
 * `warpedBlob` (the export baseline, design section 2.3/2.4) and bakes the
 * page's `recipe.filter` through the SAME two-stage routing the on-screen
 * editor uses (`filterPipeline.needsWorker` — worker RPC for adaptive/
 * sharpened presets, Canvas2D `ctx.filter` otherwise, design section 3.1/
 * 4.4/ADR-008) — but at FULL resolution, not the ~150px preview thumbnail.
 * `recipe.rotation`/`flipH`/`flipV` are then applied as REAL pixel
 * transforms on a canvas (CSS transforms are presentation-only and never
 * touch exported pixels). One jsPDF page is added per document page, sized
 * to that page's own (possibly rotated) aspect ratio so no image is
 * stretched or letterboxed. Triggers the browser download / mobile share
 * sheet via `jsPDF.save`.
 *
 * `jspdf` is dynamically imported so it lands in its own lazy chunk — this
 * module is only ever reached from an explicit user tap on "Export PDF",
 * never from the initial render path (F1's <200KB gzip initial-bundle
 * budget).
 */

import { buildCssFilter, needsWorker } from '@/features/scanner/lib/filterPipeline';
import { decodeBlobToBitmap } from '@/features/scanner/lib/pageResources';
import { deliverPdf } from '@/features/scanner/lib/savePdf';
import { getSharedWorkerClient } from '@/features/scanner/lib/workerClient';
import { getPaperFormat } from '@/features/scanner/lib/paperFormats';
import type { DocumentPage } from '@/features/scanner/store/documentSlice';
import type { EditRecipe } from '@/shared/types/scanner';
import type { FilterVariant, ImageDataLike } from '@/features/scanner/worker/messages';

/** Quality for the exported JPEG frames embedded in the PDF — higher than the ~0.85 cache quality since this is the final deliverable. */
const PDF_JPEG_QUALITY = 0.9;
/** Mirrors jsPDF 4.2.1's legacy `unit: 'px'` page MediaBox without claiming a physical scale. */
const LEGACY_MM_PER_PIXEL = 25.4 / 54;

export interface RenderedPage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Releases a scratch `<canvas>`'s backing store immediately (F1 hygiene pattern already used by `pageResources.ts`). */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('exportPdf: failed to acquire a 2d canvas context.');
  }
  return ctx;
}

/** Output dimensions after `rotation` — 90/270 swap width and height. */
function orientedSize(
  width: number,
  height: number,
  rotation: EditRecipe['rotation'],
): { readonly width: number; readonly height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Draws `source` (already filter-baked; `cssFilter` is `'none'` when the
 * worker route already baked it) onto `ctx`'s canvas, applying
 * `recipe.rotation`/`flipH`/`flipV` as a REAL pixel transform in the SAME
 * draw call (bake filter, then orientation, then the caller reads the final
 * canvas). `outWidth`/`outHeight` (from `orientedSize`) are passed explicitly
 * rather than read off `ctx.canvas` so this function stays independently
 * testable against a bare mock 2d-context object.
 */
function drawOriented(
  ctx: CanvasRenderingContext2D,
  outWidth: number,
  outHeight: number,
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  recipe: EditRecipe,
  cssFilter: string,
): void {
  ctx.save();
  ctx.filter = cssFilter;
  ctx.translate(outWidth / 2, outHeight / 2);
  ctx.rotate((recipe.rotation * Math.PI) / 180);
  ctx.scale(recipe.flipH ? -1 : 1, recipe.flipV ? -1 : 1);
  ctx.drawImage(source, -srcWidth / 2, -srcHeight / 2, srcWidth, srcHeight);
  ctx.restore();
}

/** Draws a worker-fallback `ImageDataLike` result onto a scratch canvas so it can be used as a `drawImage` source (a canvas cannot draw raw pixel arrays directly). */
function imageDataToCanvas(image: ImageDataLike): HTMLCanvasElement {
  const canvas = createCanvas(image.width, image.height);
  const ctx = get2dContext(canvas);
  const pixelData = new Uint8ClampedArray(image.data);
  ctx.putImageData(new ImageData(pixelData, image.width, image.height), 0, 0);
  return canvas;
}

/**
 * Bakes `page.recipe.filter` at full resolution via the worker RPC (adaptive
 * presets / sharpness > 0, design section 4.4) and draws the oriented result
 * onto `finalCtx`. Closes every bitmap it decodes/receives (F1 hygiene).
 */
async function bakeViaWorker(
  bitmap: ImageBitmap,
  recipe: EditRecipe,
  finalCtx: CanvasRenderingContext2D,
  outWidth: number,
  outHeight: number,
): Promise<void> {
  const variant: FilterVariant = {
    preset: recipe.filter.preset,
    brightness: recipe.filter.brightness,
    contrast: recipe.filter.contrast,
    sharpness: recipe.filter.sharpness,
  };

  // Extract full-res ImageData for the worker round-trip (the RPC transfers
  // `image.data.buffer`, zero-copy) — `bitmap` itself is no longer needed
  // once its pixels are read, so it is closed immediately.
  const scratch = createCanvas(bitmap.width, bitmap.height);
  const scratchCtx = get2dContext(scratch);
  scratchCtx.drawImage(bitmap, 0, 0);
  const imageData = scratchCtx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  releaseCanvas(scratch);

  const outputBitmap = typeof OffscreenCanvas !== 'undefined';
  const response = await getSharedWorkerClient().applyFilter(
    { width: imageData.width, height: imageData.height, data: imageData.data },
    [variant],
    outputBitmap,
  );
  const result = response.results[0];
  if (!result) {
    throw new Error('exportPdf: worker returned no filtered result for APPLY_FILTER.');
  }

  if (result.kind === 'bitmap') {
    drawOriented(finalCtx, outWidth, outHeight, result.bitmap, result.bitmap.width, result.bitmap.height, recipe, 'none');
    result.bitmap.close();
  } else {
    const resultCanvas = imageDataToCanvas(result.image);
    drawOriented(finalCtx, outWidth, outHeight, resultCanvas, result.image.width, result.image.height, recipe, 'none');
    releaseCanvas(resultCanvas);
  }
}

/**
 * Renders one document page (filter baked full-res + orientation applied) to a
 * JPEG data URL.
 *
 * Exported because the on-screen viewer (`PageViewer`) renders through this
 * exact function rather than approximating with CSS filters. That matters: the
 * adaptive presets (`bw`, `bw-high-contrast`, `eco`, and anything with
 * sharpness) are baked by the OpenCV worker and have NO faithful CSS
 * equivalent, so a preview built from `ctx.filter` would show the user
 * something the exported PDF does not contain — which defeats the entire
 * purpose of letting them look before exporting.
 */
export async function renderPage(page: DocumentPage): Promise<RenderedPage> {
  const bitmap = await decodeBlobToBitmap(page.warpedBlob);
  const { recipe } = page;
  const { width, height } = orientedSize(bitmap.width, bitmap.height, recipe.rotation);

  const finalCanvas = createCanvas(width, height);
  const finalCtx = get2dContext(finalCanvas);

  if (needsWorker(recipe.filter)) {
    await bakeViaWorker(bitmap, recipe, finalCtx, width, height);
  } else {
    drawOriented(finalCtx, width, height, bitmap, bitmap.width, bitmap.height, recipe, buildCssFilter(recipe.filter));
    bitmap.close();
  }

  const dataUrl = finalCanvas.toDataURL('image/jpeg', PDF_JPEG_QUALITY);
  releaseCanvas(finalCanvas);
  return { dataUrl, width, height };
}

function exportFilename(): string {
  return `nitidoc-${Date.now()}.pdf`;
}

interface PdfPageGeometry {
  readonly width: number;
  readonly height: number;
  readonly orientation: 'p' | 'l';
}

/**
 * Resolves the nominal MediaBox independently from camera pixels for known
 * paper formats. Ticket and Original deliberately retain the old pixel-based
 * fallback because they have no trustworthy nominal physical dimensions.
 */
function resolvePdfPageGeometry(page: DocumentPage, rendered: RenderedPage): PdfPageGeometry {
  const nominalMm = getPaperFormat(page.recipe.paper.alias).nominalMm;
  // Fixed-ratio warps preserve the quad's measured orientation. `rendered`
  // already includes the recipe rotation, so it is the final authoritative
  // orientation for both known nominal pages and their contained image.
  const useLandscape = rendered.width >= rendered.height;
  const width = nominalMm
    ? useLandscape
      ? nominalMm.height
      : nominalMm.width
    : rendered.width * LEGACY_MM_PER_PIXEL;
  const height = nominalMm
    ? useLandscape
      ? nominalMm.width
      : nominalMm.height
    : rendered.height * LEGACY_MM_PER_PIXEL;
  return { width, height, orientation: width >= height ? 'l' : 'p' };
}

/**
 * Exports every page (sorted by `order`) into a single PDF, one PDF page per
 * document page. Known formats use their catalogued millimeter geometry;
 * Ticket/Original retain an explicit raster-dependent fallback (no distortion), and
 * triggers the browser download / mobile share sheet. No-op when `pages` is
 * empty. Rejects if decoding, the worker RPC, or `jsPDF` itself fails — the
 * caller is expected to surface that as a user-facing error (e.g. a toast).
 */
export async function exportPagesToPdf(pages: readonly DocumentPage[]): Promise<void> {
  if (pages.length === 0) {
    return;
  }

  const { jsPDF } = await import('jspdf');
  const ordered = [...pages].sort((a, b) => a.order - b.order);

  let doc: InstanceType<typeof jsPDF> | null = null;
  for (const page of ordered) {
    const rendered = await renderPage(page);
    const geometry = resolvePdfPageGeometry(page, rendered);
    if (!doc) {
      doc = new jsPDF({ orientation: geometry.orientation, unit: 'mm', format: [geometry.width, geometry.height] });
    } else {
      doc.addPage([geometry.width, geometry.height], geometry.orientation);
    }
    const scale = Math.min(geometry.width / rendered.width, geometry.height / rendered.height);
    const imageWidth = rendered.width * scale;
    const imageHeight = rendered.height * scale;
    doc.addImage(rendered.dataUrl, 'JPEG', (geometry.width - imageWidth) / 2, (geometry.height - imageHeight) / 2, imageWidth, imageHeight);
  }

  if (doc) {
    // Web downloads it; a native shell writes it and opens the share sheet
    // (history design section 9, item 1) — `jsPDF.save()` is a no-op inside an
    // Android WebView.
    await deliverPdf(doc, exportFilename());
  }
}
