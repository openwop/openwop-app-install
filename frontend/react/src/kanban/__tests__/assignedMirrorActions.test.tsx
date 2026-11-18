/**
 * ADR 1138 D1–D3 — the "Assigned to me" mirror can finish and open a card, and
 * says when it is due.
 *
 *   - a card I hold offers Done, which hands the card (with its completion lane)
 *     to the page; an unclaimed role card offers Claim instead, never Done;
 *   - a card with no completion lane, or already finished, offers no Done;
 *   - `sourceRef` renders an Open link to its app path;
 *   - the due state is said in words: overdue, due soon, or the plain date.
 *
 * Red if Done shows on an unclaimed or finished card, the Open link is missing or
 * points elsewhere, or the overdue/soon thresholds move.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssignedColumn } from '../AssignedColumn.js';
import { dueStateOf } from '../CardDue.js';
import type { AssignedCard } from '../kanbanClient.js';

afterEach(cleanup);

const base: AssignedCard = {
  id: 'c1', boardId: 'b1', columnId: 'todo', title: 'Order the sofa', order: 0,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  boardName: 'Lake house', columnName: 'To Do', terminal: false, assigneeId: 'user:me', doneColumnId: 'done',
};

// exactOptionalPropertyTypes forbids `key: undefined`, so the unset cards drop the key.
const { assigneeId: _noAssignee, ...unassigned } = base;
const { doneColumnId: _noLane, ...noLane } = base;

function renderRail(cards: AssignedCard[], onDone = vi.fn()) {
  render(
    <MemoryRouter>
      <AssignedColumn cards={cards} busyId={null} highlightId={null} onClaim={vi.fn()} onDone={onDone} />
    </MemoryRouter>,
  );
  return onDone;
}

describe('ADR 1138 — mirror actions', () => {
  it('Done on a card I hold hands that card to the page', () => {
    const onDone = renderRail([base]);
    fireEvent.click(screen.getByRole('button', { name: /Order the sofa/ }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', doneColumnId: 'done' }));
  });

  it('no Done on an unclaimed role card, a finished card, or a board without a completion lane', () => {
    renderRail([
      { ...unassigned, id: 'r', title: 'Role card', assigneeRole: 'project:lead' },
      { ...base, id: 'f', title: 'Finished card', terminal: true },
      { ...noLane, id: 'n', title: 'No lane card' },
    ]);
    expect(screen.queryByRole('button', { name: /Role card/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Finished card/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /No lane card/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Claim/ })).toBeTruthy();
  });

  it('renders the Open link to the card\'s source path', () => {
    renderRail([{ ...base, sourceRef: { label: 'Selections', path: '/projects/p1?tab=selections' } }]);
    const link = screen.getByRole('link', { name: /Selections/ });
    expect(link.getAttribute('href')).toBe('/projects/p1?tab=selections');
  });

  it('says the due state in words', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(dueStateOf('2026-11-14T00:00:00Z', now)).toBe('overdue');
    expect(dueStateOf('2026-11-17T00:00:00Z', now)).toBe('soon');
    expect(dueStateOf('2026-11-20T00:00:00Z', now)).toBe('later');
    expect(dueStateOf('not a date', now)).toBeNull();
  });
});
