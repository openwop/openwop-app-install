/**
 * KTD-4 (KickTodo UX-ASSESSMENT) — the Safety & approvals inbox had no test.
 * It composes the ONE shared review store (ADR 0068/0074), filtered to the
 * KickTodo kinds; this runs the REAL store over a mocked review client. Pins:
 *  - only KickTodo kinds are shown (a non-KickTodo review never leaks in);
 *  - deciding a card delegates to the server and says "Decision recorded." — a
 *    409 says "resolved elsewhere" instead (ADR 0778);
 *  - a failed queue read is an error card with a working Retry, never
 *    "Nothing waiting".
 *
 * Breaks it (sabotage-witnessed): dropping the `isKickTodoReviewKind` filter;
 * the 409 outcome mapped to "Decision recorded."; the error card's Retry
 * removed; the empty state rendered on a failed read (`!error` dropped).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type * as ReviewClient from '../../../chat/reviews/reviewClient.js';
import type { ReviewRequest } from '../../../chat/reviews/reviewClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as chatEn } from '../../../chat/i18n/en.js';

const listReviews = vi.fn<typeof ReviewClient.listReviews>();
const decideReview = vi.fn<typeof ReviewClient.decideReview>();
vi.mock('../../../chat/reviews/reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewClient>()),
  listReviews: (...a: Parameters<typeof ReviewClient.listReviews>) => listReviews(...a),
  decideReview: (...a: Parameters<typeof ReviewClient.decideReview>) => decideReview(...a),
  getReview: vi.fn<typeof ReviewClient.getReview>(),
}));
vi.mock('../../../chat/reviews/ReviewHandoff.js', () => ({ ReviewHandoff: () => null }));
vi.mock('../../../notifications/signalBus.js', () => ({ subscribeReviewSignal: () => () => {} }));

const { ReviewRequestError } = await import('../../../chat/reviews/reviewClient.js');
const { useReviewStatusStore } = await import('../../../chat/reviews/reviewStatusStore.js');
const { SafetyInboxPage } = await import('../SafetyInboxPage.js');

const review = (over: Partial<ReviewRequest>): ReviewRequest => ({
  reviewId: 'approval:kt-1', source: 'approval', kind: 'challenge-publish', status: 'pending', tenantId: 't1',
  requestedAt: '2026-10-01T00:00:00Z', summary: 'Publish "Morning Walks" v2',
  actions: [{ action: 'approve', label: 'Approve' }], provenanceRefs: [],
  ...over,
});
const PUBLISH = review({});
const OTHER = review({ reviewId: 'approval:run-1', kind: 'run-proposal', summary: 'Run the nightly import' });

beforeEach(() => {
  listReviews.mockReset();
  decideReview.mockReset();
  useReviewStatusStore.setState({ reviews: [], statusById: {}, failureById: {}, loading: false, error: null, errorCause: null, initialized: false, _busCleanup: null, _refcount: 0 });
});
afterEach(cleanup);

describe('SafetyInboxPage (KTD-4)', () => {
  it('shows only KickTodo review kinds', async () => {
    listReviews.mockResolvedValue([PUBLISH, OTHER]);
    render(<SafetyInboxPage />);
    expect(await screen.findByText('Publish "Morning Walks" v2')).toBeTruthy();
    expect(screen.queryByText('Run the nightly import')).toBeNull();
  });

  it('deciding a card delegates to the server and says "Decision recorded."', async () => {
    listReviews.mockResolvedValueOnce([PUBLISH]).mockResolvedValue([]);
    decideReview.mockResolvedValue({ reviewId: PUBLISH.reviewId, status: 'approved' });
    render(<SafetyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText(en.decisionRecorded)).toBeTruthy();
    expect(decideReview).toHaveBeenCalledWith(PUBLISH.reviewId, 'approve', expect.anything());
  });

  it('a 409 says the review was resolved elsewhere, never "Decision recorded."', async () => {
    listReviews.mockResolvedValueOnce([PUBLISH]).mockResolvedValue([]);
    decideReview.mockRejectedValue(new ReviewRequestError('conflict: already', 'conflict', 409));
    render(<SafetyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText(chatEn.reviewResolvedElsewhere)).toBeTruthy();
    expect(screen.queryByText(en.decisionRecorded)).toBeNull();
  });

  it('a failed queue read is an error card with Retry, never "Nothing waiting"', async () => {
    listReviews.mockRejectedValueOnce(new Error('reviews failed: 503')).mockResolvedValue([PUBLISH]);
    render(<SafetyInboxPage />);
    expect(await screen.findByText(en.safetyErrorTitle)).toBeTruthy();
    expect(screen.queryByText(en.safetyEmptyTitle)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.retry }));
    expect(await screen.findByText('Publish "Morning Walks" v2')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(en.safetyErrorTitle)).toBeNull());
  });
});
