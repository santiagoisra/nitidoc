/**
 * Bottom-bar capture-count tile (Fase 2.3, capture-ux-redesign.md, Unit 3).
 * Draws the newest available cached ~150px thumbnail on a ~56px rounded
 * canvas, overlaid with a count badge (`aria-live="polite"`, D-badge state
 * always visible to assistive tech) and a small "x" retake-last control.
 *
 * NEVER decodes a full-res blob — the bitmap it receives IS an already
 * cached thumbnail (mirrors `PageThumbnail`'s own "never full-res" contract,
 * `CaptureTray.tsx`). Renders nothing at `count <= 0` (nothing captured yet
 * for this document, and no optimistic bump pending either — see
 * `CaptureScreen`'s own doc comment on the "optimistic count bump" feedback
 * rule).
 *
 * Bug 5 fix (capture-ux-redesign.md punch-list): both `count` and
 * `lastThumbnail` now reflect the WHOLE document-in-progress
 * (`pages.length + rawCaptures.length`), not just the current batch's
 * `rawCaptures` — otherwise returning here via grid/adjust "Capturar más"
 * (which already cleared `rawCaptures` into `pages`) showed an empty tile
 * even though the document already has pages. See `CaptureScreen`'s
 * `displayCount`/`lastThumbnail` derivation for the actual sourcing.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '@/shared/i18n';

const TILE_SIZE = 56;

export interface CaptureCountThumbnailProps {
  /** `pages.length + rawCaptures.length` plus any in-flight optimistic bump (design "Feedback"; bug 5 fix — reflects the whole document-in-progress, not just this batch). */
  readonly count: number;
  /** The last raw capture's cached thumbnail if this batch has any, else the last confirmed page's thumbnail (bug 5 fix), or `null` before anything has ever been captured for this document. */
  readonly lastThumbnail: ImageBitmap | null;
  /** Retake-last (removes the last raw capture). Not inert — the tile is interactive per the design brief. */
  readonly onRetakeLast: () => void;
}

export function CaptureCountThumbnail({
  count,
  lastThumbnail,
  onRetakeLast,
}: CaptureCountThumbnailProps): ReactNode {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !lastThumbnail) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    // Cover-fit the thumbnail into the square tile (same centered-crop intent
    // as the video's own `object-cover`, just drawn manually on a canvas).
    const scale = Math.max(TILE_SIZE / lastThumbnail.width, TILE_SIZE / lastThumbnail.height);
    const drawWidth = lastThumbnail.width * scale;
    const drawHeight = lastThumbnail.height * scale;
    const dx = (TILE_SIZE - drawWidth) / 2;
    const dy = (TILE_SIZE - drawHeight) / 2;
    ctx.drawImage(lastThumbnail, dx, dy, drawWidth, drawHeight);
  }, [lastThumbnail]);

  if (count <= 0) {
    return null;
  }

  return (
    <div className="relative" data-testid="capture-count-thumbnail">
      <div
        className="h-14 w-14 overflow-hidden rounded-xl bg-surface/80 ring-1 ring-white/20"
        aria-hidden="true"
      >
        {lastThumbnail && (
          <canvas ref={canvasRef} className="h-full w-full" data-testid="capture-count-canvas" />
        )}
      </div>

      <span
        role="status"
        aria-live="polite"
        data-testid="capture-count-badge"
        className="absolute -right-1.5 -top-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-bg"
      >
        {count}
      </span>

      <button
        type="button"
        onClick={onRetakeLast}
        data-testid="capture-count-retake-last"
        aria-label={t('capture.retakeLast')}
        className="absolute -bottom-1.5 -left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface text-text shadow
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-light"
      >
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
