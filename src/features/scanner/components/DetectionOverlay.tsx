/**
 * Draws the interpolated document contour over `CameraView` (task 4.2.2;
 * proposal section 5 CAP-2; design section 0 "Overlay UI"). Renders inside
 * the overlay container `CameraView` already reserves
 * (`data-testid="camera-view-overlay"`).
 *
 * Fades out smoothly when `corners` is null (no valid detection this frame)
 * instead of disappearing abruptly — the fade is a CSS opacity transition,
 * not a re-triggered animation, so it respects `prefers-reduced-motion`
 * without any extra media query (opacity transitions are not disorienting
 * motion in the same sense as translate/scale animations).
 */

import type { ReactNode } from 'react';
import type { Quad } from '@/shared/types/geometry';

export interface DetectionOverlayProps {
  /** Interpolated corners in the SAME coordinate space as `frameWidth`/`frameHeight` (the downscaled detection frame). */
  readonly corners: Quad | null;
  readonly frameWidth: number;
  readonly frameHeight: number;
}

export function DetectionOverlay({ corners, frameWidth, frameHeight }: DetectionOverlayProps): ReactNode {
  if (frameWidth <= 0 || frameHeight <= 0) {
    return null;
  }

  const points = corners ? corners.map((p) => `${p.x},${p.y}`).join(' ') : '';

  return (
    <svg
      viewBox={`0 0 ${frameWidth} ${frameHeight}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      aria-hidden="true"
      data-testid="detection-overlay"
    >
      <polygon
        points={points}
        fill="none"
        stroke="var(--color-primary-light)"
        strokeWidth={3}
        strokeLinejoin="round"
        className={`transition-opacity duration-200 ease-out ${corners ? 'opacity-100' : 'opacity-0'}`}
      />
    </svg>
  );
}
