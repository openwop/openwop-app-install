/**
 * ADR 0963 (grade-ux) — releasing a held card on the agent's board must refresh
 * "Up next" too, or the panel keeps listing the card under Held. And a release
 * that lost to a newer change (409) reloads and says so in words.
 *
 * Sabotage (witnessed): dropping the bump after an edit, or the panel's wiring of
 * it, reds the first case, as does sending the edit without its patch. Handling a
 * 409 like every other failure, skipping its reload, or skipping its bump reds the
 * second.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

import type { CardPatch } from '../../kanban/KanbanBoardView.js';
import type { KanbanBoard } from '../../kanban/kanbanClient.js';

type KanbanClient = typeof import('../../kanban/kanbanClient.js');
const { patchCard, getBoard } = vi.hoisted(() => ({
  patchCard: vi.fn<KanbanClient['patchCard']>(),
  getBoard: vi.fn<KanbanClient['getBoard']>(),
}));
vi.mock('../../kanban/kanbanClient.js', async (orig) => ({
  ...(await orig<KanbanClient>()),
  getBoard,
  subscribeBoardEvents: vi.fn(() => () => undefined),
  patchCard,
}));
const signals: Array<number | undefined> = [];
vi.mock('../AgentUpNextPanel.js', () => ({
  AgentUpNextPanel: (p: { refreshSignal?: number }) => { signals.push(p.refreshSignal); return null; },
}));
interface BoardViewProps { onEditCard?: (cardId: string, patch: CardPatch) => void }
const seen: BoardViewProps[] = [];
vi.mock('../../kanban/KanbanBoardView.js', () => ({
  KanbanBoardView: (props: BoardViewProps) => { seen.push(props); return <div>board-view</div>; },
}));

const { AgentBoardPanel } = await import('../AgentBoardPanel.js');

const BOARD: KanbanBoard = { id: 'b1', tenantId: 't1', name: 'B', columns: [{ id: 'todo', name: 'To Do' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

beforeEach(() => { getBoard.mockResolvedValue({ board: BOARD, cards: [], workItems: [] }); });
afterEach(() => { cleanup(); seen.length = 0; signals.length = 0; patchCard.mockReset(); getBoard.mockReset(); });

describe('AgentBoardPanel → Up next', () => {
  it('a card edit (a Release) bumps the Up next refresh signal', async () => {
    patchCard.mockResolvedValue({ card: { id: 'c1', boardId: 'b1', columnId: 'todo', title: 'T', order: 0, createdAt: '', updatedAt: '' }, triggeredRunId: null });
    render(<AgentBoardPanel boardId="b1" persona="Atlas" refreshSignal={0} />);
    await screen.findByText('board-view');
    const before = signals.at(-1) ?? 0;
    await act(async () => { seen.at(-1)!.onEditCard!('c1', { blockerNote: '' }); });
    await waitFor(() => expect(signals.at(-1)).toBeGreaterThan(before));
    expect(patchCard).toHaveBeenCalledWith('c1', { blockerNote: '' });
  });

  it('a release that lost to a newer change says so in words, not a status line', async () => {
    patchCard.mockRejectedValue(Object.assign(new Error('patchCard returned 409'), { status: 409 }));
    render(<AgentBoardPanel boardId="b1" persona="Atlas" />);
    await screen.findByText('board-view');
    const reads = getBoard.mock.calls.length;
    const before = signals.at(-1) ?? 0;
    await act(async () => { seen.at(-1)!.onEditCard!('c1', { blockerNote: '' }); });
    expect(await screen.findByText(/changed since you loaded it/)).toBeTruthy();
    expect(screen.queryByText(/409/)).toBeNull();
    // The reload half of the claim: the board is re-read and Up next is told to.
    expect(getBoard.mock.calls.length).toBeGreaterThan(reads);
    expect(signals.at(-1)).toBeGreaterThan(before);
  });
});
