/**
 * ADR 0545 D3/P5 — the batched exceptions card.
 *
 * This screen IS the interruption budget, so what it must never do is turn one
 * chore back into several. The assertions are about batching, about the empty
 * state being a success state, and about the answer reporting what it bought.
 *
 * w52: the typed answer is no longer '6' (it equalled `blockedCount: 6`, so a
 * toast built from the ANSWER was indistinguishable), and what was sent is read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const toastSuccess = vi.fn();
vi.mock('../../../ui/toast.js', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));

type Client = typeof import('../jobSearchClient.js');
const { list, answer } = vi.hoisted(() => ({
  list: vi.fn<Client['listExceptions']>(),
  answer: vi.fn<Client['answerException']>(),
}));
vi.mock('../jobSearchClient.js', () => ({ listExceptions: list, answerException: answer }));

import { ExceptionsPage } from '../ExceptionsPage.js';
import type { CampaignException } from '../jobSearchClient.js';

const SIX_BLOCKED: CampaignException[] = [{
  questionKey: 'k8s.years', questionText: 'How many years of Kubernetes do you have?',
  reason: 'unknown', blockedCount: 6, firstSeenAt: '2026-03-01',
}];

describe('the exceptions card', () => {
  beforeEach(() => {
    list.mockReset(); answer.mockReset(); toastSuccess.mockReset();
    list.mockImplementation(async () => []);
    answer.mockImplementation(async () => undefined);
  });
  afterEach(cleanup);

  it('shows ONE row for a question blocking six applications', async () => {
    // The batching promise. Six rows here would be the interruption cost D3
    // exists to remove, re-created in the UI.
    list.mockImplementation(async () => SIX_BLOCKED);
    render(<ExceptionsPage />);
    expect(await screen.findByText(/years of Kubernetes/i)).toBeTruthy();
    expect(screen.getAllByText(/years of Kubernetes/i), 'one question, one chore').toHaveLength(1);
    expect(screen.getByText(/6 applications waiting/i)).toBeTruthy();
  });

  it('states the empty case as SUCCESS, not as missing content', async () => {
    render(<ExceptionsPage />);
    expect(await screen.findByText(/nothing waiting/i)).toBeTruthy();
    expect(screen.getByText(/without interruptions/i)).toBeTruthy();
  });

  it('reports what answering unblocked', async () => {
    // The reward for the interruption is the applications it releases; saying
    // the number is what makes the trade visible.
    list.mockImplementation(async () => SIX_BLOCKED);
    render(<ExceptionsPage />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '3 years' } });
    fireEvent.click(screen.getByRole('button', { name: /^answer$/i }));
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    // The answer is saved against the QUESTION TEXT the bank keys on.
    expect(answer).toHaveBeenCalledWith('How many years of Kubernetes do you have?', '3 years');
    // The count is INTERPOLATED into the message, not passed alongside it —
    // asserting on a second argument checked a shape the call does not have.
    expect(String(toastSuccess.mock.calls[0]![0])).toMatch(/6 applications unblocked/i);
  });

  it('keeps the question listed when saving fails', async () => {
    // Clearing it optimistically would lose the chore: the campaign stays
    // blocked and the user is never asked again.
    list.mockImplementation(async () => SIX_BLOCKED);
    answer.mockImplementation(async () => { throw new Error('down'); });
    render(<ExceptionsPage />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /^answer$/i }));
    expect(await screen.findByText(/still waiting/i)).toBeTruthy();
    expect(screen.getByText(/years of Kubernetes/i)).toBeTruthy();
  });

  it('a failed READ offers a retry rather than “nothing waiting”', async () => {
    // "Nothing waiting" on a failed read is the success state shown for a
    // failure — the user would think autopilot was healthy.
    list.mockImplementation(async () => { throw new Error('down'); });
    render(<ExceptionsPage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText(/nothing waiting/i)).toBeNull();
  });
});
