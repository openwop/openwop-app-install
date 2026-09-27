/**
 * KB-R2-1 / KB-R2-2 (boards round 2) — in-place card editing + the
 * stays-open composer.
 *
 * KB-R2-1: every leader ships post-creation card editing (Trello's card back,
 * Linear's `E`, GitHub Projects' item panel); our patchCard API accepted every
 * field but no UI ever sent anything except columnId. The edit form must send
 * CHANGED FIELDS ONLY — a minimal PATCH can never clobber a field the user
 * didn't touch — and a no-op edit must not PATCH at all.
 *
 * KB-R2-2: Trello's composer "keeps the composer open for consecutive adds"
 * (support.atlassian.com/trello/docs/adding-cards). Ours closed after every
 * submit, taxing rapid entry with a reopen per card.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';

const board: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done', terminal: true }],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};
const card: KanbanCard = {
  id: 'c1', boardId: 'b1', columnId: 'todo', title: 'Old title',
  description: 'Same desc', priority: 'normal', order: 0,
} as KanbanCard;

afterEach(cleanup);

function view(overrides: { onEditCard?: ReturnType<typeof vi.fn>; onCreateCard?: ReturnType<typeof vi.fn> } = {}): void {
  render(
    <MemoryRouter>
      <KanbanBoardView
        board={board}
        cards={[card]}
        onMoveCard={vi.fn()}
        onCreateCard={overrides.onCreateCard}
        onEditCard={overrides.onEditCard}
      />
    </MemoryRouter>,
  );
}

describe('KB-R2-1 — in-place card edit sends changed fields only', () => {
  it('a title change PATCHes the title and ONLY the title', () => {
    const onEditCard = vi.fn();
    view({ onEditCard });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Old title' }));
    fireEvent.change(screen.getByLabelText('Card title'), { target: { value: 'New title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEditCard).toHaveBeenCalledTimes(1);
    // Changed-fields-only: untouched description/priority must be ABSENT, not
    // re-sent — re-sending them is how an edit clobbers a concurrent change.
    expect(onEditCard).toHaveBeenCalledWith('c1', { title: 'New title' });
  });

  it('a no-op edit never PATCHes; cancel discards a typed change', () => {
    const onEditCard = vi.fn();
    view({ onEditCard });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Old title' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEditCard).not.toHaveBeenCalled();
    // Cancel polarity: a typed-then-cancelled edit must also not PATCH.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Old title' }));
    fireEvent.change(screen.getByLabelText('Card title'), { target: { value: 'Discarded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onEditCard).not.toHaveBeenCalled();
    // The card still shows its real title (the edit form closed).
    expect(screen.getByText('Old title')).toBeTruthy();
  });

  it('a peer\'s concurrent rename is NOT clobbered by an unrelated save', () => {
    // The two-editor case the single-instance flow masks: the board refetches
    // every 5s, so the card prop can change UNDER an open form. The diff
    // baseline must be what the user SAW at open time — diffing against the
    // live prop would make the untouched stale title read as "changed" and
    // PATCH the old value back over the peer's rename.
    const onEditCard = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <KanbanBoardView board={board} cards={[card]} onMoveCard={vi.fn()} onEditCard={onEditCard} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Old title' }));
    rerender(
      <MemoryRouter>
        <KanbanBoardView board={board} cards={[{ ...card, title: 'Peer renamed' }]} onMoveCard={vi.fn()} onEditCard={onEditCard} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEditCard).toHaveBeenCalledTimes(1);
    expect(onEditCard).toHaveBeenCalledWith('c1', { priority: 'high' });
  });

  it('no onEditCard prop ⇒ no edit affordance (read-only surfaces stay read-only)', () => {
    view({});
    expect(screen.queryByRole('button', { name: 'Edit Old title' })).toBeNull();
  });
});

describe('KB-R2-2 — the add-card composer stays open for consecutive adds', () => {
  it('submit creates the card, clears the field, and keeps the composer open', () => {
    const onCreateCard = vi.fn();
    view({ onCreateCard });
    fireEvent.click(screen.getAllByRole('button', { name: '+ Add card' })[0]!);
    const title = screen.getByPlaceholderText('Task title…');
    fireEvent.change(title, { target: { value: 'First card' } });
    fireEvent.submit(title.closest('form')!);
    expect(onCreateCard).toHaveBeenCalledWith('todo', expect.objectContaining({ title: 'First card' }));
    // The Trello parity: the composer is STILL open with an empty title, ready
    // for the next card — no re-open tax on rapid entry.
    const after = screen.getByPlaceholderText('Task title…');
    expect((after as HTMLInputElement).value).toBe('');
    // Cancel is the close path.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Task title…')).toBeNull();
  });
});
