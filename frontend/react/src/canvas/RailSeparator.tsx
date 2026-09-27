/**
 * RailSeparator — §7.2 / CV-14: the draggable inner edge of a canvas-editor
 * rail. A WAI-ARIA window-splitter (`role="separator"`, vertical, focusable):
 * pointer drag resizes; ←/→ arrow keys resize by 16px (the keyboard parity
 * path); Home/End jump to min/max. Values are px, clamped by the caller's
 * `useRailLayout`. Hidden under the ≤920px single-column stack (CSS).
 */
import { useRef } from 'react';
import type * as React from 'react';
import { clampRail, RAIL_CLAMPS, type RailSide } from './useRailLayout.js';

const KEY_STEP = 16;

export function RailSeparator({ side, value, label, onResize }: {
  side: RailSide;
  /** Current rail width (px). */
  value: number;
  /** Localized accessible name ("Resize palette" / "Resize properties"). */
  label: string;
  onResize: (w: number) => void;
}): JSX.Element {
  const drag = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
  const { min, max } = RAIL_CLAMPS[side];

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startW: value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    // The left rail grows rightward; the right rail grows leftward.
    const dx = e.clientX - d.startX;
    onResize(clampRail(side, side === 'l' ? d.startW + dx : d.startW - dx));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const grow = side === 'l' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'l' ? 'ArrowLeft' : 'ArrowRight';
    const next = e.key === grow ? value + KEY_STEP
      : e.key === shrink ? value - KEY_STEP
      : e.key === 'Home' ? min
      : e.key === 'End' ? max
      : null;
    if (next === null) return;
    e.preventDefault();
    onResize(clampRail(side, next));
  };

  return (
    // A focusable role="separator" with aria-valuenow IS the interactive
    // window-splitter widget (WAI-ARIA APG); jsx-a11y's role list predates it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={`cv-rail-sep cv-rail-sep--${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
