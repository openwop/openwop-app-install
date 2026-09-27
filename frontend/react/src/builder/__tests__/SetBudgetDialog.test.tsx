/**
 * ADR 0482 (ux-6/7/14/15) — the Set-budget dialog error surfaces. Pins that
 * (a) validation is REACHABLE: Save stays enabled, an invalid amount lands on
 * the field's role=alert error (never a silent dead button), (b) transport
 * copy branches on the encoded status (400/404 are not "try again in a
 * moment"), and (c) the fail-soft spent-today context line renders from
 * getWorkflowBudget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const getWorkflowBudget = vi.fn<() => Promise<{ budget: { dailyUsd: number; hardCap: boolean } | null; spentTodayUsd: number }>>();
const putWorkflowBudget = vi.fn<() => Promise<{ dailyUsd: number; hardCap: boolean }>>();
const clearWorkflowBudget = vi.fn<() => Promise<void>>();

vi.mock('../../workflows/workflowsClient.js', () => ({
  getWorkflowBudget: (...a: unknown[]) => getWorkflowBudget(...(a as [])),
  putWorkflowBudget: (...a: unknown[]) => putWorkflowBudget(...(a as [])),
  clearWorkflowBudget: (...a: unknown[]) => clearWorkflowBudget(...(a as [])),
}));

const { SetBudgetDialog } = await import('../SetBudgetDialog.js');

afterEach(cleanup);
beforeEach(() => {
  getWorkflowBudget.mockReset();
  putWorkflowBudget.mockReset();
  clearWorkflowBudget.mockReset();
  getWorkflowBudget.mockResolvedValue({ budget: null, spentTodayUsd: 1.25 });
});

const workflow = { id: 'wf_1', name: 'Digest' };

describe('SetBudgetDialog (ADR 0482)', () => {
  it('keeps Save enabled and surfaces an invalid amount on the field, not the modal', async () => {
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    const save = screen.getByRole('button', { name: 'Save budget' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Enter a daily amount greater than zero.');
    expect(putWorkflowBudget).not.toHaveBeenCalled();
    // The field is marked invalid for AT.
    expect(screen.getByLabelText("Daily budget (USD)").getAttribute('aria-invalid')).toBe('true');
  });

  it('saves a valid amount and clears the field error on edit', async () => {
    putWorkflowBudget.mockResolvedValue({ dailyUsd: 5, hardCap: false });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SetBudgetDialog workflow={workflow} onSaved={onSaved} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await screen.findByRole('alert');
    const input = screen.getByLabelText("Daily budget (USD)");
    fireEvent.change(input, { target: { value: '5' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(putWorkflowBudget).toHaveBeenCalledWith('wf_1', { dailyUsd: 5, hardCap: false });
    expect(onClose).toHaveBeenCalled();
  });

  it('branches transport copy on the encoded status (404 is not "try again")', async () => {
    putWorkflowBudget.mockRejectedValue(new Error('budget_put_404'));
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Daily budget (USD)"), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() => {
      expect(screen.getByText(/no longer exists on the server/)).toBeTruthy();
    });
  });

  it('uses the generic transport copy for a 5xx-style failure', async () => {
    putWorkflowBudget.mockRejectedValue(new Error('budget_put_500'));
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Daily budget (USD)"), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() => {
      expect(screen.getByText(/Couldn't save the budget/)).toBeTruthy();
    });
  });

  it('shows the spent-today context line from getWorkflowBudget (ux-14)', async () => {
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Spent today:/)).toBeTruthy();
    });
    expect(getWorkflowBudget).toHaveBeenCalledWith('wf_1');
  });

  it('stays usable when the spent-today read fails (fail-soft)', async () => {
    getWorkflowBudget.mockRejectedValue(new Error('budget_get_500'));
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(getWorkflowBudget).toHaveBeenCalled());
    expect(screen.queryByText(/Spent today:/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Save budget' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
