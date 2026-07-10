/**
 * `<video>` bound to the active MediaStream, plus a positioned container
 * for optional overlay content (proposal section 4.1 `CameraView.tsx`).
 *
 * Scope (Group 3 / Slice C): wires the stream into the video element.
 * Scope (Group 4 / Slice D): forwards the underlying `<video>` element via
 * `videoRef` so the capture sequence can read frames from it directly, and
 * renders overlay content supplied by the caller. Fase 2.3 (capture-ux-
 * redesign.md, Unit 6): the live-detection loop and its `DetectionOverlay`
 * contour drawing were removed — capture is manual-only now, so `overlay`
 * currently has no live consumer, but stays as a general-purpose slot.
 * Scope (Fase 2.3 / capture-ux-redesign.md, Unit 3): `fill` renders the
 * immersive full-bleed capture screen's camera layer — the container becomes
 * `absolute inset-0 h-full w-full`, dropping the fixed-aspect/max-width/
 * rounded chrome, while the `<video>` itself stays `object-cover` either way.
 * `videoRef`/the stream-binding effect/`openCamera` timing are unaffected —
 * only the CONTAINER's layout classes change.
 */

import type { ForwardedRef, ReactNode } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

export interface CameraViewProps {
  /** Optional overlay content (contour, corner handles) rendered above the video. Group 4/5 supply this. */
  readonly overlay?: ReactNode;
  /** Full-bleed immersive capture screen (Fase 2.3, Unit 3): fills the parent absolutely instead of the fixed-aspect card layout. */
  readonly fill?: boolean;
}

function CameraViewImpl(
  { overlay, fill = false }: CameraViewProps,
  ref: ForwardedRef<HTMLVideoElement>,
): ReactNode {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stream = useScannerStore((s) => s.stream);

  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const containerClassName = fill
    ? 'absolute inset-0 h-full w-full overflow-hidden bg-surface'
    : 'relative aspect-[3/4] w-full max-w-md overflow-hidden rounded-2xl bg-surface';

  return (
    <div className={containerClassName}>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="h-full w-full object-cover"
        data-testid="camera-view-video"
      />
      {/* Overlay container: absolutely positioned above the video, ignores
          pointer events by default so it never blocks camera gestures.
          Group 4 draws the interpolated contour here; Group 5 replaces it
          with the corner editor's draggable handles during editing. */}
      <div className="pointer-events-none absolute inset-0" data-testid="camera-view-overlay">
        {overlay}
      </div>
    </div>
  );
}

export const CameraView = forwardRef(CameraViewImpl);
