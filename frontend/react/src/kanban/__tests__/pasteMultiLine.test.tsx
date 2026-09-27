/**
 * KB-R2-4 — paste-multi-line card creation (Trello's convention: paste into
 * the composer, one card per line, behind a CONFIRMATION — never a silent
 * split). Invariants:
 *   - single-line paste: the default paste, no prompt (polarity)
 *   - multi-line paste: prompt; Create makes one card per non-empty line and
 *     the composer stays open
 *   - Keep as one line: joins into the input, creates NOTHING
 *   - the cap is honest: >25 lines label says "first 25" and only 25 create
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard } from '../kanbanClient.js';

const board: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
} as KanbanBoard;

afterEach(cleanup);

function openComposer(onCreateCard: ReturnType<typeof vi.fn>): HTMLInputElement {
  render(
    <MemoryRouter>
      <KanbanBoardView board={board} cards={[]} onMoveCard={vi.fn()} onCreateCard={onCreateCard} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: '+ Add card' }));
  return screen.getByPlaceholderText('Task title…') as HTMLInputElement;
}

const paste = (el: HTMLElement, text: string): void => {
  fireEvent.paste(el, { clipboardData: { getData: () => text } });
};

describe('KB-R2-4 — paste-multi-line', () => {
  it('single-line paste: no prompt (the default paste path)', () => {
    const onCreateCard = vi.fn();
    const input = openComposer(onCreateCard);
    paste(input, 'just one task');
    expect(screen.queryByText(/Pasted/)).toBeNull();
    expect(onCreateCard).not.toHaveBeenCalled();
  });

  it('multi-line paste prompts; Create makes one card per NON-EMPTY line, composer stays open', () => {
    const onCreateCard = vi.fn();
    const input = openComposer(onCreateCard);
    paste(input, 'alpha\n\n  beta  \ngamma\n');
    expect(screen.getByText('Pasted 3 lines.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create 3 cards' }));
    expect(onCreateCard).toHaveBeenCalledTimes(3);
    expect(onCreateCard.mock.calls.map((c) => c[1].title)).toEqual(['alpha', 'beta', 'gamma']);
    expect(onCreateCard.mock.calls.every((c) => c[0] === 'todo')).toBe(true);
    expect(screen.getByPlaceholderText('Task title…')).toBeTruthy(); // composer still open
    expect(screen.queryByText(/Pasted/)).toBeNull(); // prompt consumed
  });

  it('Keep as one line joins into the input and creates NOTHING', () => {
    const onCreateCard = vi.fn();
    const input = openComposer(onCreateCard);
    paste(input, 'alpha\nbeta');
    fireEvent.click(screen.getByRole('button', { name: 'Keep as one line' }));
    expect((screen.getByPlaceholderText('Task title…') as HTMLInputElement).value).toBe('alpha beta');
    expect(onCreateCard).not.toHaveBeenCalled();
  });

  it('the cap is honest: 30 lines → "first 25" label, exactly 25 created', () => {
    const onCreateCard = vi.fn();
    const input = openComposer(onCreateCard);
    paste(input, Array.from({ length: 30 }, (_, i) => `task ${i + 1}`).join('\n'));
    expect(screen.getByText('Pasted 30 lines.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create the first 25 cards' }));
    expect(onCreateCard).toHaveBeenCalledTimes(25);
    expect(onCreateCard.mock.calls[24]?.[1].title).toBe('task 25');
  });
});
