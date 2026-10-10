/**
 * ADR 0774 D6 (`KSTWF-6`) — a drop's POSITION reaches the server.
 *
 * `KanbanBoardView` computes a `{ beforeCardId | afterCardId }` anchor for
 * every drop and hands it to `onMoveCard(cardId, toColumnId, position)`. The
 * `/boards` page wired that prop as `(cardId, toColumnId) => …`, silently
 * dropping the third argument: an in-lane reorder PATCHed nothing, snapped
 * back on the next refetch, and a cross-lane drop landed at the end of the
 * lane. The board view's own tests render it in isolation, so they could not
 * see the page's wiring — this pins the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CardMovePosition } from '../KanbanBoardView.js';

const api = vi.hoisted(() => ({
  listBoardsWithCards: vi.fn(), getPersonalBoard: vi.fn(), listAssignedToMe: vi.fn(),
  subscribeBoardEvents: vi.fn(), getBoard: vi.fn(), patchCard: vi.fn(),
}));
vi.mock('../kanbanClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
vi.mock('../../workflows/workflowsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listWorkflowSummaries: vi.fn(async () => []) };
});
// Its own data (pending reviews) is not what this pins.
vi.mock('../BoardReviewsSection.js', () => ({ BoardReviewsSection: () => null }));
const roster = vi.hoisted(() => ({ listRoster: vi.fn() }));
vi.mock('../../agents/rosterClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listRoster: roster.listRoster };
});

// Capture the move callback the PAGE hands the board, and call it the way the
// board does after a drop.
const captured = vi.hoisted(() => ({
  onMoveCard: null as null | ((cardId: string, toColumnId: string, position?: CardMovePosition) => void),
}));
vi.mock('../KanbanBoardView.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    KanbanBoardView: (props: { onMoveCard: typeof captured.onMoveCard }) => {
      captured.onMoveCard = props.onMoveCard;
      return null;
    },
  };
});

import { KanbanPage } from '../KanbanPage.js';

const BOARD = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }, { id: 'doing', name: 'Doing' }],
  createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z',
};
const CARDS = [
  { id: 'c1', boardId: 'b1', columnId: 'todo', title: 'Alpha', order: 0 },
  { id: 'c2', boardId: 'b1', columnId: 'todo', title: 'Beta', order: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  captured.onMoveCard = null;
  api.listBoardsWithCards.mockResolvedValue([{ ...BOARD, cards: CARDS }]);
  api.getPersonalBoard.mockResolvedValue(null);
  api.listAssignedToMe.mockResolvedValue([]);
  api.subscribeBoardEvents.mockReturnValue(() => {});
  api.getBoard.mockResolvedValue({ board: BOARD, cards: CARDS });
  api.patchCard.mockResolvedValue({ card: CARDS[1], triggeredRunId: null });
  roster.listRoster.mockResolvedValue([]);
});
afterEach(cleanup);

const view = (): void => {
  render(
    <MemoryRouter initialEntries={['/boards/b1']}>
      <Routes><Route path="/boards/:boardId" element={<KanbanPage />} /></Routes>
    </MemoryRouter>,
  );
};

describe('the /boards page forwards the drop position', () => {
  it('an in-lane reorder sends its anchor', async () => {
    view();
    await waitFor(() => expect(captured.onMoveCard).not.toBeNull());
    captured.onMoveCard!('c2', 'todo', { beforeCardId: 'c1' });
    await waitFor(() => expect(api.patchCard).toHaveBeenCalledWith('c2', { columnId: 'todo', beforeCardId: 'c1' }));
  });

  it('a cross-lane drop onto a card sends its anchor', async () => {
    view();
    await waitFor(() => expect(captured.onMoveCard).not.toBeNull());
    captured.onMoveCard!('c1', 'doing', { afterCardId: 'c9' });
    await waitFor(() => expect(api.patchCard).toHaveBeenCalledWith('c1', { columnId: 'doing', afterCardId: 'c9' }));
  });
});
