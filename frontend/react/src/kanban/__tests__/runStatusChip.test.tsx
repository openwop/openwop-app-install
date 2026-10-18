/**
 * ADR 0774 D6 — the card says what its linked run is doing.
 *
 * `lastRunStatus` is durable on the card (D3), so a finished agent run keeps
 * saying "finished — needs review" after its run row is retained away, and a
 * failed one says so instead of hiding behind a bare "View run" link. No chip
 * is shown when the status is unknown, never a guessed one, and "finished —
 * needs review" is withdrawn once a human has moved the card on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';

const board: KanbanBoard = {
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To Do' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' }],
  createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z',
};
const card = (over: Partial<KanbanCard>): KanbanCard => ({
  id: 'c1', boardId: 'b1', columnId: 'doing', title: 'Work', order: 0,
  createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', ...over,
});

const renderCard = (c: KanbanCard): void => {
  render(<MemoryRouter><KanbanBoardView board={board} cards={[c]} onMoveCard={vi.fn()} /></MemoryRouter>);
};

afterEach(cleanup);

describe('run-status chip', () => {
  it.each([
    ['running', 'Agent working'],
    ['completed', 'Finished — needs review'],
    ['failed', 'Run failed'],
    ['cancelled', 'Run cancelled'],
  ] as const)('%s → "%s", a plain chip beside the run link', (status, label) => {
    renderCard(card({ lastRunId: 'r1', lastRunStatus: status }));
    const chip = screen.getByText(label);
    expect(chip.classList.contains('chip')).toBe(true);
    // KSUX-1 — never a per-card live region (N of them re-announce on every poll).
    expect(chip.getAttribute('role')).toBeNull();
    expect(chip.closest('[role="status"],[aria-live]')).toBeNull();
    expect(screen.getByRole('link', { name: /View run/ })).toBeTruthy();
  });

  it('KSUX-2 — "needs review" is gone once a human has moved the card on', () => {
    renderCard(card({ columnId: 'done', lastRunId: 'r1', lastRunStatus: 'completed' }));
    expect(screen.queryByText('Finished — needs review')).toBeNull();
    cleanup();
    renderCard(card({ columnId: 'todo', lastRunId: 'r1', lastRunStatus: 'completed' }));
    expect(screen.queryByText('Finished — needs review')).toBeNull();
  });

  it('a failed run stays visible on the card it was restored to To Do for', () => {
    renderCard(card({ columnId: 'todo', lastRunId: 'r1', lastRunStatus: 'failed' }));
    expect(screen.getByText('Run failed')).toBeTruthy();
  });

  it('no status → no chip (never a guessed state), the run link still shows', () => {
    renderCard(card({ lastRunId: 'r1' }));
    expect(screen.queryByText(/Agent working|needs review|Run failed|Run cancelled/)).toBeNull();
    expect(screen.getByRole('link', { name: /View run/ })).toBeTruthy();
  });
});
