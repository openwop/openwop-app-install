/**
 * ADR 0963 (grade-ux) — releasing a held card on the agent's board must refresh
 * "Up next" too, or the panel keeps listing the card under Held. And a release
 * that lost to a newer change (409) reloads and says so in words.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

type KanbanClient = typeof import('../../kanban/kanbanClient.js');
const { patchCard } = vi.hoisted(() => ({ patchCard: vi.fn<KanbanClient['patchCard']>() }));
vi.mock('../../kanban/kanbanClient.js', async (orig) => ({
  ...(await orig<KanbanClient>()),
  getBoard: vi.fn(async () => ({ board: { id: 'b1', tenantId: 't1', name: 'B', columns: [{ id: 'todo', name: 'To Do' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, cards: [] })),
  subscribeBoardEvents: vi.fn(() => () => undefined),
  patchCard,
}));
const signals: Array<number | undefined> = [];
vi.mock('../AgentUpNextPanel.js', () => ({
  AgentUpNextPanel: (p: { refreshSignal?: number }) => { signals.push(p.refreshSignal); return null; },
}));
const seen: Array<Record<string, unknown>> = [];
vi.mock('../../kanban/KanbanBoardView.js', () => ({
  KanbanBoardView: (props: Record<string, unknown>) => { seen.push(props); return <div>board-view</div>; },
}));

const { AgentBoardPanel } = await import('../AgentBoardPanel.js');

afterEach(() => { cleanup(); seen.length = 0; signals.length = 0; patchCard.mockReset(); });

describe('AgentBoardPanel → Up next', () => {
  it('a card edit (a Release) bumps the Up next refresh signal', async () => {
    patchCard.mockResolvedValue({ card: { id: 'c1', boardId: 'b1', columnId: 'todo', title: 'T', order: 0, createdAt: '', updatedAt: '' }, triggeredRunId: null });
    render(<AgentBoardPanel boardId="b1" persona="Atlas" refreshSignal={0} />);
    await screen.findByText('board-view');
    const before = signals.at(-1) ?? 0;
    await act(async () => { (seen.at(-1)!.onEditCard as (id: string, p: object) => void)('c1', { blockerNote: '' }); });
    await waitFor(() => expect(signals.at(-1)).toBeGreaterThan(before));
  });

  it('a release that lost to a newer change says so in words, not a status line', async () => {
    patchCard.mockRejectedValue(Object.assign(new Error('patchCard returned 409'), { status: 409 }));
    render(<AgentBoardPanel boardId="b1" persona="Atlas" />);
    await screen.findByText('board-view');
    await act(async () => { (seen.at(-1)!.onEditCard as (id: string, p: object) => void)('c1', { blockerNote: '' }); });
    expect(await screen.findByText(/changed since you loaded it/)).toBeTruthy();
    expect(screen.queryByText(/409/)).toBeNull();
  });
});
