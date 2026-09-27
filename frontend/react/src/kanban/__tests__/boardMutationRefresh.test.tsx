/**
 * KB-R2-5 / KB-BULK follow-up — the RENDERED board must refresh after a
 * mutation, not just the boards list.
 *
 * Found by browser-testing the live deploy (2026-08-02), NOT by the unit
 * suites: `wipLimit.test.tsx` and `boardBulkActions.test.tsx` exercise
 * `KanbanBoardView` in ISOLATION with props, so the page's refresh wiring was
 * never covered. On the live app the WIP limit persisted server-side (the
 * board API returned `todo:1`) while the column readout kept showing the bare
 * count until a manual reload — because `refreshBoards()` repopulates the
 * boards LIST (`setBoards`) and the view renders from `activeBoard`, which
 * only `openBoard()` (→ `getBoard`) refreshes.
 *
 * The house pattern every sibling mutation already followed is
 * `openBoard(id)` THEN `refreshBoards()` (see `onEditCard`). These tests pin
 * it for the two handlers that skipped it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listBoardsWithCards: vi.fn(), getPersonalBoard: vi.fn(), listAssignedToMe: vi.fn(),
  subscribeBoardEvents: vi.fn(), getBoard: vi.fn(), setColumnLimit: vi.fn(), deleteCard: vi.fn(),
}));
vi.mock('../kanbanClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const roster = vi.hoisted(() => ({ listRoster: vi.fn() }));
vi.mock('../../agents/rosterClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listRoster: roster.listRoster };
});
vi.mock('../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

import { KanbanPage } from '../KanbanPage.js';

const BOARD = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do' }],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};
const CARDS = [{ id: 'c1', boardId: 'b1', columnId: 'todo', title: 'Alpha', priority: 'normal', order: 0 }];

beforeEach(() => {
  vi.clearAllMocks();
  api.listBoardsWithCards.mockResolvedValue([{ ...BOARD, cards: CARDS }]); // FLAT board + cards
  api.getPersonalBoard.mockResolvedValue(null);
  api.listAssignedToMe.mockResolvedValue([]);
  api.subscribeBoardEvents.mockReturnValue(() => {});
  api.getBoard.mockResolvedValue({ board: BOARD, cards: CARDS });
  api.setColumnLimit.mockResolvedValue({ ...BOARD, columns: [{ id: 'todo', name: 'To do', wipLimit: 1 }] });
  api.deleteCard.mockResolvedValue(undefined);
  roster.listRoster.mockResolvedValue([]);
});
afterEach(cleanup);

const view = (): void => {
  // A real <Routes> wrapper — the page reads :boardId via useParams, which
  // `initialEntries` alone does NOT populate.
  render(
    <MemoryRouter initialEntries={['/boards/b1']}>
      <Routes><Route path="/boards/:boardId" element={<KanbanPage />} /></Routes>
    </MemoryRouter>,
  );
};

describe('mutations refresh the RENDERED board', () => {
  it('setting a WIP limit re-reads the active board (not only the list)', async () => {
    view();
    await screen.findByRole('button', { name: /work-in-progress limit for To do/i });
    const before = api.getBoard.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /work-in-progress limit for To do/i }));
    fireEvent.change(screen.getByLabelText(/Limit/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));

    await waitFor(() => expect(api.setColumnLimit).toHaveBeenCalledWith('b1', 'todo', 1));
    // The pin: getBoard (openBoard) runs AGAIN after the write. Without it the
    // limit persists server-side but the column readout is stale until reload.
    await waitFor(() => expect(api.getBoard.mock.calls.length).toBeGreaterThan(before));
  });

  it('bulk delete re-reads the active board so removed cards leave the screen', async () => {
    view();
    const grip = await screen.findByLabelText('Drag Alpha to another lane');
    const before = api.getBoard.mock.calls.length;

    fireEvent.keyDown(grip, { key: 'x' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 1' }));

    await waitFor(() => expect(api.deleteCard).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(api.getBoard.mock.calls.length).toBeGreaterThan(before));
  });
});
