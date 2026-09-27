/**
 * Sigma icon (Lucide Apache-2.0). Summation glyph — the document math-block
 * command in the ⌘K palette (the toolbar uses the ∑ character directly).
 * Source: https://lucide.dev/icons/sigma
 */

import type { CSSProperties } from 'react';

interface Props {
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}

export function SigmaIcon({ size = 14, strokeWidth = 2, style }: Props): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden
    >
      <path d="M18 7V4H6l6 8-6 8h12v-3" />
    </svg>
  );
}
