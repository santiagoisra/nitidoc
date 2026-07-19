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

// Portrait "mini-paper" tile (HANDOFF-UI.md section 5.2): 52×64.
const TILE_W = 52;
const TILE_H = 64;

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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(count);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !lastThumbnail) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    canvas.width = TILE_W;
    canvas.height = TILE_H;
    ctx.clearRect(0, 0, TILE_W, TILE_H);
    // Cover-fit the thumbnail into the portrait tile (same centered-crop intent
    // as the video's own `object-cover`, just drawn manually on a canvas).
    const scale = Math.max(TILE_W / lastThumbnail.width, TILE_H / lastThumbnail.height);
    const drawWidth = lastThumbnail.width * scale;
    const drawHeight = lastThumbnail.height * scale;
    const dx = (TILE_W - drawWidth) / 2;
    const dy = (TILE_H - drawHeight) / 2;
    ctx.drawImage(lastThumbnail, dx, dy, drawWidth, drawHeight);
  }, [lastThumbnail]);

  // Pop the tile whenever the count grows (a capture just landed in the tray) —
  // the "fly-to-tray" polish, simplified to an attention pop. Imperative class
  // toggle + reflow so consecutive captures each re-play the one-shot animation
  // without remounting the canvas (which would flash a redraw). Disabled under
  // prefers-reduced-motion by the keyframe's own media query (tokens.css).
  useEffect(() => {
    if (count > prevCountRef.current && rootRef.current) {
      const el = rootRef.current;
      el.classList.remove('animate-count-pop');
      void el.offsetWidth; // force reflow so the animation restarts
      el.classList.add('animate-count-pop');
    }
    prevCountRef.current = count;
  }, [count]);

  if (count <= 0) {
    return null;
  }

  return (
    <div ref={rootRef} className="relative" data-testid="capture-count-thumbnail">
      <div
        className="h-16 w-[52px] overflow-hidden rounded-lg bg-surface/80 ring-1 ring-white/20"
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
        className="tabular-nums absolute -right-1.5 -top-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-bg"
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
