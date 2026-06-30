/**
 * Menu — the shared accessible menubutton (DS-8). Verifies the WAI-ARIA
 * keyboard contract the hand-rolled tb-menu popovers lacked: open moves focus
 * into the menu, ↑/↓ rove (wrapping) and skip disabled items, Escape closes and
 * returns focus to the trigger, and selecting an item runs its handler + closes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Menu, type MenuEntry } from '../Menu.js';

function setup(onA = vi.fn(), onC = vi.fn()) {
  const items: MenuEntry[] = [
    { id: 'a', label: 'Alpha', onSelect: onA },
    { id: 'b', label: 'Beta', onSelect: vi.fn(), disabled: true },
    { id: 'sep', separator: true },
    { id: 'c', label: 'Gamma', onSelect: onC },
  ];
  render(<Menu label="More actions" triggerContent="⋯" triggerClassName="t" items={items} />);
  return { onA, onC };
}

describe('Menu', () => {
  it('trigger exposes the menubutton ARIA contract', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('opening moves focus to the first enabled item', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }));
  });

  it('ArrowDown skips the disabled item and wraps', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // Alpha -> Gamma (Beta disabled, skipped)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Gamma' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // Gamma -> wrap to Alpha
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }));
  });

  it('Escape closes and returns focus to the trigger', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('selecting an item runs its handler and closes', () => {
    const { onC } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Gamma' }));
    expect(onC).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
