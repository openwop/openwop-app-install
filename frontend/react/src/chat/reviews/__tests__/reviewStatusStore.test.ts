/**
 * ADR 0074 — the client review-status store is the single source of truth all
 * review surfaces read/write. These tests prove the behaviors the
 * cross-surface sync depends on:
 *   1. a `review.updated` frame evicts a resolved review + patches quorum progress;
 *   2. `decide` is optimistic; a plain 409 is "already-resolved" (APUX-2), a
 *      still-pending 409 (ADR 0473 / ADR 0862) or any other failure RESTORES the
 *      row, keeps the failure for the remounted card (APUX-1) and rethrows.
 * Breaks if: a resolved review lingers in the inbox (badge lies), a failed
 * decision reads as success or empty, or a new pending approval never appears.
 * Sabotage-witnessed in /grade-tests wave 44 (w44g3-rss-*).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type * as ReviewClient from '../reviewClient.js';
import type { ReviewRequest } from '../reviewClient.js';
import type { Notification } from '../../../notifications/types.js';
import { publishReviewSignal } from '../../../notifications/signalBus.js';

const listReviews = vi.fn<typeof ReviewClient.listReviews>();
const decideReview = vi.fn<typeof ReviewClient.decideReview>();

// The REAL ReviewRequestError (the store's `instanceof` + `httpStatus` reads).
vi.mock('../reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewClient>()),
  listReviews: (...a: Parameters<typeof ReviewClient.listReviews>) => listReviews(...a),
  decideReview: (...a: Parameters<typeof ReviewClient.decideReview>) => decideReview(...a),
}));

const { ReviewRequestError } = await import('../reviewClient.js');
const { useReviewStatusStore, useReviewCountsByConversation } = await import('../reviewStatusStore.js');
const s = () => useReviewStatusStore.getState();

/** A `review.updated` signal frame, typed as the notification store forwards it. */
function frame(metadata: Record<string, unknown>, extra: Partial<Notification> = {}): Notification {
  return {
    notificationId: `n-${String(metadata.reviewId ?? 'x')}`, type: 'review.updated', priority: 'low', status: 'unread',
    title: '', message: '', createdAt: '2026-06-19T00:00:00Z', metadata, ...extra,
  };
}
/** A list read that never settles: only the store's own `prev` restore can bring a row back. */
const neverSettles = (): Promise<ReviewRequest[]> => new Promise<ReviewRequest[]>(() => {});

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
    s()._applySignal(frame({ reviewId: 'interrupt:a', status: 'resolved' }, { runId: 'r-a', nodeId: 'gate' }));
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:b']);
    expect(s().statusById['interrupt:a']?.status).toBe('resolved');
    // The run/node secondary index is recorded for run-scoped card lookup.
    expect(s().statusById['interrupt:a']?.runId).toBe('r-a');
    expect(s().statusById['interrupt:a']?.nodeId).toBe('gate');
  });

  it('patches quorum progress in place on a pending frame (keeps the review)', () => {
    useReviewStatusStore.setState({ reviews: [review('approval:q', { policy: { requiredApprovals: 3, approvals: 1, rejections: 0 } })] });
    s()._applySignal(frame({ reviewId: 'approval:q', status: 'pending', policy: { requiredApprovals: 3, approvals: 2, rejections: 0 } }));
    expect(s().reviews).toHaveLength(1);
    expect(s().reviews[0]!.policy?.approvals).toBe(2);
  });

  it('FIFO-caps statusById so a long session cannot grow it unbounded', () => {
    // Apply more terminal frames than the cap; the oldest must be evicted while
    // the most recent are retained. The size is read after EVERY insert: an
    // over-trim by one (drop 2 at 501, refill to 500 at 502) returns to exactly
    // 500 on every even count past the cap, so a single read at 520 cannot see it
    // (w44g3-rss-cap-boundary-r2 was vacuous for exactly that reason).
    const wrongSizes: Array<{ after: number; size: number }> = [];
    for (let i = 0; i < 521; i++) {
      s()._applySignal(frame({ reviewId: `interrupt:${i}`, status: 'resolved' }));
      const size = Object.keys(s().statusById).length;
      if (size !== Math.min(i + 1, 500)) wrongSizes.push({ after: i + 1, size });
    }
    expect(wrongSizes).toEqual([]);
    // Exactly the cap (500 of 521, an ODD count past it): the 21 oldest go.
    expect(Object.keys(s().statusById)).toHaveLength(500);
    expect(s().statusById['interrupt:0']).toBeUndefined();
    expect(s().statusById['interrupt:20']).toBeUndefined();
    expect(s().statusById['interrupt:21']).toBeTruthy();
    expect(s().statusById['interrupt:520']).toBeTruthy();
  });

  it('ignores a malformed frame (no reviewId / status)', () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    // Each frame misses ONE field, so a guard that needs both missing (or none)
    // lets it through: a status-less frame would evict `interrupt:a`.
    s()._applySignal(frame({ reviewId: 'interrupt:a' }));
    s()._applySignal(frame({ status: 'resolved' }));
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:a']);
    expect(s().statusById).toEqual({});
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
    decideReview.mockRejectedValue(new ReviewRequestError('interrupt_already_resolved: Review already resolved.', 'interrupt_already_resolved', 409));
    await expect(s().decide('interrupt:a', 'approve')).resolves.toBe('already-resolved');
    expect(s().reviews).toHaveLength(0);
  });

  it('a non-409 error whose TEXT says "conflict" is a failure, not a resolved review (was: message regex)', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    listReviews.mockImplementation(neverSettles);
    decideReview.mockRejectedValue(new ReviewRequestError('validation_error: resolve value conflicts with schema', 'validation_error', 400));
    await expect(s().decide('interrupt:a', 'approve')).rejects.toThrow('conflicts');
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:a']);
  });

  it('a failed decision is kept per review, so the REMOUNTED card can show it; a retry clears it (APUX-1)', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    listReviews.mockResolvedValue([review('interrupt:a')]);
    const refused = new ReviewRequestError('forbidden_scope: Missing required scope: approvals:respond', 'forbidden_scope', 403);
    decideReview.mockRejectedValue(refused);
    await expect(s().decide('interrupt:a', 'approve')).rejects.toBe(refused);
    expect(s().failureById['interrupt:a']).toBe(refused);
    decideReview.mockResolvedValue({ reviewId: 'interrupt:a', status: 'resolved' });
    await s().decide('interrupt:a', 'approve');
    expect(s().failureById['interrupt:a']).toBeUndefined();
  });

  it('restores the review and rethrows on a non-409 failure', async () => {
    useReviewStatusStore.setState({ reviews: [review('interrupt:a')] });
    listReviews.mockImplementation(neverSettles);
    decideReview.mockRejectedValue(new Error('http_error: HTTP 500'));
    await expect(s().decide('interrupt:a', 'approve')).rejects.toThrow('500');
    // Restored by the store itself (the reconcile read never settles here).
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:a']);
    expect(s().statusById['interrupt:a']).toBeUndefined();
    expect(listReviews).toHaveBeenCalledTimes(1); // and a reconcile was started
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
    listReviews.mockResolvedValue([review('interrupt:a')]);
    await s().connect();
    await s().connect();
    expect(s()._refcount).toBe(2);
    expect(listReviews).toHaveBeenCalledTimes(1); // hydrated once, not per caller
    expect(s()._busCleanup).not.toBeNull();
    s().disconnect();
    expect(s()._busCleanup).not.toBeNull(); // still one caller
    // Positive control: while connected, a bus frame IS applied.
    publishReviewSignal(frame({ reviewId: 'interrupt:a', status: 'pending', policy: { requiredApprovals: 2, approvals: 1, rejections: 0 } }));
    expect(s().reviews[0]!.policy?.approvals).toBe(1);
    s().disconnect();
    expect(s()._busCleanup).toBeNull();
    // No subscription leaks past the last disconnect (a second one would apply this).
    publishReviewSignal(frame({ reviewId: 'interrupt:a', status: 'resolved' }));
    expect(s().reviews.map((r) => r.reviewId)).toEqual(['interrupt:a']);
  });
});

describe('reviewStatusStore — ADR 0473 still-pending 409s (review F1)', () => {
  it('proposal_stale RESTORES the optimistically-dropped review and rethrows', async () => {
    useReviewStatusStore.setState({ reviews: [review('approval:cw-1'), review('approval:other')] });
    listReviews.mockImplementation(neverSettles);
    decideReview.mockRejectedValue(new ReviewRequestError(
      'conflict: The draft changed since it was reviewed', 'conflict', 409, 'proposal_stale',
    ));
    await expect(s().decide('approval:cw-1', 'approve', {})).rejects.toThrow(/draft changed/);
    // NOT swallowed as success: the review is back in the pending list.
    expect(s().reviews.map((r) => r.reviewId)).toContain('approval:cw-1');
    expect(s().statusById['approval:cw-1']).toBeUndefined();
  });

  it('ADR 0862 — an assistant `action_changed` 409 is still pending too: restored, not dropped', async () => {
    useReviewStatusStore.setState({ reviews: [review('approval:act-1')] });
    listReviews.mockImplementation(neverSettles);
    decideReview.mockRejectedValue(new ReviewRequestError('conflict: This action changed', 'conflict', 409, 'action_changed'));
    await expect(s().decide('approval:act-1', 'approve', {})).rejects.toThrow(/action changed/);
    expect(s().reviews.map((r) => r.reviewId)).toContain('approval:act-1');
  });

  it('a classic already-resolved 409 (no reason) keeps the drop and reports already-resolved', async () => {
    useReviewStatusStore.setState({ reviews: [review('approval:cw-2')] });
    decideReview.mockRejectedValue(new ReviewRequestError('conflict: Approval already approved.', 'conflict', 409));
    await expect(s().decide('approval:cw-2', 'approve', {})).resolves.toBe('already-resolved');
    expect(s().reviews.map((r) => r.reviewId)).not.toContain('approval:cw-2');
  });
});

describe('ADR 0776 — waiting on you, per conversation', () => {
  it('groups the ONE inbox by conversation', async () => {
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
      s()._applySignal(frame({ reviewId: 'new-1', status: 'pending' }));
      s()._applySignal(frame({ reviewId: 'new-2', status: 'pending' })); // debounced into ONE read
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
      listReviews.mockResolvedValue([review('known'), review('fresh')]);
      s()._applySignal(frame({ reviewId: 'known', status: 'pending' }));
      s()._applySignal(frame({ reviewId: 'gone', status: 'approved' }));
      await vi.advanceTimersByTimeAsync(500);
      expect(listReviews.mock.calls.length - before).toBe(0);
      // Positive control: the module-level debounce was FREE (a refresh timer
      // leaked from an earlier case would also produce the 0 above) — an
      // unseen pending frame now does schedule exactly one read.
      s()._applySignal(frame({ reviewId: 'fresh', status: 'pending' }));
      await vi.advanceTimersByTimeAsync(500);
      expect(listReviews.mock.calls.length - before).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
