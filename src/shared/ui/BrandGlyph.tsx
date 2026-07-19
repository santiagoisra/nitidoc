import type { ReactNode } from 'react';
import { useId } from 'react';

export interface BrandGlyphProps {
  /** Rendered pixel size (square). */
  readonly size?: number;
  /**
   * `true` (default): the app-icon look — the teal gradient rounded square
   * with white viewfinder strokes. `false`: just the viewfinder strokes in
   * `currentColor` (used white over the welcome CTA's own gradient).
   */
  readonly withBackground?: boolean;
  readonly className?: string;
}

/**
 * Nitidoc brand mark (HANDOFF-UI.md sections 3/5.1) — the scanner viewfinder
 * (corner brackets + a scan line), matching `public/icons/favicon.svg`. Used
 * as the header logo and, stroke-only, inside the welcome CTA. Purely
 * decorative: `aria-hidden`, callers provide their own accessible label.
 */
export function BrandGlyph({ size = 24, withBackground = true, className }: BrandGlyphProps): ReactNode {
  const gradientId = useId();
  const strokeColor = withBackground ? '#fff' : 'currentColor';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {withBackground && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#3AD6BD" />
              <stop offset="1" stopColor="#0F8A78" />
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="22" fill={`url(#${gradientId})`} />
        </>
      )}
      <g stroke={strokeColor} strokeWidth="7" strokeLinecap="round" fill="none">
        <path d="M40 26 H30 a4 4 0 0 0 -4 4 V40" />
        <path d="M60 26 H70 a4 4 0 0 1 4 4 V40" />
        <path d="M40 74 H30 a4 4 0 0 1 -4 -4 V60" />
        <path d="M60 74 H70 a4 4 0 0 0 4 -4 V60" />
        <path d="M34 50 H66" />
      </g>
    </svg>
  );
}
