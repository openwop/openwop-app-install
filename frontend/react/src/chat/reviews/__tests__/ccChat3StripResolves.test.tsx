/**
 * CC-CHAT-3 — the conversation's "Needs your approval" strip drops a card as soon
 * as its gate resolves anywhere, instead of leaving live Approve/Reject buttons.
 *
 * MEASURED on app.openwop.dev (373d4863a, 2026-11-12): after approving (and,
 * separately, rejecting) a messaging-kernel gate on the in-feed card, the strip
 * above the composer still showed the same gate In-flight with live buttons;
 * clicking Approve there answered 409. The strip read its conversation-scoped
 * list only on mount and when a turn settled, and never consulted the shared
 * review-status store that the `review.updated` signal frames update.
 *
 * Pins: a review the store has learned is terminal (by reviewId, or by the
 * run+node a run-scoped card resolves) is no longer rendered; a review still
 * pending stays (control).
 *
 * Red when: the strip stops filtering by the shared store's live status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../ReviewHandoff.js', () => ({ ReviewHandoff: () => null }));
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as ReviewClient from '../reviewClient.js';
import type { ReviewRequest } from '../reviewClient.js';

const listReviews = vi.fn<typeof ReviewClient.listReviews>();
vi.mock('../reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewClient>()),
  listReviews: (...a: Parameters<typeof ReviewClient.listReviews>) => listReviews(...a),
  decideReview: vi.fn(),
  getReview: vi.fn(),
}));

const { ConversationReviewsStrip } = await import('../ConversationReviewsStrip.js');
const { useReviewStatusStore } = await import('../reviewStatusStore.js');

afterEach(cleanup);
beforeEach(() => {
  listReviews.mockReset();
  useReviewStatusStore.setState({ reviews: [], statusById: {}, failureById: {}, loading: false, error: null, errorCause: null, initialized: false, _busCleanup: null, _refcount: 0 });
});

const gate = (id: string, summary: string, runId: string): ReviewRequest => ({
  reviewId: id,
  source: 'interrupt',
  kind: 'approval',
  workflowId: 'campaign-studio.messaging-kernel',
  runId,
  nodeId: 'approve',
  status: 'pending',
  tenantId: 't1',
  conversationId: 'conv-cc3',
  requestedAt: '2026-11-12T01:48:00Z',
  summary,
  actions: [{ action: 'approve', label: 'Approve' }, { action: 'reject', label: 'Reject' }],
  provenanceRefs: [],
});

const renderStrip = () => render(<MemoryRouter><ConversationReviewsStrip conversationId="conv-cc3" isSending={false} /></MemoryRouter>);

describe('CC-CHAT-3 — strip follows the shared live status', () => {
  it('drops a card once the store learns its gate is resolved (by reviewId)', async () => {
    listReviews.mockResolvedValue([gate('interrupt:k1', 'Kernel gate one', 'run-1'), gate('interrupt:k2', 'Kernel gate two', 'run-2')]);
    renderStrip();
    expect(await screen.findByText('Kernel gate one')).toBeTruthy();
    act(() => { useReviewStatusStore.setState({ statusById: { 'interrupt:k1': { reviewId: 'interrupt:k1', status: 'approved', runId: 'run-1', nodeId: 'approve' } } }); });
    await waitFor(() => expect(screen.queryByText('Kernel gate one')).toBeNull());
    expect(screen.getByText('Kernel gate two')).toBeTruthy(); // control: still pending
  });

  it('drops a card resolved on a run-scoped card (matched by run + node)', async () => {
    listReviews.mockResolvedValue([gate('interrupt:k3', 'Kernel gate three', 'run-3')]);
    renderStrip();
    expect(await screen.findByText('Kernel gate three')).toBeTruthy();
    act(() => { useReviewStatusStore.setState({ statusById: { 'interrupt:other-id': { reviewId: 'interrupt:other-id', status: 'rejected', runId: 'run-3', nodeId: 'approve' } } }); });
    await waitFor(() => expect(screen.queryByText('Kernel gate three')).toBeNull());
  });

  it('the review’s own pending entry wins over a terminal run+node match (fallback only)', async () => {
    listReviews.mockResolvedValue([gate('interrupt:k4', 'Kernel gate four', 'run-4')]);
    renderStrip();
    expect(await screen.findByText('Kernel gate four')).toBeTruthy();
    act(() => { useReviewStatusStore.setState({ statusById: {
      'interrupt:k4': { reviewId: 'interrupt:k4', status: 'pending', runId: 'run-4', nodeId: 'approve' },
      'interrupt:old-k4': { reviewId: 'interrupt:old-k4', status: 'rejected', runId: 'run-4', nodeId: 'approve' },
    } }); });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Kernel gate four')).toBeTruthy();
  });
});
