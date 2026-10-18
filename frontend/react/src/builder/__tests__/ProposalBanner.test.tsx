/**
 * ADR 0473 Phase 3 — the builder proposal banner. Pins the save-then-approve
 * order (approve-what-you-see: the canvas persists FIRST, the hash of exactly
 * what was saved is what the decide carries) and the reject-with-note path.
 *
 * The review client is mocked with importOriginal, so a decide failure is the
 * product's REAL `ReviewRequestError` (a hand-written stand-in could drift from
 * the `reason` field the banner branches on). Absence is asserted only after
 * the pending list has resolved.
 *
 * Sabotage that turns it red: skipping persistDraft, deciding with the stale
 * hash, dropping the note, mis-mapping proposal_stale, not announcing (or
 * announcing a failure politely), matching a proposal for another workflow, or
 * a wrong run link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReviewRequest } from '../../chat/reviews/reviewClient.js';

type ReviewClient = typeof import('../../chat/reviews/reviewClient.js');
const listReviews = vi.fn<ReviewClient['listReviews']>();
const getReview = vi.fn<ReviewClient['getReview']>();
const decideReview = vi.fn<ReviewClient['decideReview']>();

vi.mock('../../chat/reviews/reviewClient.js', async (orig) => ({
  ...(await orig<ReviewClient>()),
  listReviews: (...a: Parameters<ReviewClient['listReviews']>) => listReviews(...a),
  getReview: (...a: Parameters<ReviewClient['getReview']>) => getReview(...a),
  decideReview: (...a: Parameters<ReviewClient['decideReview']>) => decideReview(...a),
}));
vi.mock('../../notifications/signalBus.js', () => ({
  subscribeReviewSignal: () => () => {},
}));
// PROPU-3 — spy the imperative announce primitive. The apply/reject OUTCOME must
// be spoken through the always-mounted GlobalLiveRegion, not a conditionally-
// mounted role=status that arrives already populated (which announces nothing).
const announceSpy = vi.fn<(msg: string, opts?: { assertive?: boolean }) => void>();
vi.mock('../../ui/announce.js', () => ({
  announce: (...a: unknown[]) => announceSpy(...(a as [string, { assertive?: boolean }?])),
  useAnnouncer: () => announceSpy,
}));

const { ProposalBanner } = await import('../ProposalBanner.js');
const { useBuilderStore } = await import('../store/builderStore.js');
const { ReviewRequestError } = await import('../../chat/reviews/reviewClient.js');

afterEach(cleanup);

const proposal: ReviewRequest = {
  reviewId: 'approval:appr-p3',
  source: 'approval',
  kind: 'composed-workflow',
  workflowId: 'agent-wf-p3',
  status: 'pending',
  tenantId: 't1',
  conversationId: 'conv-9',
  requestedAt: '2026-07-23T00:00:00Z',
  summary: 'Morning lead digest',
  actions: [{ action: 'approve' }, { action: 'reject' }],
  provenanceRefs: [],
  composedWorkflow: { definitionHash: 'pin', liveDefinitionHash: 'pin', nodeCount: 2, edgeCount: 1 },
};

beforeEach(() => {
  listReviews.mockReset();
  getReview.mockReset();
  decideReview.mockReset();
  announceSpy.mockReset();
  // The F3 canvas-identity guard: the store must be ON the proposal's draft.
  useBuilderStore.setState({ workflowId: 'agent-wf-p3' });
});

describe('ProposalBanner (ADR 0473 Phase 3)', () => {
  it('renders nothing when no pending proposal references the draft', async () => {
    listReviews.mockResolvedValue([{ ...proposal, workflowId: 'someone-else' }]);
    const { container } = render(<MemoryRouter><ProposalBanner workflowId="agent-wf-p3" persistDraft={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(listReviews).toHaveBeenCalled());
    // Settle: the pending list has RESOLVED and been applied before absence is read.
    await act(async () => { await listReviews.mock.results[0]!.value; });
    expect(container.querySelector('.builder-proposal-banner')).toBeNull();
  });

  it('Approve & run persists the canvas FIRST, then decides with the fresh live hash', async () => {
    listReviews.mockResolvedValue([proposal]);
    const order: string[] = [];
    const persistDraft = vi.fn(async () => { order.push('persist'); });
    getReview.mockImplementation(async () => {
      order.push('getReview');
      return { ...proposal, composedWorkflow: { ...proposal.composedWorkflow!, liveDefinitionHash: 'fresh-after-save' } };
    });
    decideReview.mockImplementation(async () => {
      order.push('decide');
      return { reviewId: proposal.reviewId, status: 'approved', runId: 'run-77' };
    });
    render(<MemoryRouter><ProposalBanner workflowId="agent-wf-p3" persistDraft={persistDraft} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Approve & run/ }));
    await waitFor(() => expect(decideReview).toHaveBeenCalledWith(
      proposal.reviewId, 'approve', { expectedDefinitionHash: 'fresh-after-save' },
    ));
    expect(order).toEqual(['persist', 'getReview', 'decide']);
    expect(await screen.findByText(/Approved — the run has started/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /View run/ }).getAttribute('href')).toBe('/runs/run-77');
  });

  it('reject sends the note and reports the archived outcome (no persist, no hash)', async () => {
    listReviews.mockResolvedValue([proposal]);
    const persistDraft = vi.fn();
    decideReview.mockResolvedValue({ reviewId: proposal.reviewId, status: 'rejected' });
    render(<MemoryRouter><ProposalBanner workflowId="agent-wf-p3" persistDraft={persistDraft} /></MemoryRouter>);
    fireEvent.change(await screen.findByPlaceholderText(/Add a note/), { target: { value: 'wrong shape' } });
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(decideReview).toHaveBeenCalledWith(proposal.reviewId, 'reject', { note: 'wrong shape' }));
    expect(persistDraft).not.toHaveBeenCalled();
    expect(await screen.findByText(/Rejected — the draft was archived/)).toBeTruthy();
  });

  it('a proposal_stale 409 surfaces the localized error and keeps the banner decidable', async () => {
    listReviews.mockResolvedValue([proposal]);
    getReview.mockResolvedValue(proposal);
    decideReview.mockRejectedValue(new ReviewRequestError('conflict: changed', 'conflict', 409, 'proposal_stale'));
    render(<MemoryRouter><ProposalBanner workflowId="agent-wf-p3" persistDraft={vi.fn()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Approve & run/ }));
    expect(await screen.findByText(/changed while deciding/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve & run/ })).toBeTruthy();
  });
});

describe('PROPU-3 — apply/reject outcome is ANNOUNCED via the live region (ordinal 239)', () => {
  it('speaks the approve outcome through announce() (polite), not a mounted role=status', async () => {
    listReviews.mockResolvedValue([proposal]);
    getReview.mockResolvedValue(proposal);
    decideReview.mockResolvedValue({ reviewId: proposal.reviewId, status: 'approved', runId: 'run-77' });
    const { container } = render(<MemoryRouter><ProposalBanner workflowId="agent-wf-p3" persistDraft={vi.fn()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Approve & run/ }));
    await screen.findByText(/Approved — the run has started/);
    // The outcome is spoken imperatively…
    await waitFor(() => expect(announceSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Approved/), expect.objectContaining({ assertive: false }),
    ));
    // …and the outcome element is NOT a conditionally-mounted live region.
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('speaks the reject outcome through announce()', async () => {
    listReviews.mockResolvedValue([proposal]);
    decideReview.mockResolvedValue({ reviewId: proposal.reviewId, status: 'rejected' });
    render(<MemoryRouter><ProposalBanner workflowId="agent-wf-p3" persistDraft={vi.fn()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Reject/ }));
    await screen.findByText(/Rejected — the draft was archived/);
    await waitFor(() => expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/Rejected/), expect.anything()));
  });

  it('speaks a decide FAILURE assertively, and the error is not a mounted role=alert', async () => {
    listReviews.mockResolvedValue([proposal]);
    getReview.mockResolvedValue(proposal);
    decideReview.mockRejectedValue(new ReviewRequestError('conflict: changed', 'conflict', 409, 'proposal_stale'));
    const { container } = render(<MemoryRouter><ProposalBanner workflowId="agent-wf-p3" persistDraft={vi.fn()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Approve & run/ }));
    await screen.findByText(/changed while deciding/);
    await waitFor(() => expect(announceSpy).toHaveBeenCalledWith(
      expect.stringMatching(/changed while deciding/), expect.objectContaining({ assertive: true }),
    ));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
