/**
 * The slash-command popup (ADR 0334 Phase 2) — an accessible listbox rendered by
 * the `/` suggestion plugin. Keyboard is driven through an imperative handle the
 * suggestion's `onKeyDown` calls (Up/Down cycle, Enter select, Esc closes via the
 * plugin). ARIA: `role="listbox"` + `aria-activedescendant` pointing at the
 * highlighted `role="option"` (WCAG 4.1.2; the editor keeps DOM focus).
 *
 * DE87UX-7 — DOM focus stays in the editor TEXTBOX, so ARIA on the listbox alone
 * was silent: the textbox (`owner`) now carries `aria-activedescendant` while the
 * menu is open (`slashCommand.ts` sets `aria-expanded`/`aria-controls` on it), and
 * the active option is also announced through the shared live region, since
 * screen-reader support for activedescendant across a popup is uneven.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { announce } from '../../ui/announce.js';
import type { SlashItem } from './slashItems.js';

export interface SlashMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  /** Empty-state label when the query matches nothing. */
  emptyLabel: string;
  /** Stable id base for aria-activedescendant. */
  listId: string;
  /** Accessible name of the listbox. */
  label: string;
  /** Localized announcement of the active option (DE87UX-33). */
  position: (title: string, n: number, total: number) => string;
  /** The editor's textbox element, which keeps DOM focus. */
  owner?: HTMLElement;
}

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu(
  { items, command, emptyLabel, listId, label, position, owner },
  ref,
) {
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset selection whenever the filtered set changes.
  useEffect(() => { setSelected(0); }, [items]);

  // Keep the active option in view, point the focused textbox at it, and say it.
  const active = items[selected];
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#${listId}-opt-${selected}`);
    el?.scrollIntoView({ block: 'nearest' });
    if (!owner) return;
    if (active) owner.setAttribute('aria-activedescendant', `${listId}-opt-${selected}`);
    else owner.removeAttribute('aria-activedescendant');
  }, [selected, listId, owner, active]);
  useEffect(() => {
    announce(active ? position(active.title, selected + 1, items.length) : emptyLabel);
  }, [active, selected, items.length, emptyLabel, position]);
  useEffect(() => () => { owner?.removeAttribute('aria-activedescendant'); }, [owner]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent): boolean => {
      if (!items.length) return false;
      if (event.key === 'ArrowUp') {
        setSelected((s) => (s + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }), [items, selected, command]);

  if (!items.length) {
    return <div className="doc-slash" id={`${listId}-list`} role="listbox" aria-label={label}><div className="doc-slash__empty">{emptyLabel}</div></div>;
  }

  return (
    <div className="doc-slash" id={`${listId}-list`} role="listbox" aria-label={label} aria-activedescendant={`${listId}-opt-${selected}`} ref={listRef}>
      {items.map((item, i) => (
        <button
          key={item.id}
          id={`${listId}-opt-${i}`}
          type="button"
          role="option"
          // aria-activedescendant pattern: the editor keeps DOM focus, so options
          // are not tab stops (arrow keys drive selection).
          tabIndex={-1}
          aria-selected={i === selected}
          className={`doc-slash__item${i === selected ? ' is-active' : ''}`}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
        >
          <span className="doc-slash__title">{item.title}</span>
          <span className="doc-slash__hint">{item.hint}</span>
        </button>
      ))}
    </div>
  );
});
