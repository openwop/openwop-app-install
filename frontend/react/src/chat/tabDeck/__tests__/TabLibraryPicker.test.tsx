import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { TabLibraryPicker } from '../TabLibraryPicker.js';

/** Unit tests for the library picker's rename/delete logic (the deck wires it; this
 *  pins the trailing-blur commit guard the code-review flagged). */

const CONVS = [
  { sessionId: 'a', title: 'Alpha' },
  { sessionId: 'b', title: 'Beta' },
] as never[];

function setup(over: Partial<Parameters<typeof TabLibraryPicker>[0]> = {}) {
  const props = {
    conversations: CONVS,
    openIds: new Set<string>(),
    onOpen: vi.fn(),
    onRename: vi.fn(() => Promise.resolve()),
    onDelete: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
    ...over,
  };
  render(<TabLibraryPicker {...props} />);
  return props;
}
const pencil = (title: string) => screen.getByTitle(`Rename ${title}`);

beforeEach(() => { /* fresh */ });
afterEach(() => cleanup());

describe('TabLibraryPicker', () => {
  it('selecting a conversation opens it and closes the picker', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(p.onOpen).toHaveBeenCalledWith('b');
    expect(p.onClose).toHaveBeenCalled();
  });

  it('filters by the search query', () => {
    setup();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bet' } });
    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
  });

  it('rename: Escape cancels (no onRename); Enter commits exactly once', async () => {
    const p = setup();
    // Escape → cancel, no commit (the trailing blur must NOT commit).
    fireEvent.click(pencil('Alpha'));
    let input = screen.getByRole('textbox') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'Alpha 2' } }); fireEvent.keyDown(input, { key: 'Escape' }); });
    expect(p.onRename).not.toHaveBeenCalled();

    // Enter → commit once (Enter then the unmount blur must not double-fire).
    fireEvent.click(pencil('Alpha'));
    input = screen.getByRole('textbox') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'Renamed' } }); fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(p.onRename).toHaveBeenCalledTimes(1);
    expect(p.onRename).toHaveBeenCalledWith('a', 'Renamed');
  });

  it('delete: confirms then calls onDelete', async () => {
    const origConfirm = window.confirm;
    window.confirm = () => true; // confirm() falls back to window.confirm when no host is mounted
    try {
      const p = setup();
      await act(async () => { fireEvent.click(screen.getByTitle('Delete Beta')); });
      expect(p.onDelete).toHaveBeenCalledWith('b');
    } finally {
      window.confirm = origConfirm;
    }
  });
});
