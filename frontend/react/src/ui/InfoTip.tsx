/**
 * InfoTip (STRATUX-5) — a keyboard-discoverable tooltip primitive. Replaces the
 * `title=` attribute for explanatory chips: a `title` tooltip is invisible to
 * keyboard and touch users and unstyled. This trigger is a real focusable
 * `<button>` that reveals its bubble on hover AND focus, dismisses on Escape or
 * blur, and links the bubble via `aria-describedby` (the WAI-ARIA tooltip
 * pattern). Token-only styling (`.info-tip*` in global.css); DESIGN.md §5 row.
 *
 * Content is short, non-interactive text (no links/buttons inside — that would
 * be a popover, a different pattern). For rich content use a Modal.
 */
import { useId, useState, type ReactNode } from 'react';
import { InfoIcon } from './icons/index.js';

export function InfoTip({ label, text, children }: {
  /** Accessible name for the trigger (e.g. "What is this rank?"). */
  label: string;
  /** The tooltip text. */
  text: string;
  /** Optional visible trigger content; defaults to a small info glyph. */
  children?: ReactNode;
}): JSX.Element {
  const id = useId();
  // Hover and focus are tracked independently (FE#7): a mouse-leave must not
  // dismiss a tooltip a keyboard user opened by focusing the trigger.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;
  return (
    <span className="info-tip">
      <button
        type="button"
        className="info-tip-trigger"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            // Dismiss only this tip — don't let Escape reach an ancestor Modal's
            // window-level handler and close the whole dialog (FE#6).
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setHovered(false);
            setFocused(false);
          }
        }}
      >
        {children ?? <InfoIcon size={12} aria-hidden />}
      </button>
      {open ? <span id={id} role="tooltip" className="info-tip-bubble">{text}</span> : null}
    </span>
  );
}
