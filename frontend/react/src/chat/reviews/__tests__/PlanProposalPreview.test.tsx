/**
 * ADR 0501 step 4 — the three states must stay distinguishable on screen.
 *
 * Collapsing any two of them recreates the defect the ADR exists to remove: a confident
 * answer the system did not earn. In particular a FAILED fetch must not render as "no
 * changes" — that is the house `absence-is-a-claim` defect, and it would tell a
 * participant their plan is already correct when we simply could not read it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const { fetchProposalPreview } = vi.hoisted(() => ({ fetchProposalPreview: vi.fn() }));
vi.mock('../reviewClient.js', () => ({ fetchProposalPreview }));

import { PlanProposalPreview } from '../PlanProposalPreview.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const mount = (): void => { render(<PlanProposalPreview enrollmentId="enr-1" proposalId="prop-1" />); };

describe('PlanProposalPreview — three distinct states', () => {
  it('renders the changes when the dry run succeeds', async () => {
    fetchProposalPreview.mockResolvedValue({
      kind: 'changes',
      changes: [{ lane: 'schedule', line: 'Move your sessions to the morning' }],
    });
    mount();
    await waitFor(() => expect(screen.getByText('Move your sessions to the morning')).toBeTruthy());
  });

  it('says ADVICE-ONLY rather than showing an empty diff', async () => {
    fetchProposalPreview.mockResolvedValue({ kind: 'advice-only' });
    mount();
    // The distinction that matters: advice-only is NOT "no changes to your plan".
    await waitFor(() => expect(screen.getByText(/advice only/i)).toBeTruthy());
  });

  it('a FAILED fetch says so — it must not read as "no changes"', async () => {
    fetchProposalPreview.mockRejectedValue(new Error('boom'));
    mount();
    // Wait for the failure COPY to be present, not for an absence — an absence check on
    // an already-empty tree resolves on the first tick and synchronises nothing.
    await waitFor(() => expect(screen.getByText(/couldn’t work out what this would change/i)).toBeTruthy());
    // And it must not have degraded into the advice-only or empty-change wording.
    expect(screen.queryByText(/advice only/i)).toBeNull();
  });

  it('does not fetch again on re-render with the same ids', async () => {
    fetchProposalPreview.mockResolvedValue({ kind: 'advice-only' });
    const { rerender } = render(<PlanProposalPreview enrollmentId="enr-1" proposalId="prop-1" />);
    await waitFor(() => expect(screen.getByText(/advice only/i)).toBeTruthy());
    rerender(<PlanProposalPreview enrollmentId="enr-1" proposalId="prop-1" />);
    expect(fetchProposalPreview).toHaveBeenCalledTimes(1);
  });
});
