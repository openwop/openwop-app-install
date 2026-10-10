/**
 * grade-ux row 25 B2 — a project VIEWER's board offers no write it cannot make.
 *
 * The project Board tab rendered `AgentBoardPanel` with every write handler wired, so a
 * read-only member got create / edit / delete controls and drags that each 403'd as a raw
 * error. `readOnly` drops the handlers the board view gates its controls on, and a drag is
 * never sent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const patchCard = vi.fn(async () => ({}));
vi.mock('../../kanban/kanbanClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getBoard: vi.fn(async () => ({ board: { id: 'b1', name: 'B', columns: [{ id: 'todo', name: 'To Do' }] }, cards: [] })),
  subscribeBoardEvents: vi.fn(() => () => undefined),
  patchCard: (...a: unknown[]) => patchCard(...(a as [])),
}));
vi.mock('../AgentUpNextPanel.js', () => ({ AgentUpNextPanel: () => null }));
const seen: Array<Record<string, unknown>> = [];
vi.mock('../../kanban/KanbanBoardView.js', () => ({
  KanbanBoardView: (props: Record<string, unknown>) => { seen.push(props); return <div>board-view</div>; },
}));

const { AgentBoardPanel } = await import('../AgentBoardPanel.js');

afterEach(() => { cleanup(); seen.length = 0; patchCard.mockClear(); });

describe('AgentBoardPanel readOnly', () => {
  it('a viewer gets no create / edit / delete, a drag is not sent, and the reason is shown', async () => {
    render(<AgentBoardPanel boardId="b1" persona="Atlas" readOnly />);
    await screen.findByText('board-view');
    const props = seen.at(-1)!;
    expect(props.onCreateCard).toBeUndefined();
    expect(props.onEditCard).toBeUndefined();
    expect(props.onDeleteCard).toBeUndefined();
    (props.onMoveCard as (id: string, col: string) => void)('c1', 'todo');
    await waitFor(() => expect(patchCard).not.toHaveBeenCalled());
    expect(screen.getByText(/needs edit access/)).toBeTruthy();
  });

  it('positive control — an editor keeps every handler and a drag is sent', async () => {
    render(<AgentBoardPanel boardId="b1" persona="Atlas" />);
    await screen.findByText('board-view');
    const props = seen.at(-1)!;
    expect(typeof props.onCreateCard).toBe('function');
    (props.onMoveCard as (id: string, col: string) => void)('c1', 'todo');
    await waitFor(() => expect(patchCard).toHaveBeenCalledTimes(1));
  });
});
