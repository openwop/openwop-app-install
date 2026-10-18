/**
 * ADR 0473 grade-code C6 — the conversation strip's decide wiring: the strip
 * re-reads ITS conversation-scoped list on decide FAILURE too (the F2 contract —
 * a stale approve must re-render the fresh live view), and on success.
 *
 * The strip's read is told apart from the shared store's own unscoped
 * reconcile (`reviewStatusStore.decide` calls `refresh()` → `listReviews('pending')`
 * on a failed decide), which alone would satisfy a bare call count.
 *
 * Double guard (honest ceiling): the stale error line reaches the card twice —
 * the card's own catch of the rethrown error AND the store's kept failure
 * (`failureById`, consumed by the card; witnessed in reviewStatusStore.test.ts
 * "a failed decision is kept per review"). A strip that swallowed the error is
 * therefore NOT detectable here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../ReviewHandoff.js', () => ({ ReviewHandoff: () => null })); // own tests: reviewHandoff.test.tsx
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as ReviewClient from '../reviewClient.js';
import type { ReviewRequest } from '../reviewClient.js';

const listReviews = vi.fn<typeof ReviewClient.listReviews>();
const decideReview = vi.fn<typeof ReviewClient.decideReview>();

// The REAL ReviewRequestError (the store and the card branch on it).
vi.mock('../reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewClient>()),
  listReviews: (...a: Parameters<typeof ReviewClient.listReviews>) => listReviews(...a),
  decideReview: (...a: Parameters<typeof ReviewClient.decideReview>) => decideReview(...a),
  getReview: vi.fn(),
}));

const { ReviewRequestError } = await import('../reviewClient.js');
const { ConversationReviewsStrip } = await import('../ConversationReviewsStrip.js');
const { useReviewStatusStore } = await import('../reviewStatusStore.js');

/** The strip's own reads: pending, scoped to this conversation. */
const scopedReads = (): number =>
  listReviews.mock.calls.filter(([status, opts]) => status === 'pending' && opts?.conversationId === 'conv-strip').length;

afterEach(cleanup);
beforeEach(() => {
  listReviews.mockReset();
  decideReview.mockReset();
  useReviewStatusStore.setState({ reviews: [], statusById: {}, failureById: {}, loading: false, error: null, errorCause: null, initialized: false, _busCleanup: null, _refcount: 0 });
});

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
    decideReview.mockRejectedValue(new ReviewRequestError('conflict: changed', 'conflict', 409, 'proposal_stale'));
    render(<MemoryRouter><ConversationReviewsStrip conversationId="conv-strip" isSending={false} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Approve & run/ }));
    // The strip's scoped load() ran once on mount and AGAIN in the finally.
    await waitFor(() => expect(scopedReads()).toBe(2));
    // Positive control: the store's UNSCOPED reconcile also ran — and is excluded above.
    expect(listReviews.mock.calls.some(([status, opts]) => status === 'pending' && opts?.conversationId === undefined)).toBe(true);
    // The card surfaced the localized stale error (double-guarded — see header).
    expect(await screen.findByText(/draft changed since you reviewed/i)).toBeTruthy();
  });

  it('reloads after a successful decide and drops the resolved card', async () => {
    listReviews.mockResolvedValueOnce([proposal]).mockResolvedValueOnce([]);
    decideReview.mockResolvedValue({ reviewId: proposal.reviewId, status: 'approved' });
    render(<MemoryRouter><ConversationReviewsStrip conversationId="conv-strip" isSending={false} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Approve & run/ }));
    await waitFor(() => expect(scopedReads()).toBe(2));
    expect(listReviews).toHaveBeenCalledTimes(2); // no unscoped read on success
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve & run/ })).toBeNull());
  });
});
