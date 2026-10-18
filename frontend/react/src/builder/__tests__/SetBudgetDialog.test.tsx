/**
 * ADR 0482 (ux-6/7/14/15) — the Set-budget dialog error surfaces. Pins that
 * (a) validation is REACHABLE: Save stays enabled, an invalid amount lands on
 * the field's role=alert error (never a silent dead button), (b) transport
 * copy branches on the encoded status (400/404 are not "try again in a
 * moment"), and (c) the fail-soft spent-today context line renders from
 * getWorkflowBudget.
 *
 * Expectations are en literals (never computed by the dialog). The saved
 * amount is non-whole (7.5) so a rounding defect shows; absence after a failed
 * read is asserted only once that rejection has settled.
 *
 * Sabotage that turns it red: accepting empty / zero / negative, not clearing
 * the field error on edit, rounding the amount, a 400 or 404 falling through to
 * the generic copy, the spent amount not coming from the read, a failed read
 * still drawing a context line, or a transport failure not shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

type WorkflowsClient = typeof import('../../workflows/workflowsClient.js');
const getWorkflowBudget = vi.fn<WorkflowsClient['getWorkflowBudget']>();
const putWorkflowBudget = vi.fn<WorkflowsClient['putWorkflowBudget']>();
const clearWorkflowBudget = vi.fn<WorkflowsClient['clearWorkflowBudget']>();

vi.mock('../../workflows/workflowsClient.js', () => ({
  getWorkflowBudget: (...a: Parameters<WorkflowsClient['getWorkflowBudget']>) => getWorkflowBudget(...a),
  putWorkflowBudget: (...a: Parameters<WorkflowsClient['putWorkflowBudget']>) => putWorkflowBudget(...a),
  clearWorkflowBudget: (...a: Parameters<WorkflowsClient['clearWorkflowBudget']>) => clearWorkflowBudget(...a),
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

  it.each([['0'], ['-3']])('refuses a non-positive amount (%s): native min stops the button, the dialog guard stops a direct submit', async (amount) => {
    const { container } = render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    const input = screen.getByLabelText("Daily budget (USD)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: amount } });
    expect(input.value).toBe(amount);
    // Layer 1 — the field's `min="0.01"`: the Save button's submission is
    // blocked by constraint validation (the browser's own bubble, not the
    // field's role=alert — see the w47 note in g2-verdicts).
    expect(input.validity.rangeUnderflow).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(putWorkflowBudget).not.toHaveBeenCalled();
    // Layer 2 — the dialog's own `parsed <= 0` guard, reached by a submit that
    // skips constraint validation: it lands on the field's role=alert.
    fireEvent.submit(container.ownerDocument.querySelector('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Enter a daily amount greater than zero.');
    expect(putWorkflowBudget).not.toHaveBeenCalled();
  });

  it('saves a valid amount and clears the field error on edit', async () => {
    putWorkflowBudget.mockResolvedValue({ dailyUsd: 7.5, hardCap: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SetBudgetDialog workflow={workflow} onSaved={onSaved} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await screen.findByRole('alert');
    const input = screen.getByLabelText("Daily budget (USD)");
    fireEvent.change(input, { target: { value: '7.5' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(putWorkflowBudget).toHaveBeenCalledWith('wf_1', { dailyUsd: 7.5, hardCap: false });
    expect(onClose).toHaveBeenCalled();
  });

  it('branches transport copy on the encoded status (404 is not "try again")', async () => {
    putWorkflowBudget.mockRejectedValue(new Error('budget_put_404'));
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Daily budget (USD)"), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() => {
      expect(screen.getByText('This workflow no longer exists on the server — refresh the workflows list.')).toBeTruthy();
    });
    expect(screen.queryByText(/Try again in a moment/)).toBeNull();
  });

  it('branches transport copy on a 400 too (a rejected amount is not "try again")', async () => {
    putWorkflowBudget.mockRejectedValue(new Error('budget_put_400'));
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Daily budget (USD)"), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() => {
      expect(screen.getByText('The server rejected this amount. Enter a daily amount greater than zero.')).toBeTruthy();
    });
    expect(screen.queryByText(/Try again in a moment/)).toBeNull();
  });

  it('uses the generic transport copy for a 5xx-style failure', async () => {
    putWorkflowBudget.mockRejectedValue(new Error('budget_put_500'));
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Daily budget (USD)"), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() => {
      expect(screen.getByText("Couldn't save the budget. Try again in a moment.")).toBeTruthy();
    });
  });

  it('shows the spent-today context line from getWorkflowBudget (ux-14)', async () => {
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    // The amount is the read's 1.25 — not merely the label.
    expect(await screen.findByText('Spent today: $1.25')).toBeTruthy();
    expect(getWorkflowBudget).toHaveBeenCalledWith('wf_1');
  });

  it('stays usable when the spent-today read fails (fail-soft)', async () => {
    getWorkflowBudget.mockRejectedValue(new Error('budget_get_500'));
    render(<SetBudgetDialog workflow={workflow} onSaved={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(getWorkflowBudget).toHaveBeenCalled());
    // Settle: the rejection has been delivered to the dialog's catch.
    await act(async () => { await getWorkflowBudget.mock.results[0]!.value.catch(() => undefined); });
    expect(screen.queryByText(/Spent today:/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Save budget' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
