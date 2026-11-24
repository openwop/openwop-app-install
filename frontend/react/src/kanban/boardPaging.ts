/**
 * ADR 1155 D7 — how the board view loads a large board.
 *
 * A board with up to `BOARD_PAGING_THRESHOLD` cards loads whole, exactly as before. A
 * larger one loads the first `BOARD_PAGE_SIZE` cards of each column, and each column
 * grows by a page at a time (Show more). A refresh keeps as many cards per column as
 * the viewer already opened, so an edit does not collapse a long column.
 *
 * The first read is a one-card page (`limit=1`), which answers with the board and its
 * `total`. A host that cannot page ignores `limit` and returns every card with no
 * `total`; that read is used as-is.
 */
import { getBoard, type KanbanBoard, type KanbanCard, type KanbanWorkItem } from './kanbanClient.js';

export const BOARD_PAGING_THRESHOLD = 500;
export const BOARD_PAGE_SIZE = 50;

/** Per column: every card that matches, and where its next page starts. */
export type ColumnPaging = Record<string, { total: number; nextCursor?: string }>;

export interface LoadedBoard {
  board: KanbanBoard;
  cards: KanbanCard[];
  workItems: KanbanWorkItem[];
  /** Null when the whole board is loaded. */
  paging: ColumnPaging | null;
}

/** Load a board for the view. `keep` asks for at least that many cards per column. */
export async function loadBoardForView(boardId: string, keep: Record<string, number> = {}): Promise<LoadedBoard> {
  const probe = await getBoard(boardId, { limit: 1 });
  if (probe.total === undefined) {
    return { board: probe.board, cards: probe.cards, workItems: probe.workItems ?? [], paging: null };
  }
  if (probe.total <= BOARD_PAGING_THRESHOLD) {
    const whole = await getBoard(boardId);
    return { board: whole.board, cards: whole.cards, workItems: whole.workItems ?? [], paging: null };
  }
  const columns = await Promise.all(probe.board.columns.map(async (column) => {
    const want = Math.max(BOARD_PAGE_SIZE, keep[column.id] ?? 0);
    const cards: KanbanCard[] = [];
    const workItems: KanbanWorkItem[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await getBoard(boardId, { limit: BOARD_PAGE_SIZE, column: column.id, ...(cursor ? { cursor } : {}) });
      cards.push(...page.cards);
      workItems.push(...(page.workItems ?? []));
      total = page.total ?? cards.length;
      cursor = page.nextCursor;
    } while (cursor && cards.length < want);
    return { columnId: column.id, cards, workItems, total, ...(cursor ? { nextCursor: cursor } : {}) };
  }));
  const paging: ColumnPaging = {};
  for (const c of columns) paging[c.columnId] = { total: c.total, ...(c.nextCursor ? { nextCursor: c.nextCursor } : {}) };
  return {
    board: probe.board,
    cards: columns.flatMap((c) => c.cards),
    workItems: columns.flatMap((c) => c.workItems),
    paging,
  };
}

/** The next page of one column. */
export async function loadMoreInColumn(boardId: string, columnId: string, cursor: string): Promise<{ cards: KanbanCard[]; workItems: KanbanWorkItem[]; total: number; nextCursor?: string }> {
  const page = await getBoard(boardId, { limit: BOARD_PAGE_SIZE, column: columnId, cursor });
  return { cards: page.cards, workItems: page.workItems ?? [], total: page.total ?? page.cards.length, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

/** Add cards and work items not already present (a page can overlap an optimistic move). */
export function mergeById<T>(current: readonly T[], more: readonly T[], idOf: (x: T) => string): T[] {
  const seen = new Set(current.map(idOf));
  return [...current, ...more.filter((x) => !seen.has(idOf(x)))];
}
