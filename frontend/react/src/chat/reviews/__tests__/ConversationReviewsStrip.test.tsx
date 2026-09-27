/**
 * ADR 0473 grade-code C6 — the conversation strip's decide wiring: the card
 * reloads on decide FAILURE too (the F2 contract — a stale approve must
 * re-render the fresh live view), and on success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReviewRequest } from '../reviewClient.js';

const listReviews = vi.fn<() => Promise<ReviewRequest[]>>();
const decideReview = vi.fn<() => Promise<{ reviewId: string; status: string }>>();

class MockReviewRequestError extends Error {
  constructor(message: string, readonly errorCode: string, readonly httpStatus: number, readonly reason?: string) {
    super(message);
    this.name = 'ReviewRequestError';
  }
}

vi.mock('../reviewClient.js', () => ({
  listReviews: (...a: unknown[]) => listReviews(...(a as [])),
  decideReview: (...a: unknown[]) => decideReview(...(a as [])),
  getReview: vi.fn(),
  ReviewRequestError: MockReviewRequestError,
}));

const { ConversationReviewsStrip } = await import('../ConversationReviewsStrip.js');

afterEach(cleanup);
beforeEach(() => { listReviews.mockReset(); decideReview.mockReset(); });

const proposal: ReviewRequest = {
  reviewId: 'approval:appr-strip',
  source: 'approval',
  kind: 'composed-workflow',
  workflowId: 'agent-wf-strip',
  status: 'pending',
  tenantId: 't1',
  conversationId: 'conv-strip',
  requestedAt: '2026-07-23T00:00:00Z',
  summary: 'Strip proposal',
  actions: [{ action: 'approve', label: 'Approve & run' }, { action: 'reject', label: 'Reject' }],
  provenanceRefs: [],
  composedWorkflow: { definitionHash: 'pin', liveDefinitionHash: 'pin', nodeCount: 1, edgeCount: 0 },
};

describe('ConversationReviewsStrip (ADR 0473)', () => {
  it('reloads the list after a FAILED decide (the stale-card refresh contract)', async () => {
    listReviews.mockResolvedValue([proposal]);
    decideReview.mockRejectedValue(new MockReviewRequestError('conflict: changed', 'conflict', 409, 'proposal_stale'));
    render(<MemoryRouter><ConversationReviewsStrip conversationId="conv-strip" isSending={false} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Approve & run/ }));
    // load() ran once on mount and AGAIN in the finally after the failure.
    await waitFor(() => expect(listReviews).toHaveBeenCalledTimes(2));
    // The card surfaced the localized stale error rather than swallowing it.
    expect(await screen.findByText(/draft changed since you reviewed/i)).toBeTruthy();
  });

  it('reloads after a successful decide and drops the resolved card', async () => {
    listReviews.mockResolvedValueOnce([proposal]).mockResolvedValueOnce([]);
    decideReview.mockResolvedValue({ reviewId: proposal.reviewId, status: 'approved' });
    render(<MemoryRouter><ConversationReviewsStrip conversationId="conv-strip" isSending={false} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Approve & run/ }));
    await waitFor(() => expect(listReviews).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve & run/ })).toBeNull());
  });
});
