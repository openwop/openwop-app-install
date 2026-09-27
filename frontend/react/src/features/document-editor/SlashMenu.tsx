/**
 * The slash-command popup (ADR 0334 Phase 2) — an accessible listbox rendered by
 * the `/` suggestion plugin. Keyboard is driven through an imperative handle the
 * suggestion's `onKeyDown` calls (Up/Down cycle, Enter select, Esc closes via the
 * plugin). ARIA: `role="listbox"` + `aria-activedescendant` pointing at the
 * highlighted `role="option"` (WCAG 4.1.2; the editor keeps DOM focus).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
}

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu(
  { items, command, emptyLabel, listId },
  ref,
) {
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset selection whenever the filtered set changes.
  useEffect(() => { setSelected(0); }, [items]);

  // Keep the active option in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#${listId}-opt-${selected}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, listId]);

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
    return <div className="doc-slash" role="listbox" aria-label={emptyLabel}><div className="doc-slash__empty">{emptyLabel}</div></div>;
  }

  return (
    <div className="doc-slash" role="listbox" aria-activedescendant={`${listId}-opt-${selected}`} ref={listRef}>
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
