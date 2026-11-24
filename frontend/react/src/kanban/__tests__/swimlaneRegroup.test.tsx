/**
 * ADR 1155 D7 — the /boards page sends a swimlane drop as ONE card PATCH: the column
 * and the group-by facet together, so it gets the same permission check and CAS as a
 * facet edit. A refused drop restores the card and refetches the board.
 *
 * Red if: the facet and the move travel as two writes, the facet is dropped, the
 * "none" lane does not send `null`, or a refused drop leaves the card regrouped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CardMovePosition } from '../KanbanBoardView.js';
import type { KanbanCard } from '../kanbanClient.js';

const api = vi.hoisted(() => ({
  listBoardsWithCards: vi.fn(), getPersonalBoard: vi.fn(), listAssignedToMe: vi.fn(),
  subscribeBoardEvents: vi.fn(), getBoard: vi.fn(), patchCard: vi.fn(),
}));
vi.mock('../kanbanClient.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...api }));
vi.mock('../../workflows/workflowsClient.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), listWorkflowSummaries: vi.fn(async () => []) }));
vi.mock('../BoardReviewsSection.js', () => ({ BoardReviewsSection: () => null }));
const roster = vi.hoisted(() => ({ listRoster: vi.fn() }));
vi.mock('../../agents/rosterClient.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), listRoster: roster.listRoster }));

type Regroup = (cardId: string, toColumnId: string, facets: Record<string, string | null>, position?: CardMovePosition) => void;
const captured = vi.hoisted(() => ({ onRegroupCard: null as null | Regroup, groupBy: undefined as string | undefined, cards: [] as KanbanCard[] }));
vi.mock('../KanbanBoardView.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  KanbanBoardView: (props: { onRegroupCard?: Regroup; groupBy?: string; cards: KanbanCard[] }) => {
    captured.onRegroupCard = props.onRegroupCard ?? null;
    captured.groupBy = props.groupBy;
    captured.cards = props.cards;
    return null;
  },
}));

import { KanbanPage } from '../KanbanPage.js';

const AT = '2026-11-23T00:00:00.000Z';
const BOARD = { id: 'b1', tenantId: 't1', name: 'House', columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }], groupBy: 'room', createdAt: AT, updatedAt: AT };
const CARDS: KanbanCard[] = [{ id: 'c1', boardId: 'b1', columnId: 'todo', title: 'Tile', order: 1, createdAt: AT, updatedAt: AT, facets: { room: 'kitchen' } }];

beforeEach(() => {
  vi.clearAllMocks();
  captured.onRegroupCard = null;
  api.listBoardsWithCards.mockResolvedValue([{ ...BOARD, cards: CARDS }]);
  api.getPersonalBoard.mockResolvedValue(null);
  api.listAssignedToMe.mockResolvedValue([]);
  api.subscribeBoardEvents.mockReturnValue(() => {});
  api.getBoard.mockResolvedValue({ board: BOARD, cards: CARDS });
  api.patchCard.mockResolvedValue({ card: CARDS[0], triggeredRunId: null });
  roster.listRoster.mockResolvedValue([]);
});
afterEach(cleanup);

const view = (url = '/boards/b1'): void => {
  render(<MemoryRouter initialEntries={[url]}><Routes><Route path="/boards/:boardId" element={<KanbanPage />} /></Routes></MemoryRouter>);
};

describe('the /boards page and swimlane drops', () => {
  it('uses the board\'s default grouping, and the URL overrides it', async () => {
    view();
    await waitFor(() => expect(captured.groupBy).toBe('room'));
    cleanup();
    captured.onRegroupCard = null;
    captured.groupBy = 'stale';
    view('/boards/b1?groupBy=');
    await waitFor(() => expect(captured.groupBy).toBeUndefined());
  });

  it('sends the column and the facet in one PATCH; the "none" lane sends null', async () => {
    view();
    await waitFor(() => expect(captured.onRegroupCard).not.toBeNull());
    captured.onRegroupCard!('c1', 'done', { room: 'bath' });
    await waitFor(() => expect(api.patchCard).toHaveBeenCalledWith('c1', { columnId: 'done', facets: { room: 'bath' } }));
    captured.onRegroupCard!('c1', 'todo', { room: null }, { beforeCardId: 'c9' });
    await waitFor(() => expect(api.patchCard).toHaveBeenLastCalledWith('c1', { columnId: 'todo', facets: { room: null }, beforeCardId: 'c9' }));
    expect(api.patchCard).toHaveBeenCalledTimes(2);
  });

  it('a refused drop restores the card and refetches the board', async () => {
    api.patchCard.mockRejectedValueOnce(Object.assign(new Error('patchCard returned 403'), { status: 403 }));
    view();
    await waitFor(() => expect(captured.onRegroupCard).not.toBeNull());
    const reads = api.getBoard.mock.calls.length;
    captured.onRegroupCard!('c1', 'done', { room: 'bath' });
    await waitFor(() => expect(api.getBoard.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(captured.cards.find((c) => c.id === 'c1')?.facets).toEqual({ room: 'kitchen' }));
  });
});
