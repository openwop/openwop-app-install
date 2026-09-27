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
  useReviewStatusStore.setState({ reviews: [], statusById: {}, loading: false, error: null, initialized: false, _busCleanup: null, _refcount: 0 });
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
    await s().decide('interrupt:a', 'approve');
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:b']);
    expect(s().statusById['interrupt:a']?.status).toBe('approved');
  });

  it('treats a 409 (already resolved) as success — keeps the optimistic drop', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    decideReview.mockRejectedValue(new Error('conflict: HTTP 409'));
    await expect(s().decide('interrupt:a', 'approve')).resolves.toBeUndefined();
    expect(s().reviews).toHaveLength(0);
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

  it('a classic already-resolved 409 (no reason) stays treat-as-success', async () => {
    useReviewStatusStore.setState({ reviews: [review('approval:cw-2')] });
    decideReview.mockRejectedValue(new MockReviewRequestError('conflict: Approval already approved.', 'conflict', 409));
    await expect(s().decide('approval:cw-2', 'approve', {})).resolves.toBeUndefined();
    expect(s().reviews.map((r) => r.reviewId)).not.toContain('approval:cw-2');
  });
});
