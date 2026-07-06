/**
 * `<video>` bound to the active MediaStream, plus a positioned container
 * for the live-detection overlay (proposal section 4.1 `CameraView.tsx`).
 *
 * Scope (Group 3 / Slice C): wires the stream into the video element only.
 * The overlay CONTENT (interpolated contour drawing) is Group 4 (Slice D) —
 * this component only reserves the layered container so that slice can drop
 * its overlay in without touching this file's layout again.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useScannerStore } from '@/features/scanner/store/scannerStore';

export interface CameraViewProps {
  /** Optional overlay content (contour, corner handles) rendered above the video. Group 4/5 supply this. */
  readonly overlay?: ReactNode;
}

export function CameraView({ overlay }: CameraViewProps): ReactNode {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stream = useScannerStore((s) => s.stream);

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

  return (
    <div className="relative aspect-[3/4] w-full max-w-md overflow-hidden rounded-2xl bg-surface">
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
