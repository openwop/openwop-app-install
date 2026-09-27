/**
 * UX_UPGRADE-crm-console CRM-G1 — task due dates.
 *
 * `Task.dueDate` was already in the model, already accepted by the create and
 * PATCH routes, already exported to CSV, and already settable BY AN AI AGENT
 * (`crm.task.create` takes `dueDate`). Only the human UI could neither see nor
 * set one — so an agent could put a date on a task that no person could read.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Task } from '../crmOrgClient.js';

const listTasks = vi.fn();
const createTask = vi.fn();
const setTaskDueDate = vi.fn();
const setTaskStatus = vi.fn();
const deleteTask = vi.fn();
const listDeals = vi.fn(async (..._a: unknown[]) => [{ dealId: 'd1', title: 'Globex expansion', stageId: 's1' }]);
vi.mock('../crmOrgClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listTasks: (...a: unknown[]) => listTasks(...a),
  createTask: (...a: unknown[]) => createTask(...a),
  setTaskDueDate: (...a: unknown[]) => setTaskDueDate(...a),
  setTaskStatus: (...a: unknown[]) => setTaskStatus(...a),
  deleteTask: (...a: unknown[]) => deleteTask(...a),
  listDeals: (...a: unknown[]) => listDeals(...a),
}));

const { TasksTab } = await import('../TasksTab.js');

const task = (id: string, title: string, over: Partial<Task> = {}): Task =>
  ({ taskId: id, title, status: 'open', ...over } as Task);

/** A date safely in the past / future regardless of when this runs. */
const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const renderTab = () => render(<MemoryRouter><TasksTab orgId="org:1" /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('CRM tasks — the due date a human could not see (CRM-G1)', () => {
  it('shows a due date an AGENT set, in an editable control', async () => {
    listTasks.mockResolvedValue([task('t1', 'Call Ada', { dueDate: day(3) })]);
    renderTab();
    const input = await screen.findByLabelText(/due date for .*Call Ada/i);
    expect((input as HTMLInputElement).value).toBe(day(3));
    expect((input as HTMLInputElement).type).toBe('date');
  });

  it('flags an OVERDUE open task', async () => {
    listTasks.mockResolvedValue([task('t1', 'Call Ada', { dueDate: day(-2) })]);
    const { container } = renderTab();
    await screen.findByText('Call Ada');
    await waitFor(() => expect(container.querySelector('.chip--danger')).toBeTruthy());
  });

  it('does NOT flag a past date on a DONE task — that is not a problem', async () => {
    listTasks.mockResolvedValue([task('t1', 'Call Ada', { dueDate: day(-2), status: 'done' })]);
    const { container } = renderTab();
    await screen.findByText('Call Ada');
    expect(container.querySelector('.chip--danger')).toBeNull();
  });

  it('does not flag a task with no due date at all', async () => {
    listTasks.mockResolvedValue([task('t1', 'Call Ada')]);
    const { container } = renderTab();
    await screen.findByText('Call Ada');
    expect(container.querySelector('.chip--danger')).toBeNull();
  });
});

describe('CRM tasks — setting a due date (CRM-G1)', () => {
  it('sends the date when adding a task, and clears the field after', async () => {
    listTasks.mockResolvedValue([]);
    createTask.mockResolvedValue(task('t1', 'New task'));
    renderTab();
    await screen.findByRole('button', { name: /add task/i });

    fireEvent.change(screen.getByLabelText(/^title$/i, { selector: 'input' }), { target: { value: 'New task' } });
    const dueInput = screen.getByLabelText(/^due date$/i, { selector: 'input' });
    fireEvent.change(dueInput, { target: { value: day(5) } });
    fireEvent.click(screen.getByRole('button', { name: /add task/i }));

    await waitFor(() => expect(createTask).toHaveBeenCalledWith('org:1', { title: 'New task', dueDate: day(5) }));
    await waitFor(() => expect((dueInput as HTMLInputElement).value).toBe(''));
  });

  it('omits the field entirely when no date was picked', async () => {
    listTasks.mockResolvedValue([]);
    createTask.mockResolvedValue(task('t1', 'New task'));
    renderTab();
    await screen.findByRole('button', { name: /add task/i });
    fireEvent.change(screen.getByLabelText(/^title$/i, { selector: 'input' }), { target: { value: 'New task' } });
    fireEvent.click(screen.getByRole('button', { name: /add task/i }));
    // `{ dueDate: '' }` would be a value; the absent key is the honest shape.
    await waitFor(() => expect(createTask).toHaveBeenCalledWith('org:1', { title: 'New task' }));
  });

  it('patches an existing task, and CLEARS with null rather than an empty string', async () => {
    listTasks.mockResolvedValue([task('t1', 'Call Ada', { dueDate: day(3) })]);
    setTaskDueDate.mockResolvedValue(task('t1', 'Call Ada'));
    renderTab();
    const input = await screen.findByLabelText(/due date for .*Call Ada/i);

    fireEvent.change(input, { target: { value: day(9) } });
    await waitFor(() => expect(setTaskDueDate).toHaveBeenCalledWith('org:1', 't1', day(9)));

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(setTaskDueDate).toHaveBeenLastCalledWith('org:1', 't1', null));
  });
});

describe('R2 CRM-R2-1/2 — deal-linked tasks + due-date sort (XCC-5)', () => {
  it('create sends dealId when a deal is picked; the column links to the deal by TITLE', async () => {
    listTasks.mockResolvedValue([task('t1', 'Follow up', { dealId: 'd1' })]);
    createTask.mockResolvedValue(task('t9', 'New'));
    renderTab();
    // Existing linked task renders the deal TITLE as a link, not the raw id.
    const dealLink = await screen.findByRole('link', { name: 'Globex expansion' });
    expect(dealLink.getAttribute('href')).toContain('/crm/deals/d1');
    // Pick the deal in the form and create.
    fireEvent.change(screen.getByLabelText(/^deal$/i), { target: { value: 'd1' } });
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Call about renewal' } });
    fireEvent.click(screen.getByRole('button', { name: /add task/i }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect(createTask.mock.calls[0]![1]).toMatchObject({ title: 'Call about renewal', dealId: 'd1' });
  });

  it('an unlinked create omits the dealId key entirely', async () => {
    listTasks.mockResolvedValue([]);
    createTask.mockResolvedValue(task('t9', 'New'));
    renderTab();
    fireEvent.change(await screen.findByLabelText(/^title$/i), { target: { value: 'Standalone' } });
    fireEvent.click(screen.getByRole('button', { name: /add task/i }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect('dealId' in (createTask.mock.calls[0]![1] as Record<string, unknown>)).toBe(false);
  });

  it('due-date sort leads with the soonest date and sinks undated tasks', async () => {
    listTasks.mockResolvedValue([
      task('t1', 'Undated', {}),
      task('t2', 'Later', { dueDate: day(9) }),
      task('t3', 'Soon', { dueDate: day(1) }),
      task('t4', 'Mid', { dueDate: day(5) }),
    ]);
    renderTab();
    await screen.findByText('Undated');
    fireEvent.click(screen.getByLabelText(/sort by due date/i));
    await waitFor(() => {
      const titles = [...document.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');
      const order = ['Soon', 'Mid', 'Later', 'Undated'].map((name) => titles.findIndex((tx) => tx.includes(name)));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.every((i) => i >= 0)).toBe(true);
    });
  });
});

