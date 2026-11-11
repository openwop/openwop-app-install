/**
 * DE87UX-7 — the slash menu must reach a screen reader. DOM focus stays in the
 * editor textbox, so ARIA on the listbox alone was silent (RED on `13fb94b5d`:
 * the textbox never carried `aria-activedescendant`, and nothing announced).
 * Sabotage: drop the owner attribute effect → the activedescendant case red; drop
 * the announce effect → the announcement case red.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createRef } from 'react';

const announced: string[] = [];
vi.mock('../../../ui/announce.js', () => ({ announce: (m: string) => { announced.push(m); } }));

import { SlashMenu, type SlashMenuHandle } from '../SlashMenu.js';
import type { SlashItem } from '../slashItems.js';

// jsdom has no layout, so no scrollIntoView.
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); announced.length = 0; });

const item = (id: string, title: string): SlashItem => ({ id, title, hint: '', keywords: '', run: () => {} });
const items: SlashItem[] = [item('h1', 'Heading 1'), item('p', 'Text')];
const pos = (title: string, n: number, total: number): string => `pos(${title},${n},${total})`;

describe('SlashMenu accessibility (DE87UX-7)', () => {
  it('points the focused textbox at the active option, and moves with the arrows', async () => {
    const owner = document.createElement('div');
    const ref = createRef<SlashMenuHandle>();
    render(<SlashMenu ref={ref} items={items} command={() => {}} emptyLabel="none" listId="t" label="Insert a block" position={pos} owner={owner} />);
    expect(owner.getAttribute('aria-activedescendant')).toBe('t-opt-0');
    await act(async () => { ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    expect(owner.getAttribute('aria-activedescendant')).toBe('t-opt-1');
    expect(document.getElementById('t-list')?.getAttribute('aria-label')).toBe('Insert a block');
  });

  it('announces the active option with its position', async () => {
    const ref = createRef<SlashMenuHandle>();
    render(<SlashMenu ref={ref} items={items} command={() => {}} emptyLabel="none" listId="t" label="Insert a block" position={pos} />);
    await act(async () => { ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    expect(announced).toEqual(['pos(Heading 1,1,2)', 'pos(Text,2,2)']); // through the localized formatter
  });
});
