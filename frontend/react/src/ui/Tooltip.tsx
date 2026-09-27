/**
 * Tooltip — shared text tooltip for an existing interactive child.
 *
 * Unlike `InfoTip` (which owns an info-button trigger), this primitive augments
 * a link or button the caller already owns. The bubble is portalled to the body
 * so scroll containers cannot clip it, and the trigger receives
 * `aria-describedby` only while the bubble is present. Hover and keyboard focus
 * are equivalent; Escape dismisses without activating the trigger.
 */
import { cloneElement, useId, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

interface TooltipChildProps { 'aria-describedby'?: string }

export function Tooltip({ text, children, disabled = false }: {
  text: string;
  children: ReactElement<TooltipChildProps>;
  disabled?: boolean;
}): JSX.Element {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    if (disabled || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPosition({
      top: rect.top + rect.height / 2,
      left: Math.min(rect.right + 8, window.innerWidth - 272),
    });
  };
  const hide = () => setPosition(null);
  const describedBy = position
    ? [children.props['aria-describedby'], id].filter(Boolean).join(' ')
    : children.props['aria-describedby'];

  return (
    <span
      ref={anchorRef}
      className="tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
      onKeyDown={(event) => { if (event.key === 'Escape') hide(); }}
    >
      {describedBy ? cloneElement(children, { 'aria-describedby': describedBy }) : children}
      {position && typeof document !== 'undefined' ? createPortal(
        <span id={id} role="tooltip" className="tooltip-bubble" style={{ top: position.top, left: position.left }}>
          {text}
        </span>,
        document.body,
      ) : null}
    </span>
  );
}
