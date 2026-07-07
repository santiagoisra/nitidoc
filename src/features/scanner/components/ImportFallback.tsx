/**
 * Desktop-without-camera / permission-denied import fallback UI (Group 6 /
 * Slice F, tasks 6.1.1/6.2.1/6.3.1-6.3.3; design section 8 "Sin camara" /
 * "Permiso denegado"; scanner spec "Fallback de import de imagen (desktop
 * sin camara)" and "Permiso de camara denegado").
 *
 * Deliberately a single `<input type="file" accept="image/*">` with NO
 * `multiple` attribute and NO drag&drop handlers (scanner spec "Import de
 * imagen no ofrece funcionalidad fuera de alcance" — task 6.3.3's negative
 * behavior contract). Browser-specific unblock instructions (6.1.1) are
 * shown only in the `reason === 'permission-denied'` variant; the
 * `reason === 'no-camera'` variant skips them since there is no permission
 * to re-grant.
 */

import type { ChangeEvent, ReactNode } from 'react';
import { useCallback, useRef } from 'react';
import { FileImage, Loader2 } from 'lucide-react';
import { Button } from '@/shared/ui';
import { IMPORT_FALLBACK_ACCEPT } from '@/features/scanner/lib/captureFallback';

export type ImportFallbackReason = 'permission-denied' | 'no-camera';

export interface ImportFallbackProps {
  readonly reason: ImportFallbackReason;
  readonly onFileSelected: (file: File) => void;
  readonly errorMessage?: string | null;
  /**
   * LOW-2: true while the selected file is being processed (decode + optional
   * OpenCV DETECT pre-seed). Disables the picker and surfaces a spinner + an
   * `aria-live` status so the user is not left wondering whether their click
   * registered during the wait (which can span a first-time ~10MB WASM load).
   */
  readonly busy?: boolean;
}

/**
 * Per-browser instructions for re-enabling a denied camera permission (task
 * 6.1.1). Detected via `navigator.userAgent` — a best-effort, presentational
 * heuristic only; it never gates functionality, only which copy is shown.
 */
function detectBrowserInstructions(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Firefox/i.test(ua)) {
    return 'Open the padlock icon in the address bar, set Camera to "Allow", then reload the page.';
  }
  if (/Edg\//i.test(ua)) {
    return 'Click the lock/info icon in the address bar, set Camera to "Allow", then reload the page.';
  }
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) {
    return 'Open Safari Settings > Websites > Camera, allow this site, then reload the page.';
  }
  // Default: Chrome/Chromium-based instructions, the most common case.
  return 'Click the lock/info icon in the address bar, set Camera to "Allow", then reload the page.';
}

export function ImportFallback({
  reason,
  onFileSelected,
  errorMessage,
  busy = false,
}: ImportFallbackProps): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      // Task 6.3.3: only ever read files[0]. No `multiple` attribute is set
      // on the input below, so browsers already restrict the picker to a
      // single file, but this guard keeps the negative contract explicit
      // even if that attribute were ever removed by mistake.
      const file = event.target.files?.[0];
      if (file) {
        onFileSelected(file);
      }
      // Reset so re-selecting the SAME file path fires `onChange` again.
      event.target.value = '';
    },
    [onFileSelected],
  );

  const handlePickFile = useCallback(() => {
    if (busy) {
      return; // LOW-2: ignore clicks while an import is already processing.
    }
    inputRef.current?.click();
  }, [busy]);

  return (
    <div
      className="flex w-full max-w-sm flex-col items-center gap-4 text-center"
      data-testid="import-fallback"
      aria-busy={busy}
    >
      {reason === 'permission-denied' && (
        <div className="flex flex-col gap-2" data-testid="permission-denied-instructions">
          <p role="alert" className="text-sm text-danger">
            Camera access was denied.
          </p>
          <p className="text-sm text-text-muted">{detectBrowserInstructions()}</p>
        </div>
      )}

      {reason === 'no-camera' && (
        <p className="text-sm text-text-muted" data-testid="no-camera-instructions">
          No camera was detected on this device. You can still scan a document by importing an image file.
        </p>
      )}

      {errorMessage != null && (
        <p role="alert" className="text-sm text-danger" data-testid="import-fallback-error">
          {errorMessage}
        </p>
      )}

      <Button
        type="button"
        variant="primary"
        onClick={handlePickFile}
        disabled={busy}
        data-testid="import-fallback-button"
      >
        {busy ? (
          <Loader2 size={18} strokeWidth={1.5} aria-hidden="true" className="animate-spin" />
        ) : (
          <FileImage size={18} strokeWidth={1.5} aria-hidden="true" />
        )}
        {busy ? 'Processing…' : 'Import image'}
      </Button>

      {/* LOW-2: polite live region so assistive tech announces the wait. */}
      <p
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="import-fallback-status"
      >
        {busy ? 'Processing the selected image, please wait.' : ''}
      </p>

      {/*
        Single file, no `multiple`, no drag&drop handlers anywhere on this
        component (task 6.3.3). `sr-only` + a visible trigger Button above
        gives a larger, styled hit target than the native input chrome while
        keeping the input itself focusable/operable for assistive tech.
      */}
      <input
        ref={inputRef}
        type="file"
        accept={IMPORT_FALLBACK_ACCEPT}
        onChange={handleChange}
        className="sr-only"
        data-testid="import-fallback-input"
        aria-label="Import a document image"
      />
    </div>
  );
}
