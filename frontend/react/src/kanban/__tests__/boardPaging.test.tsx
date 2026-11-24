/**
 * ADR 1155 D7 — the board view loads a large board one page per column.
 *
 * Red if: a small board, or a host that cannot page, stops loading whole; a large
 * board loads whole, or a column's page ignores its column; a refresh drops cards
 * the viewer already opened; or Show more renders on a complete column.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanBoard, KanbanBoardRead, KanbanCard } from '../kanbanClient.js';

const api = vi.hoisted(() => ({ getBoard: vi.fn() }));
vi.mock('../kanbanClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoard: api.getBoard,
}));

import { BOARD_PAGE_SIZE, BOARD_PAGING_THRESHOLD, loadBoardForView, loadMoreInColumn } from '../boardPaging.js';
import { ColumnShowMore } from '../ColumnShowMore.js';

const AT = '2026-11-23T00:00:00.000Z';
const BOARD: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'House', columns: [{ id: 'todo', name: 'To Do' }, { id: 'done', name: 'Done' }], createdAt: AT, updatedAt: AT,
};
const card = (id: string, columnId: string): KanbanCard => ({ id, boardId: 'b1', columnId, title: id, order: 1, createdAt: AT, updatedAt: AT });
const cardsIn = (columnId: string, from: number, n: number): KanbanCard[] => Array.from({ length: n }, (_, i) => card(`${columnId}-${from + i}`, columnId));

beforeEach(() => { api.getBoard.mockReset(); });

describe('loadBoardForView', () => {
  it('uses the probe as-is when the host cannot page', async () => {
    api.getBoard.mockResolvedValue({ board: BOARD, cards: [card('a', 'todo')] });
    const loaded = await loadBoardForView('b1');
    expect(loaded.paging).toBeNull();
    expect(loaded.cards.map((c) => c.id)).toEqual(['a']);
    expect(loaded.workItems).toEqual([]);
    expect(api.getBoard).toHaveBeenCalledTimes(1);
  });

  it('loads a board up to the threshold whole', async () => {
    api.getBoard.mockImplementation(async (_id: string, page?: { limit: number }): Promise<KanbanBoardRead> => (
      page ? { board: BOARD, cards: [card('a', 'todo')], workItems: [], total: BOARD_PAGING_THRESHOLD, nextCursor: 'c' }
        : { board: BOARD, cards: [card('a', 'todo'), card('b', 'done')], workItems: [] }));
    const loaded = await loadBoardForView('b1');
    expect(loaded.paging).toBeNull();
    expect(loaded.cards).toHaveLength(2);
    expect(api.getBoard).toHaveBeenLastCalledWith('b1');
  });

  it('pages a large board per column, and keeps what a refresh already showed', async () => {
    const pages: Record<string, KanbanCard[]> = { todo: cardsIn('todo', 0, 120), done: cardsIn('done', 0, 10) };
    api.getBoard.mockImplementation(async (_id: string, page?: { limit: number; column?: string; cursor?: string }): Promise<KanbanBoardRead> => {
      if (!page) throw new Error('a large board must not be read whole');
      if (!page.column) return { board: BOARD, cards: [card('x', 'todo')], workItems: [], total: BOARD_PAGING_THRESHOLD + 1, nextCursor: 'p' };
      const all = pages[page.column]!;
      const start = page.cursor ? Number(page.cursor) : 0;
      const slice = all.slice(start, start + page.limit);
      const end = start + slice.length;
      return { board: BOARD, cards: slice, workItems: [], total: all.length, ...(end < all.length ? { nextCursor: String(end) } : {}) };
    });

    const first = await loadBoardForView('b1');
    expect(first.paging).toEqual({ todo: { total: 120, nextCursor: String(BOARD_PAGE_SIZE) }, done: { total: 10 } });
    expect(first.cards.filter((c) => c.columnId === 'todo')).toHaveLength(BOARD_PAGE_SIZE);
    expect(first.cards.filter((c) => c.columnId === 'done')).toHaveLength(10);

    const more = await loadMoreInColumn('b1', 'todo', String(BOARD_PAGE_SIZE));
    expect(more.cards[0]?.id).toBe(`todo-${BOARD_PAGE_SIZE}`);
    expect(api.getBoard).toHaveBeenLastCalledWith('b1', { limit: BOARD_PAGE_SIZE, column: 'todo', cursor: String(BOARD_PAGE_SIZE) });

    const refreshed = await loadBoardForView('b1', { todo: 2 * BOARD_PAGE_SIZE });
    expect(refreshed.cards.filter((c) => c.columnId === 'todo')).toHaveLength(2 * BOARD_PAGE_SIZE);
    expect(refreshed.paging?.todo).toEqual({ total: 120, nextCursor: String(2 * BOARD_PAGE_SIZE) });
  });
});

describe('ColumnShowMore', () => {
  it('shows how much is loaded, loads more on click, and hides once complete', () => {
    const onMore = vi.fn();
    const { rerender, container } = render(<ColumnShowMore shown={50} total={120} hasMore loading={false} onMore={onMore} />);
    const button = screen.getByRole('button');
    expect(button.textContent).toMatch(/50/);
    expect(button.textContent).toMatch(/120/);
    fireEvent.click(button);
    expect(onMore).toHaveBeenCalledTimes(1);
    rerender(<ColumnShowMore shown={50} total={120} hasMore loading onMore={onMore} />);
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
    rerender(<ColumnShowMore shown={120} total={120} hasMore={false} loading={false} onMore={onMore} />);
    expect(container.innerHTML).toBe('');
  });
});
