import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabStrip, tabButtonId, tabPanelId } from '../TabStrip.js';

function setup(overrides: Partial<Parameters<typeof TabStrip>[0]> = {}) {
  const props = {
    tabs: [
      { sessionId: 'a', pinned: false },
      { sessionId: 'b', pinned: true },
    ],
    activeSessionId: 'a',
    titleFor: (sid: string) => `Title ${sid}`,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    onSetPinned: vi.fn(),
    onNewTab: vi.fn(),
    onOpenLibrary: vi.fn(),
    ...overrides,
  };
  render(<TabStrip {...props} />);
  return props;
}

describe('TabStrip — APG tablist (ADR 0140 P4)', () => {
  it('renders role=tablist + role=tab with aria-selected and tab↔panel wiring', () => {
    setup();
    expect(screen.getByRole('tablist')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    const a = tabs.find((el) => el.getAttribute('data-sid') === 'a')!;
    expect(a.getAttribute('aria-selected')).toBe('true');
    expect(a.id).toBe(tabButtonId('a'));
    expect(a.getAttribute('aria-controls')).toBe(tabPanelId('a'));
  });

  it('roving tabindex: only the active tab is in the tab order', () => {
    setup();
    const tabs = screen.getAllByRole('tab');
    const a = tabs.find((el) => el.getAttribute('data-sid') === 'a')!;
    const b = tabs.find((el) => el.getAttribute('data-sid') === 'b')!;
    expect(a.getAttribute('tabindex')).toBe('0'); // active
    expect(b.getAttribute('tabindex')).toBe('-1'); // background
  });

  it('clicking a tab focuses it; clicking close/new-tab fires their callbacks', () => {
    const p = setup();
    fireEvent.click(screen.getAllByRole('tab').find((el) => el.getAttribute('data-sid') === 'b')!);
    expect(p.onFocus).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('button', { name: 'Close Title a' }));
    expect(p.onClose).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(p.onNewTab).toHaveBeenCalled();
  });

  it('pin toggle reflects state and toggles via onSetPinned', () => {
    const p = setup();
    // 'a' is unpinned → label "Pin Title a"; 'b' is pinned → "Unpin Title b".
    fireEvent.click(screen.getByRole('button', { name: 'Pin Title a' }));
    expect(p.onSetPinned).toHaveBeenCalledWith('a', true);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Title b' }));
    expect(p.onSetPinned).toHaveBeenCalledWith('b', false);
  });

  it('Delete on a focused tab closes it (keyboard path)', () => {
    const p = setup();
    const a = screen.getAllByRole('tab').find((el) => el.getAttribute('data-sid') === 'a')!;
    a.focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Delete' });
    expect(p.onClose).toHaveBeenCalledWith('a');
  });

  it('keyboard close moves focus to the now-active neighbour tab', () => {
    const base = {
      titleFor: (sid: string) => `Title ${sid}`,
      onFocus: vi.fn(), onClose: vi.fn(), onReorder: vi.fn(), onSetPinned: vi.fn(), onNewTab: vi.fn(),
    };
    const { rerender } = render(
      <TabStrip tabs={[{ sessionId: 'a', pinned: false }, { sessionId: 'b', pinned: false }]} activeSessionId="a" {...base} />,
    );
    screen.getAllByRole('tab').find((el) => el.getAttribute('data-sid') === 'a')!.focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Delete' });
    // Parent reacts: closes 'a', activates the neighbour 'b'. The keyboard-close flag
    // makes the effect land focus on b's tab.
    rerender(<TabStrip tabs={[{ sessionId: 'b', pinned: false }]} activeSessionId="b" {...base} />);
    expect(document.activeElement).toBe(screen.getByRole('tab'));
  });

  it('Delete does NOT close when focus is not on a tab', () => {
    const p = setup();
    // Focus the new-tab button (a button, not a role=tab).
    screen.getByRole('button', { name: 'New chat' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Delete' });
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('off-screen blocked tab surfaces an edge cue that scrolls it into view (G5)', () => {
    const rect = (left: number, right: number): DOMRect =>
      ({ left, right, top: 0, bottom: 30, width: right - left, height: 30, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    // viewport [0,100]; tab 'a' in view [0,80]; blocked tab 'b' past the right edge [200,280].
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList?.contains('tabdeck-strip__scroll')) return rect(0, 100);
      return this.getAttribute?.('data-sid') === 'b' ? rect(200, 280) : rect(0, 80);
    });
    try {
      setup({ blockedSids: new Set(['b']) });
      const cue = screen.getByRole('button', { name: /off-screen|waiting/i });
      expect(cue.className).toContain('blocked-cue--right');
      const b = screen.getAllByRole('tab').find((el) => el.getAttribute('data-sid') === 'b')!;
      const scrollIntoView = vi.fn();
      (b as HTMLElement).scrollIntoView = scrollIntoView;
      fireEvent.click(cue);
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('renders no edge cue when no blocked tab is off-screen', () => {
    setup({ blockedSids: new Set() });
    expect(screen.queryByRole('button', { name: /off-screen|waiting/i })).toBeNull();
  });

  it('pop-out opens a persisted conversation, and is disabled for an unsaved tab (G6)', () => {
    const onPopOut = vi.fn();
    // 'a' is persisted, 'b' is not.
    setup({ onPopOut, canPopOut: (sid: string) => sid === 'a' });
    const popA = screen.getByRole('button', { name: 'Open Title a in a new window' });
    const popB = screen.getByRole('button', { name: 'Open Title b in a new window' });
    expect((popB as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(popA);
    expect(onPopOut).toHaveBeenCalledWith('a');
  });

  it('hides the pop-out control when onPopOut is not supplied', () => {
    setup();
    expect(screen.queryByRole('button', { name: /in a new window/i })).toBeNull();
  });

  it('double-click a tab renames it (commit on Enter)', () => {
    const onRename = vi.fn();
    setup({ onRename });
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Title a' }));
    const input = screen.getByRole('textbox', { name: 'Rename Title a' });
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('a', 'Renamed');
  });

  it('Escape cancels the rename without calling onRename', () => {
    const onRename = vi.fn();
    setup({ onRename });
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Title a' }));
    const input = screen.getByRole('textbox', { name: 'Rename Title a' });
    fireEvent.change(input, { target: { value: 'X' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('F2 on the focused tab starts the rename (keyboard path)', () => {
    const onRename = vi.fn();
    setup({ onRename });
    (screen.getByRole('tab', { name: 'Title a' }) as HTMLElement).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'F2' });
    expect(screen.getByRole('textbox', { name: 'Rename Title a' })).toBeTruthy();
  });

  it('no rename affordance (no input) when onRename is absent', () => {
    setup();
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Title a' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
