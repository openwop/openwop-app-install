/**
 * KB-R2-3 (boards round 3) — board verb keys, the Linear `E` / Trello `n`
 * convention. The invariants worth pinning:
 *   - `e` opens the edit form of the card that OWNS FOCUS (not the first card)
 *   - `n` opens the composer in the column that owns focus
 *   - typing guard: keys inside a form field never trigger a verb (polarity)
 *   (A board WITHOUT the affordance no-ops by construction — delegation to the
 *   real button means no button → no action. That is covered by
 *   cardEditCompose "no onEditCard prop ⇒ no edit affordance"; the `n` half is
 *   double-guarded (the composer renders only with onCreateCard), so the case
 *   that pinned it here was cut in /grade-tests wave 37.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';

type BoardProps = ComponentProps<typeof KanbanBoardView>;

const board: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done', terminal: true }],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};
const mkCard = (id: string, columnId: string, title: string): KanbanCard => ({
  id, boardId: 'b1', columnId, title, priority: 'normal', order: 0,
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
});
const cards: KanbanCard[] = [mkCard('c1', 'todo', 'First card'), mkCard('c2', 'done', 'Second card')];

afterEach(cleanup);

function view(): void {
  render(
    <MemoryRouter>
      <KanbanBoardView
        board={board}
        cards={cards}
        onMoveCard={vi.fn<BoardProps['onMoveCard']>()}
        onCreateCard={vi.fn<NonNullable<BoardProps['onCreateCard']>>()}
        onEditCard={vi.fn<NonNullable<BoardProps['onEditCard']>>()}
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

  it('typing a verb key inside a form field is TYPING, not a verb (polarity guard)', () => {
    view();
    fireEvent.keyDown(screen.getByLabelText('Drag First card to another lane'), { key: 'n' });
    const title = screen.getByPlaceholderText('Task title…');
    // `n` typed in the open To-do composer: without the typing guard it falls
    // through to the OTHER column's add button and opens a second composer.
    // (`e` here could never fail — the composer is outside every card, so no
    // edit button is found either way.)
    fireEvent.keyDown(title, { key: 'n' });
    fireEvent.keyDown(title, { key: 'e' });
    expect(screen.getAllByPlaceholderText('Task title…')).toHaveLength(1);
    expect(screen.queryByLabelText('Card title')).toBeNull(); // no edit form opened
  });
});
