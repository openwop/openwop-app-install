/**
 * Kanban workflow bindings are inventory-driven. The board must never fall
 * back to a role-template catalog: a user can bind the workflow they authored
 * in Workflow Builder, and the card keeps its editable name in every shared
 * board embedding.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CreateBoardModal } from '../CreateBoardModal.js';
import { KanbanBoardView } from '../KanbanBoardView.js';
import type { KanbanBoard, KanbanCard, KanbanWorkItem } from '../kanbanClient.js';

afterEach(cleanup);

describe('Kanban workflow inventory', () => {
  it('uses the caller-owned workflow inventory in the create-board picker', () => {
    render(
      <CreateBoardModal
        roster={[]}
        workflowOptions={[{ workflowId: 'wf.customer-launch', name: 'Customer launch handoff', nodeCount: 4, createdAt: '', updatedAt: '' }]}
        workflowOptionsLoading={false}
        workflowOptionsFailed={false}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const picker = screen.getByLabelText(/trigger workflow/i) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toContain('wf.customer-launch');
    expect(screen.getByRole('option', { name: 'Customer launch handoff' })).toBeTruthy();
  });

  it('renders the dynamic workflow name on a reusable shared card', () => {
    const board: KanbanBoard = {
      id: 'board-1', tenantId: 'tenant-1', name: 'Reusable board',
      columns: [{ id: 'todo', name: 'To do' }], createdAt: '', updatedAt: '',
    };
    const card: KanbanCard = {
      id: 'card-1', boardId: board.id, columnId: 'todo', title: 'Ship the handoff',
      workflowId: 'wf.customer-launch', order: 0, createdAt: '', updatedAt: '',
    };
    render(
      <MemoryRouter>
        <KanbanBoardView
          board={board}
          cards={[card]}
          workflowOptions={[{ workflowId: 'wf.customer-launch', name: 'Customer launch handoff' }]}
          onMoveCard={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Customer launch handoff')).toBeTruthy();
  });

  it('renders and dispatches a canvas-neutral core WorkItem without an App Builder component', () => {
    const board: KanbanBoard = {
      id: 'board-1', tenantId: 'tenant-1', name: 'Reusable board',
      columns: [{ id: 'todo', name: 'To do' }], createdAt: '', updatedAt: '',
    };
    const card: KanbanCard = {
      id: 'card-1', boardId: board.id, columnId: 'todo', title: 'Ship the handoff',
      workflowId: 'wf.customer-launch', workItemId: 'work-1', order: 0, createdAt: '', updatedAt: '',
    };
    const workItem: KanbanWorkItem = {
      workItemId: 'work-1', boardId: board.id, cardId: card.id,
      scope: { kind: 'canvas.any' },
      source: { kind: 'reviewed.plan' },
      dependencyCount: 0, workflowId: 'wf.customer-launch',
      state: 'ready', order: 0,
      execution: { mode: 'manual', maxAttempts: 1, attempts: 0, status: 'idle' },
      createdAt: '', updatedAt: '',
    };
    const onRunWorkItem = vi.fn();
    render(
      <MemoryRouter>
        <KanbanBoardView
          board={board}
          cards={[card]}
          workflowOptions={[{ workflowId: 'wf.customer-launch', name: 'Customer launch handoff' }]}
          workItemsByCardId={new Map([[card.id, workItem]])}
          onRunWorkItem={onRunWorkItem}
          onMoveCard={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.getByText('Scope: canvas.any')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run work' }));
    expect(onRunWorkItem).toHaveBeenCalledWith('work-1');
  });

  it('discloses a failed workflow read without blocking a manual board', () => {
    render(
      <CreateBoardModal
        roster={[]}
        workflowOptions={[]}
        workflowOptionsLoading={false}
        workflowOptionsFailed
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/board name/i), { target: { value: 'Manual board' } });
    expect((screen.getByRole('button', { name: /create board/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not mistake a pending workflow read for an empty workflow list', () => {
    render(
      <CreateBoardModal
        roster={[]}
        workflowOptions={[]}
        workflowOptionsLoading
        workflowOptionsFailed={false}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByRole('option', { name: /loading workflows/i })).toBeTruthy();
    expect((screen.getByLabelText(/trigger workflow/i) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/board name/i), { target: { value: 'Manual board' } });
    expect((screen.getByRole('button', { name: /create board/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
