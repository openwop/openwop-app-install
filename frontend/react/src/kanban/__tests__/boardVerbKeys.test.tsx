/**
 * KB-R2-3 (boards round 3) — board verb keys, the Linear `E` / Trello `n`
 * convention. The invariants worth pinning:
 *   - `e` opens the edit form of the card that OWNS FOCUS (not the first card)
 *   - `n` opens the composer in the column that owns focus
 *   - typing guard: keys inside a form field never trigger a verb (polarity)
 *   - a board without the affordance no-ops by construction (delegation to
 *     the real button means no button → no action, no crash)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';

const board: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done', terminal: true }],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
} as KanbanBoard;
const cards: KanbanCard[] = [
  { id: 'c1', boardId: 'b1', columnId: 'todo', title: 'First card', priority: 'normal', order: 0 } as KanbanCard,
  { id: 'c2', boardId: 'b1', columnId: 'done', title: 'Second card', priority: 'normal', order: 0 } as KanbanCard,
];

afterEach(cleanup);

function view(overrides: { onEditCard?: ReturnType<typeof vi.fn> | undefined; onCreateCard?: ReturnType<typeof vi.fn> | undefined } = { onEditCard: vi.fn(), onCreateCard: vi.fn() }): void {
  render(
    <MemoryRouter>
      <KanbanBoardView
        board={board}
        cards={cards}
        onMoveCard={vi.fn()}
        onCreateCard={overrides.onCreateCard}
        onEditCard={overrides.onEditCard}
      />
    </MemoryRouter>,
  );
}

describe('KB-R2-3 — board verb keys', () => {
  it('`e` edits the card that owns focus — the SECOND card, not the first', () => {
    view();
    const grip = screen.getByLabelText('Drag Second card to another lane');
    fireEvent.keyDown(grip, { key: 'e' });
    // The edit form is open for c2: its title field carries the card's title.
    expect((screen.getByLabelText('Card title') as HTMLInputElement).value).toBe('Second card');
  });

  it('`n` opens the composer in the column that owns focus', () => {
    view();
    const grip = screen.getByLabelText('Drag Second card to another lane');
    fireEvent.keyDown(grip, { key: 'n' });
    // c2 sits in "Done" — the composer must appear in THAT column.
    const doneCol = screen.getByText('Done').closest('.kb-col') as HTMLElement;
    expect(within(doneCol).getByPlaceholderText('Task title…')).toBeTruthy();
  });

  it('typing `e` inside a form field is TYPING, not a verb (polarity guard)', () => {
    view();
    fireEvent.keyDown(screen.getByLabelText('Drag First card to another lane'), { key: 'n' });
    const title = screen.getByPlaceholderText('Task title…');
    fireEvent.keyDown(title, { key: 'e' });
    expect(screen.queryByLabelText('Card title')).toBeNull(); // no edit form opened
  });

  it('a board without edit/create affordances no-ops on both keys', () => {
    view({ onEditCard: undefined, onCreateCard: undefined });
    const grip = screen.getByLabelText('Drag First card to another lane');
    fireEvent.keyDown(grip, { key: 'e' });
    fireEvent.keyDown(grip, { key: 'n' });
    expect(screen.queryByLabelText('Card title')).toBeNull();
    expect(screen.queryByPlaceholderText('Task title…')).toBeNull();
  });
});
