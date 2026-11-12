/**
 * ADR 1092 D2 — the Memory tab's proposal list: pending proposals with
 * Approve/Dismiss for a writer, read-only for others, nothing when none are
 * pending, and a failed read that says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ list: vi.fn(), decide: vi.fn() }));
vi.mock('../projectsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listMemoryProposals: (id: string) => api.list(id), decideMemoryProposal: (...a: unknown[]) => api.decide(...a) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MemoryProposals } from '../MemoryProposals.js';

const pending = { proposalId: 'p1', text: 'The client prefers brass.', proposer: 'agent', proposedAt: '2027-01-25T00:00:00Z', status: 'pending' };
beforeEach(() => { api.list.mockReset(); api.decide.mockReset(); });
afterEach(cleanup);

describe('ADR 1092 — memory proposals on the Memory tab', () => {
  it('a writer approves; approval reloads the memory list', async () => {
    api.list.mockResolvedValueOnce([pending]).mockResolvedValueOnce([]);
    api.decide.mockResolvedValue({ ...pending, status: 'approved' });
    const onApproved = vi.fn();
    render(<MemoryProposals projectId="x" canWrite onApproved={onApproved} />);
    expect(await screen.findByText('The client prefers brass.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('x', 'p1', 'approve'));
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
  });

  it('a reader sees the proposal without buttons; none pending renders nothing', async () => {
    api.list.mockResolvedValueOnce([pending]);
    render(<MemoryProposals projectId="x" canWrite={false} onApproved={() => undefined} />);
    expect(await screen.findByText('The client prefers brass.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    cleanup();
    api.list.mockResolvedValueOnce([{ ...pending, status: 'approved' }]);
    const { container } = render(<MemoryProposals projectId="x" canWrite onApproved={() => undefined} />);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(container.textContent).toBe('');
  });

  it('a failed read says so, with retry', async () => {
    api.list.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([pending]);
    render(<MemoryProposals projectId="x" canWrite onApproved={() => undefined} />);
    expect(await screen.findByText(/Memory proposals did not load/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('The client prefers brass.')).toBeTruthy();
  });
});
