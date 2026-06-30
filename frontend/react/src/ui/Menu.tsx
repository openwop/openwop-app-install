/**
 * Menu — the ONE accessible menubutton primitive (DS-8).
 *
 * The app previously hand-rolled `role="menu"` popovers (the builder Share
 * menu, the chat `⋯ More` overflow) that declared the menu role WITHOUT the
 * WAI-ARIA keyboard contract — no focus-into-menu, no ↑↓ roving, no focus
 * return on close. This is the menu analogue of `ui/rovingTabs.ts` (DS-7):
 * one implementation that gets the keyboard + focus management right, so a
 * surface supplies only a trigger + a list of items.
 *
 * Contract (https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/):
 *   - Trigger: `aria-haspopup="menu"` + `aria-expanded`; Enter/Space/↓ open it
 *     and move focus to the first item.
 *   - Open menu: `role="menu"`; items are `role="menuitem"`. ↑/↓ move focus
 *     (wrapping), Home/End jump to first/last, Escape closes + returns focus to
 *     the trigger, Tab closes. Selecting an item runs its handler, closes, and
 *     returns focus to the trigger.
 *   - Outside-click closes (focus left where the user clicked).
 *
 * Styling reuses the existing `.tb-menu*` token-driven classes.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuAction {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
}
export interface MenuSeparator { id: string; separator: true }
export type MenuEntry = MenuAction | MenuSeparator;

const isAction = (e: MenuEntry): e is MenuAction => !('separator' in e);

interface Props {
  /** Accessible name for the trigger button. */
  label: string;
  /** Visible trigger content (icon and/or text). */
  triggerContent: ReactNode;
  /** className applied to the trigger button. */
  triggerClassName?: string;
  triggerTitle?: string;
  items: MenuEntry[];
  /** Dropdown horizontal alignment. Default 'end' (right-aligned to trigger). */
  align?: 'start' | 'end';
  /** Open ABOVE the trigger instead of below — for triggers anchored at the
   *  bottom of the viewport (e.g. the chat composer) where a downward menu would
   *  clip off-screen. Default false. */
  dropUp?: boolean;
  /** Disable the trigger (and keep the menu closed) — e.g. while a turn is in
   *  flight. Mirrors a plain button's `disabled`. */
  disabled?: boolean;
}

export function Menu({ label, triggerContent, triggerClassName, triggerTitle, items, align = 'end', dropUp = false, disabled = false }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Focusable (enabled action) positions, in render order.
  const focusable = items.reduce<number[]>((acc, e, i) => {
    if (isAction(e) && !e.disabled) acc.push(i);
    return acc;
  }, []);

  function openMenu(index: number): void {
    setActiveIndex(index);
    setOpen(true);
  }
  function closeMenu(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  // Move focus to the active item whenever the menu opens or the active index changes.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // Close on Escape / outside-click while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(true); };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeMenu(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  function step(delta: number): void {
    if (focusable.length === 0) return;
    const pos = focusable.indexOf(activeIndex);
    const next = focusable[(pos + delta + focusable.length) % focusable.length];
    if (next !== undefined) setActiveIndex(next);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu(focusable[0] ?? 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(focusable[focusable.length - 1] ?? 0);
    }
  }

  function onMenuKeyDown(e: React.KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); step(1); break;
      case 'ArrowUp': e.preventDefault(); step(-1); break;
      case 'Home': e.preventDefault(); if (focusable[0] !== undefined) setActiveIndex(focusable[0]); break;
      case 'End': e.preventDefault(); { const last = focusable[focusable.length - 1]; if (last !== undefined) setActiveIndex(last); } break;
      case 'Tab': closeMenu(false); break;
      default: break;
    }
  }

  function select(item: MenuAction): void {
    if (item.disabled) return;
    closeMenu(true);
    item.onSelect();
  }

  return (
    <div className="tb-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={triggerTitle ?? label}
        onClick={() => (open ? closeMenu(false) : openMenu(focusable[0] ?? 0))}
        onKeyDown={onTriggerKeyDown}
      >
        {triggerContent}
      </button>
      {open && (
        <div
          className={`tb-menu-list${align === 'start' ? ' tb-menu-list--start' : ''}${dropUp ? ' tb-menu-list--up' : ''}`}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((entry, i) =>
            isAction(entry) ? (
              <button
                key={entry.id}
                ref={(el) => { itemRefs.current[i] = el; }}
                role="menuitem"
                type="button"
                className="tb-menu-item"
                tabIndex={i === activeIndex ? 0 : -1}
                disabled={entry.disabled}
                title={entry.title}
                onClick={() => select(entry)}
              >
                {entry.label}
              </button>
            ) : (
              <div key={entry.id} className="tb-menu-sep" role="separator" />
            ),
          )}
        </div>
      )}
    </div>
  );
}
