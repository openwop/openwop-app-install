/**
 * ADR 0074 — the client review-status store is the single source of truth all
 * review surfaces read/write. These tests prove the two behaviors the
 * cross-surface sync depends on:
 *   1. a `review.updated` frame evicts a resolved review + patches quorum progress;
 *   2. `decide` is optimistic and treats 409 (already-resolved) as success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  ReviewRequestError: MockReviewRequestError,
}));

const { useReviewStatusStore } = await import('../reviewStatusStore.js');
const s = () => useReviewStatusStore.getState();

function review(id: string, extra: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    reviewId: id,
    source: 'interrupt',
    kind: 'approval',
    status: 'pending',
    tenantId: 'default',
    requestedAt: '2026-06-19T00:00:00Z',
    actions: [{ action: 'approve' }, { action: 'reject' }],
    provenanceRefs: [],
    ...extra,
  };
}

beforeEach(() => {
  listReviews.mockReset();
  decideReview.mockReset();
  useReviewStatusStore.setState({ reviews: [], statusById: {}, loading: false, error: null, errorCause: null, failureById: {}, initialized: false, _busCleanup: null, _refcount: 0 });
});

describe('reviewStatusStore — signal frames', () => {
  it('evicts a review when a frame reports a terminal status', () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a'), review('interrupt:b')] });
    s()._applySignal({
      notificationId: 'n1', type: 'review.updated', priority: 'low', status: 'unread',
      title: '', message: '', runId: 'r-a', nodeId: 'gate', createdAt: 'now',
      metadata: { reviewId: 'interrupt:a', status: 'resolved' },
    });
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:b']);
    expect(s().statusById['interrupt:a']?.status).toBe('resolved');
    // The run/node secondary index is recorded for run-scoped card lookup.
    expect(s().statusById['interrupt:a']?.runId).toBe('r-a');
    expect(s().statusById['interrupt:a']?.nodeId).toBe('gate');
  });

  it('patches quorum progress in place on a pending frame (keeps the review)', () => {
    useReviewStatusStore.setState({ reviews: [review('approval:q', { policy: { requiredApprovals: 3, approvals: 1, rejections: 0 } })] });
    s()._applySignal({
      notificationId: 'n2', type: 'review.updated', priority: 'low', status: 'unread',
      title: '', message: '', createdAt: 'now',
      metadata: { reviewId: 'approval:q', status: 'pending', policy: { requiredApprovals: 3, approvals: 2, rejections: 0 } },
    });
    expect(s().reviews).toHaveLength(1);
    expect(s().reviews[0]!.policy?.approvals).toBe(2);
  });

  it('FIFO-caps statusById so a long session cannot grow it unbounded', () => {
    // Apply more terminal frames than the cap; the oldest must be evicted while
    // the most recent are retained.
    for (let i = 0; i < 520; i++) {
      s()._applySignal({
        notificationId: `n${i}`, type: 'review.updated', priority: 'low', status: 'unread',
        title: '', message: '', createdAt: 'now',
        metadata: { reviewId: `interrupt:${i}`, status: 'resolved' },
      });
    }
    const ids = Object.keys(useReviewStatusStore.getState().statusById);
    expect(ids.length).toBeLessThanOrEqual(500);
    expect(useReviewStatusStore.getState().statusById['interrupt:0']).toBeUndefined(); // oldest evicted
    expect(useReviewStatusStore.getState().statusById['interrupt:519']).toBeTruthy();   // newest kept
  });

  it('ignores a malformed frame (no reviewId / status)', () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    s()._applySignal({
      notificationId: 'n3', type: 'review.updated', priority: 'low', status: 'unread',
      title: '', message: '', createdAt: 'now', metadata: {},
    });
    expect(s().reviews).toHaveLength(1);
  });
});

describe('reviewStatusStore — decide', () => {
  it('optimistically drops the review and resolves on success', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a'), review('interrupt:b')] });
    decideReview.mockResolvedValue({ reviewId: 'interrupt:a', status: 'resolved' });
    await expect(s().decide('interrupt:a', 'approve')).resolves.toBe('recorded');
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:b']);
    expect(s().statusById['interrupt:a']?.status).toBe('approved');
  });

  it('a 409 (already resolved) keeps the optimistic drop and says so — not "recorded" (ADR 0778 APUX-2)', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    decideReview.mockRejectedValue(new MockReviewRequestError('interrupt_already_resolved: Review already resolved.', 'interrupt_already_resolved', 409));
    await expect(s().decide('interrupt:a', 'approve')).resolves.toBe('already-resolved');
    expect(s().reviews).toHaveLength(0);
  });

  it('a non-409 error whose TEXT says "conflict" is a failure, not a resolved review (was: message regex)', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    listReviews.mockResolvedValue([review('interrupt:a')]);
    decideReview.mockRejectedValue(new MockReviewRequestError('validation_error: resolve value conflicts with schema', 'validation_error', 400));
    await expect(s().decide('interrupt:a', 'approve')).rejects.toThrow('conflicts');
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:a']);
  });

  it('a failed decision is kept per review, so the REMOUNTED card can show it; a retry clears it (APUX-1)', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    listReviews.mockResolvedValue([review('interrupt:a')]);
    const refused = new MockReviewRequestError('forbidden_scope: Missing required scope: approvals:respond', 'forbidden_scope', 403);
    decideReview.mockRejectedValue(refused);
    await expect(s().decide('interrupt:a', 'approve')).rejects.toBe(refused);
    expect(s().failureById['interrupt:a']).toBe(refused);
    decideReview.mockResolvedValue({ reviewId: 'interrupt:a', status: 'resolved' });
    await s().decide('interrupt:a', 'approve');
    expect(s().failureById['interrupt:a']).toBeUndefined();
  });

  it('restores the review and rethrows on a non-409 failure', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    listReviews.mockResolvedValue([review('interrupt:a')]);
    decideReview.mockRejectedValue(new Error('http_error: HTTP 500'));
    await expect(s().decide('interrupt:a', 'approve')).rejects.toThrow('500');
    expect(s().statusById['interrupt:a']).toBeUndefined();
  });
});

describe('reviewStatusStore — connect / refresh', () => {
  it('refresh hydrates the pending list but drops reviews with a terminal override', async () => {
    useReviewStatusStore.setState({ statusById: { 'interrupt:a': { reviewId: 'interrupt:a', status: 'resolved' } } });
    listReviews.mockResolvedValue([review('interrupt:a'), review('interrupt:b')]);
    await s().refresh();
    // 'interrupt:a' was resolved mid-fetch (override) ⇒ not resurrected.
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:b']);
    expect(s().initialized).toBe(true);
  });

  it('marks the first read settled on failure without claiming an empty inbox', async () => {
    listReviews.mockRejectedValue(new Error('offline'));
    await s().refresh();
    expect(s().initialized).toBe(true);
    expect(s().error).toBe('offline');
    expect(s().reviews).toEqual([]);
  });

  it('connect is ref-counted: one subscription shared, last disconnect tears down', async () => {
    listReviews.mockResolvedValue([]);
    await s().connect();
    await s().connect();
    expect(s()._refcount).toBe(2);
    expect(s()._busCleanup).not.toBeNull();
    s().disconnect();
    expect(s()._busCleanup).not.toBeNull(); // still one caller
    s().disconnect();
    expect(s()._busCleanup).toBeNull();
  });
});

describe('reviewStatusStore — ADR 0473 still-pending 409s (review F1)', () => {
  it('proposal_stale RESTORES the optimistically-dropped review and rethrows', async () => {
    useReviewStatusStore.setState({ reviews: [review('approval:cw-1'), review('approval:other')] });
    listReviews.mockResolvedValue([review('approval:cw-1'), review('approval:other')]);
    decideReview.mockRejectedValue(new MockReviewRequestError(
      'conflict: The draft changed since it was reviewed', 'conflict', 409, 'proposal_stale',
    ));
    await expect(s().decide('approval:cw-1', 'approve', {})).rejects.toThrow(/draft changed/);
    // NOT swallowed as success: the review is back in the pending list.
    expect(s().reviews.map((r) => r.reviewId)).toContain('approval:cw-1');
    expect(s().statusById['approval:cw-1']).toBeUndefined();
  });

  it('ADR 0862 — an assistant `action_changed` 409 is still pending too: restored, not dropped', async () => {
    useReviewStatusStore.setState({ reviews: [review('approval:act-1')] });
    listReviews.mockResolvedValue([review('approval:act-1')]);
    decideReview.mockRejectedValue(new MockReviewRequestError('conflict: This action changed', 'conflict', 409, 'action_changed'));
    await expect(s().decide('approval:act-1', 'approve', {})).rejects.toThrow(/action changed/);
    expect(s().reviews.map((r) => r.reviewId)).toContain('approval:act-1');
  });

  it('a classic already-resolved 409 (no reason) keeps the drop and reports already-resolved', async () => {
    useReviewStatusStore.setState({ reviews: [review('approval:cw-2')] });
    decideReview.mockRejectedValue(new MockReviewRequestError('conflict: Approval already approved.', 'conflict', 409));
    await expect(s().decide('approval:cw-2', 'approve', {})).resolves.toBe('already-resolved');
    expect(s().reviews.map((r) => r.reviewId)).not.toContain('approval:cw-2');
  });
});

describe('ADR 0776 — waiting on you, per conversation', () => {
  it('groups the ONE inbox by conversation', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useReviewCountsByConversation } = await import('../reviewStatusStore.js');
    useReviewStatusStore.setState({ reviews: [review('a', { conversationId: 'c1' }), review('b', { conversationId: 'c1' }), review('c', { conversationId: 'c2' }), review('d')] });
    const { result } = renderHook(() => useReviewCountsByConversation());
    expect(Object.fromEntries(result.current)).toEqual({ c1: 2, c2: 1 });
  });

  it('re-reads the inbox when a frame names a PENDING review it has never seen (frames never add)', async () => {
    vi.useFakeTimers();
    try {
      listReviews.mockResolvedValue([review('new-1', { conversationId: 'c9' })]);
      useReviewStatusStore.setState({ reviews: [], statusById: {} });
      const before = listReviews.mock.calls.length;
      s()._applySignal({ metadata: { reviewId: 'new-1', status: 'pending' } } as never);
      s()._applySignal({ metadata: { reviewId: 'new-2', status: 'pending' } } as never); // debounced into ONE read
      await vi.advanceTimersByTimeAsync(500);
      expect(listReviews.mock.calls.length - before).toBe(1);
      expect(s().reviews.map((r) => r.reviewId)).toEqual(['new-1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT re-read for a terminal frame or an already-known pending review', async () => {
    vi.useFakeTimers();
    try {
      useReviewStatusStore.setState({ reviews: [review('known')], statusById: {} });
      const before = listReviews.mock.calls.length;
      s()._applySignal({ metadata: { reviewId: 'known', status: 'pending' } } as never);
      s()._applySignal({ metadata: { reviewId: 'gone', status: 'approved' } } as never);
      await vi.advanceTimersByTimeAsync(500);
      expect(listReviews.mock.calls.length - before).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
