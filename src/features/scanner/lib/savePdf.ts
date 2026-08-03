/**
 * Platform-aware delivery of the generated PDF (history design section 9,
 * item 1).
 *
 * On the web, `jsPDF.save()` triggers a browser download and that is the whole
 * story. Inside an Android WebView it is a dead end: the WebView has no
 * download manager, so the `<a download>` click jsPDF performs simply does
 * nothing and the export silently evaporates. Native builds therefore write the
 * bytes to the app's cache directory and hand the file to the OS share sheet,
 * which is also the more useful gesture on a phone — the user picks Drive,
 * Gmail, WhatsApp or Files rather than hunting through a Downloads folder.
 *
 * `@capacitor/filesystem` and `@capacitor/share` are imported DYNAMICALLY and
 * only on the native branch, so the web bundle never pays for plugins it can
 * never call.
 */

import { Capacitor } from '@capacitor/core';

/**
 * The slice of jsPDF this module needs, declared structurally so nothing here
 * has to import jsPDF itself — it stays lazily loaded at its single call site
 * in `exportPdf.ts`.
 */
export interface PdfDocumentLike {
  save(filename: string): void;
  output(type: 'arraybuffer'): ArrayBuffer;
}

/**
 * Base64-encodes in chunks. `String.fromCharCode(...bytes)` on a multi-MB
 * scan spreads millions of arguments onto the call stack and throws
 * `RangeError: Maximum call stack size exceeded` — which would turn a
 * perfectly good 30-page export into a crash precisely on the documents users
 * care most about.
 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** True when running inside a Capacitor native shell rather than a browser. */
export function isNativeShell(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Delivers the finished PDF to the user by whatever mechanism the platform
 * actually has. Rejects on failure so the caller can surface a toast — the
 * same contract `exportPagesToPdf` already had.
 */
export async function deliverPdf(doc: PdfDocumentLike, filename: string): Promise<void> {
  if (!isNativeShell()) {
    doc.save(filename);
    return;
  }

  const [{ Directory, Filesystem }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);

  // `Directory.Cache` rather than `Documents`: the file exists to be handed to
  // another app, not to be curated by the user. Android is free to reclaim it
  // afterwards, and writing to shared storage would need a runtime permission
  // for something the share sheet already does without one.
  const written = await Filesystem.writeFile({
    path: filename,
    data: toBase64(doc.output('arraybuffer')),
    directory: Directory.Cache,
  });

  await Share.share({ title: filename, files: [written.uri] });
}
