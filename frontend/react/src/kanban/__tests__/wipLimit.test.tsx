/**
 * KB-R2-5 — soft WIP limit rendering + config affordance. Invariants:
 *   - no limit: plain count, no config icon without the callback (polarity)
 *   - limit set: count/limit readout; breach adds the highlight + SR text
 *   - the config affordance appears only WITH the callback, and Set/Clear
 *     report the right values
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../kanbanClient.js';

const mkBoard = (wipLimit?: number): KanbanBoard => ({
  id: 'b1', tenantId: 't1', name: 'Board',
  columns: [{ id: 'todo', name: 'To do', ...(wipLimit ? { wipLimit } : {}) }],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
} as KanbanBoard);
const mkCards = (n: number): KanbanCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, boardId: 'b1', columnId: 'todo', title: `T${i}`, priority: 'normal', order: i } as KanbanCard));

afterEach(cleanup);

describe('KB-R2-5 — soft WIP limit UI', () => {
  it('no limit: plain count; no config icon without the callback', () => {
    render(<MemoryRouter><KanbanBoardView board={mkBoard()} cards={mkCards(2)} onMoveCard={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /work-in-progress limit/i })).toBeNull();
  });

  it('under the limit: count/limit, no highlight; over: highlight + SR text', () => {
    const { rerender } = render(<MemoryRouter><KanbanBoardView board={mkBoard(3)} cards={mkCards(2)} onMoveCard={vi.fn()} /></MemoryRouter>);
    const under = screen.getByText((_, el) => el?.classList.contains('kb-col-count') === true);
    expect(under.textContent).toContain('2/3');
    expect(under.classList.contains('kb-col-count--over')).toBe(false);

    rerender(<MemoryRouter><KanbanBoardView board={mkBoard(3)} cards={mkCards(4)} onMoveCard={vi.fn()} /></MemoryRouter>);
    const over = screen.getByText((_, el) => el?.classList.contains('kb-col-count--over') === true);
    expect(over.textContent).toContain('4/3');
    expect(over.textContent).toContain('over the work-in-progress limit'); // SR pairing — never color alone
  });

  it('Set and Clear report the right values through the callback', () => {
    const onSetColumnLimit = vi.fn();
    render(<MemoryRouter><KanbanBoardView board={mkBoard(3)} cards={mkCards(1)} onMoveCard={vi.fn()} onSetColumnLimit={onSetColumnLimit} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /work-in-progress limit for To do/i }));
    const input = screen.getByLabelText(/Limit/) as HTMLInputElement;
    expect(input.value).toBe('3'); // prefilled with the current limit
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(onSetColumnLimit).toHaveBeenCalledWith('todo', 5);

    fireEvent.click(screen.getByRole('button', { name: /work-in-progress limit for To do/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear limit' }));
    expect(onSetColumnLimit).toHaveBeenCalledWith('todo', null);
  });
});
