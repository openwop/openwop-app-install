/** Devices icon: a monitor and a phone side by side ("your app" on every
 *  screen). Original glyph in the Lucide style (24 grid, round caps), drawn for
 *  the ADR 1047 hub's `device` place. */
import type { CSSProperties } from 'react';
interface Props { size?: number; strokeWidth?: number; style?: CSSProperties }
export function DevicesIcon({ size = 16, strokeWidth = 2, style }: Props): JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden>
      <rect x="2.5" y="5" width="13" height="10" rx="1.5" />
      <path d="M6 19h6M9 15v4" />
      <rect x="16.5" y="8" width="5" height="11" rx="1.2" />
    </svg>
  );
}
