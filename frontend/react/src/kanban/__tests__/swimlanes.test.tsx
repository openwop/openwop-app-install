/**
 * ADR 1155 D7 — swimlanes. A drop into another lane sets the card's group-by facet to
 * that lane's value; a drop into the "none" lane clears it; a drop within a lane only
 * moves the card. The board renders one lane per value, the "none" lane last.
 *
 * Red if: a cross-lane drop only moves the column (the facet is lost), a same-lane drop
 * rewrites the facet, the "none" lane does not clear, or the lanes render wrong.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CARD_DROP_PREFIX, KanbanBoardView, laneDropId, resolveDrop } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';

const AT = '2026-11-23T00:00:00.000Z';
const BOARD: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'House', columns: [{ id: 'todo', name: 'To Do' }, { id: 'done', name: 'Done' }], createdAt: AT, updatedAt: AT,
};
const card = (id: string, columnId: string, room?: string): KanbanCard => ({
  id, boardId: 'b1', columnId, title: id, order: 1, createdAt: AT, updatedAt: AT, ...(room ? { facets: { room } } : {}),
});
const CARDS = [card('k1', 'todo', 'kitchen'), card('k2', 'done', 'kitchen'), card('b1c', 'todo', 'bath'), card('n1', 'todo')];

describe('resolveDrop', () => {
  const drop = (activeId: string, overId: string, after = false) => resolveDrop({ activeId, overId, cards: CARDS, groupBy: 'room', after });

  it('a drop into another lane regroups; into its own lane it only moves', () => {
    expect(drop('k1', laneDropId('bath', 'done'))).toEqual({ kind: 'regroup', columnId: 'done', lane: 'bath', facets: { room: 'bath' } });
    expect(drop('k1', laneDropId('kitchen', 'done'))).toEqual({ kind: 'move', columnId: 'done' });
  });

  it('a drop into the "none" lane clears; a card without a value moves into a lane', () => {
    expect(drop('k1', laneDropId('', 'todo'))).toEqual({ kind: 'regroup', columnId: 'todo', lane: '', facets: { room: null } });
    expect(drop('n1', laneDropId('kitchen', 'todo'))).toEqual({ kind: 'regroup', columnId: 'todo', lane: 'kitchen', facets: { room: 'kitchen' } });
  });

  it('a drop onto a card takes that card\'s lane and position', () => {
    expect(drop('k1', `${CARD_DROP_PREFIX}b1c`, true)).toEqual({ kind: 'regroup', columnId: 'todo', lane: 'bath', facets: { room: 'bath' }, position: { afterCardId: 'b1c' } });
    expect(drop('k1', `${CARD_DROP_PREFIX}k2`)).toEqual({ kind: 'move', columnId: 'done', position: { beforeCardId: 'k2' } });
    expect(drop('k1', `${CARD_DROP_PREFIX}k1`)).toBeNull();
  });

  it('an ungrouped board never regroups', () => {
    expect(resolveDrop({ activeId: 'k1', overId: 'done', cards: CARDS, groupBy: undefined, after: false })).toEqual({ kind: 'move', columnId: 'done' });
  });

  it('a lane name with a colon or spaces survives the drop id', () => {
    const odd = [...CARDS, card('o1', 'todo', 'r:1 / west')];
    expect(resolveDrop({ activeId: 'k1', overId: laneDropId('r:1 / west', 'todo'), cards: odd, groupBy: 'room', after: false }))
      .toEqual({ kind: 'regroup', columnId: 'todo', lane: 'r:1 / west', facets: { room: 'r:1 / west' } });
  });
});

describe('KanbanBoardView with groupBy', () => {
  it('renders one lane per value, sorted, with the "none" lane last', () => {
    render(<MemoryRouter><KanbanBoardView board={BOARD} cards={CARDS} onMoveCard={vi.fn()} groupBy="room" onRegroupCard={vi.fn()} /></MemoryRouter>);
    const lanes = screen.getAllByRole('region');
    expect(lanes.map((l) => within(l).getByRole('heading').textContent)).toEqual(['bath1', 'kitchen2', 'No value1']);
  });

  it('renders plain columns without groupBy', () => {
    render(<MemoryRouter><KanbanBoardView board={BOARD} cards={CARDS} onMoveCard={vi.fn()} /></MemoryRouter>);
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });
});
