/**
 * Grade pass UX-CV-8 — the outline is a real WAI-ARIA `tree`: container
 * `role=tree`, nested `role=group`, rows `role=treeitem` with
 * aria-selected/level/posinset/setsize, ONE roving tab stop, and
 * Up/Down/Home/End moving focus across the visible items + Enter/Space select.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { OutlineTree } from '../OutlineTree.js';
import type { TreeNodeBase } from '../treeOps.js';

interface N extends TreeNodeBase { type: string; children?: N[] }

const nodes: N[] = [
  { type: 'a', children: [{ type: 'a1' }, { type: 'a2' }] },
  { type: 'b' },
];

function mount(selPath: number[] | null = null, onSelect = vi.fn()): { onSelect: ReturnType<typeof vi.fn> } {
  render(
    <OutlineTree<N>
      nodes={nodes}
      path={[]}
      selPath={selPath}
      onSelect={onSelect}
      dropPath={null}
      setDropPath={vi.fn()}
      onDropRow={vi.fn()}
      labelFor={(n) => n.type}
      childrenOf={(n) => n.children}
      label="Outline"
    />,
  );
  return { onSelect };
}

afterEach(cleanup);

describe('OutlineTree — ARIA tree', () => {
  it('exposes tree/group/treeitem roles with level + position metadata', () => {
    mount();
    const tree = screen.getByRole('tree', { name: 'Outline' });
    expect(tree).toBeTruthy();
    const items = screen.getAllByRole('treeitem');
    expect(items).toHaveLength(4); // a, a1, a2, b
    const a = items[0]!;
    expect(a.getAttribute('aria-level')).toBe('1');
    expect(a.getAttribute('aria-posinset')).toBe('1');
    expect(a.getAttribute('aria-setsize')).toBe('2');
    expect(a.getAttribute('aria-expanded')).toBe('true'); // has children
    const a1 = items[1]!;
    expect(a1.getAttribute('aria-level')).toBe('2');
    expect(screen.getByRole('group')).toBeTruthy(); // the nested child list
  });

  it('has exactly one roving tab stop — the first row when nothing is selected', () => {
    mount(null);
    const items = screen.getAllByRole('treeitem');
    expect(items.filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(items[0]!.getAttribute('tabindex')).toBe('0');
  });

  it('moves the tab stop to the selected row and marks it aria-selected', () => {
    mount([1]); // select 'b'
    const items = screen.getAllByRole('treeitem');
    const b = items[3]!;
    expect(b.getAttribute('aria-selected')).toBe('true');
    expect(b.getAttribute('tabindex')).toBe('0');
    expect(items[0]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowDown moves focus to the next visible item; Enter selects', () => {
    const { onSelect } = mount(null);
    const items = screen.getAllByRole('treeitem');
    items[0]!.focus();
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]!); // a → a1
    fireEvent.keyDown(items[1]!, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith([0, 0]);
  });

  it('Home/End jump to the first/last visible item', () => {
    mount(null);
    const items = screen.getAllByRole('treeitem');
    items[1]!.focus();
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(document.activeElement).toBe(items[3]!);
    fireEvent.keyDown(items[3]!, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]!);
  });
});

describe('OutlineTree — keyboard reorder (ADR 0458 a11y)', () => {
  const rNodes: N[] = [
    { type: 'a', children: [{ type: 'a1' }, { type: 'a2' }] },
    { type: 'b' },
    { type: 'c', locked: true },
  ];
  function mountR(onReorder = vi.fn()): { onReorder: ReturnType<typeof vi.fn> } {
    render(
      <OutlineTree<N>
        nodes={rNodes} path={[]} selPath={null} onSelect={vi.fn()}
        dropPath={null} setDropPath={vi.fn()} onDropRow={vi.fn()} onReorder={onReorder}
        labelFor={(n) => n.type} childrenOf={(n) => n.children} label="Outline"
      />,
    );
    return { onReorder };
  }

  it('Alt+ArrowDown/Up fires onReorder with the row path + direction', () => {
    const { onReorder } = mountR();
    const items = screen.getAllByRole('treeitem'); // a, a1, a2, b, c
    fireEvent.keyDown(items[3]!, { key: 'ArrowDown', altKey: true }); // b → [1]
    expect(onReorder).toHaveBeenCalledWith([1], 'down');
    fireEvent.keyDown(items[1]!, { key: 'ArrowUp', altKey: true }); // a1 → [0,0]
    expect(onReorder).toHaveBeenCalledWith([0, 0], 'up');
  });

  it('plain ArrowDown navigates and does NOT reorder (the modifier disambiguates)', () => {
    const { onReorder } = mountR();
    const items = screen.getAllByRole('treeitem');
    items[3]!.focus();
    fireEvent.keyDown(items[3]!, { key: 'ArrowDown' }); // no Alt → navigate
    expect(onReorder).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(items[4]!); // focus moved b → c
  });

  it('a locked node does not reorder', () => {
    const { onReorder } = mountR();
    const items = screen.getAllByRole('treeitem');
    fireEvent.keyDown(items[4]!, { key: 'ArrowUp', altKey: true }); // c is locked
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('no onReorder prop → Alt+Arrow is a harmless no-op', () => {
    render(
      <OutlineTree<N>
        nodes={rNodes} path={[]} selPath={null} onSelect={vi.fn()}
        dropPath={null} setDropPath={vi.fn()} onDropRow={vi.fn()}
        labelFor={(n) => n.type} childrenOf={(n) => n.children} label="Outline"
      />,
    );
    const items = screen.getAllByRole('treeitem');
    expect(() => fireEvent.keyDown(items[3]!, { key: 'ArrowDown', altKey: true })).not.toThrow();
  });
});
