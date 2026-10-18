/**
 * KBV-MOVE-1 — an optimistic move keeps the moved card, in its TARGET lane.
 *
 * `moveCard` rebuilt local state from `remaining` (every card EXCEPT the moved
 * one) after splicing the moved card into its destination lane, so the card
 * vanished from the board until the parent re-sent `cards`. `/boards` refetches
 * and hid it; a bulk move before that refetch did not. Here the parent never
 * re-sends, so only local state can show the card.
 *
 * The regression witness from grade-tests wave 37 (fix 2c8a05b96). Its stronger
 * single-card twin is `boardBulkActions.test.tsx` › "KBV-MOVE-1 — a bulk-moved
 * card stays on the board, in its target lane"; this file keeps the TWO-card
 * bulk move (both cards must land, neither may stay behind) and the untouched
 * card's lane. Sabotage: map over `remaining` again → both moved cards vanish;
 * drop `columnId: toColumnId` from the rebuilt card → they stay in "To do".
 * (w42 probe w42g2-mk-lane was vacuous while this only asserted presence.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock('../../ui/announce.js', () => ({ announce: vi.fn() }));

import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';

const STAMP = '2026-08-01T00:00:00Z';
const board: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done', terminal: true }],
  createdAt: STAMP, updatedAt: STAMP,
};
const mkCard = (id: string, columnId: string, title: string, order: number): KanbanCard => ({
  id, boardId: 'b1', columnId, title, priority: 'normal', order, createdAt: STAMP, updatedAt: STAMP,
});
const cards: KanbanCard[] = [
  mkCard('c1', 'todo', 'Alpha', 0),
  mkCard('c2', 'todo', 'Beta', 1),
  mkCard('c3', 'done', 'Gamma', 0),
];

afterEach(cleanup);

type MoveCard = NonNullable<ComponentProps<typeof KanbanBoardView>['onMoveCard']>;
const gripLabel = (title: string): string => `Drag ${title} to another lane`;
const lane = (columnId: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-column-id="${columnId}"]`);
  if (!el) throw new Error(`lane ${columnId} not rendered`);
  return el;
};

describe('KBV-MOVE-1 — a moved card stays on the board', () => {
  it('a bulk move keeps every moved card in local state, in its target lane', () => {
    const onMoveCard = vi.fn<MoveCard>();
    render(
      <MemoryRouter>
        <KanbanBoardView board={board} cards={cards} onMoveCard={onMoveCard} />
      </MemoryRouter>,
    );
    fireEvent.keyDown(screen.getByLabelText(gripLabel('Alpha')), { key: 'x' });
    fireEvent.keyDown(screen.getByLabelText(gripLabel('Beta')), { key: 'x' });
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions for selected cards' });
    fireEvent.change(within(bar).getByLabelText('Move to'), { target: { value: 'done' } });

    expect(onMoveCard).toHaveBeenCalledTimes(2);
    // Both moved cards are in "Done" (alongside the card already there)…
    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      expect(within(lane('done')).getByLabelText(gripLabel(title))).toBeTruthy();
    }
    // …and none stayed behind in "To do".
    for (const title of ['Alpha', 'Beta']) {
      expect(within(lane('todo')).queryByLabelText(gripLabel(title))).toBeNull();
    }
  });
});
