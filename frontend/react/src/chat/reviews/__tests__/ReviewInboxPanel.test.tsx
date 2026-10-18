/**
 * ADR 0778 — the inbox panel's outcome notice (grade-ux `APUX-2`, closing
 * review B1): deciding the LAST card empties the list before the outcome is
 * known, so a notice rendered inside the list never mounted and the final
 * decision went unheard; and a 409 must read "resolved elsewhere", never
 * "Decision recorded".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.mock('../ReviewHandoff.js', () => ({ ReviewHandoff: () => null })); // own tests: reviewHandoff.test.tsx
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type * as ReviewClient from '../reviewClient.js';
import type { ReviewRequest } from '../reviewClient.js';
import { announce, currentAnnouncements } from '../../../ui/announce.js';

const listReviews = vi.fn<typeof ReviewClient.listReviews>();
const decideReview = vi.fn<typeof ReviewClient.decideReview>();

// The REAL ReviewRequestError (the store maps a plain 409 by `httpStatus`).
vi.mock('../reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewClient>()),
  listReviews: (...a: Parameters<typeof ReviewClient.listReviews>) => listReviews(...a),
  decideReview: (...a: Parameters<typeof ReviewClient.decideReview>) => decideReview(...a),
  getReview: vi.fn(),
}));
vi.mock('../SlaPolicySection.js', () => ({ SlaPolicySection: () => null }));
vi.mock('../../../notifications/signalBus.js', () => ({ subscribeReviewSignal: () => () => {} }));

const { ReviewRequestError } = await import('../reviewClient.js');
const { ReviewInboxPanel } = await import('../ReviewInboxPanel.js');
const { useReviewStatusStore } = await import('../reviewStatusStore.js');

const only: ReviewRequest = {
  reviewId: 'approval:last', source: 'approval', kind: 'run-proposal', status: 'pending', tenantId: 't1',
  requestedAt: '2026-09-29T00:00:00Z', summary: 'The last one',
  actions: [{ action: 'approve', label: 'Approve' }], provenanceRefs: [],
};

beforeEach(() => {
  listReviews.mockReset();
  decideReview.mockReset();
  announce(''); // module-level live region: no carry-over between cases
  announce('', { assertive: true });
  useReviewStatusStore.setState({ reviews: [], statusById: {}, failureById: {}, loading: false, error: null, errorCause: null, initialized: false, _busCleanup: null, _refcount: 0 });
});
afterEach(cleanup);

describe('ReviewInboxPanel — the outcome is heard', () => {
  it('deciding the LAST card still shows "Decision recorded"', async () => {
    listReviews.mockResolvedValueOnce([only]).mockResolvedValue([]);
    decideReview.mockResolvedValue({ reviewId: only.reviewId, status: 'approved' });
    render(<ReviewInboxPanel onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText('Decision recorded.')).toBeTruthy();
    // HEARD, not just shown: the notice speaks through the shared live region.
    await vi.waitFor(() => expect(currentAnnouncements().polite).toContain('Decision recorded.'));
  });

  it('a 409 says "resolved elsewhere", never "Decision recorded"', async () => {
    listReviews.mockResolvedValueOnce([only]).mockResolvedValue([]);
    decideReview.mockRejectedValue(new ReviewRequestError('conflict: already', 'conflict', 409));
    render(<ReviewInboxPanel onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText(/resolved elsewhere/)).toBeTruthy();
    // The card's error path uses the SAME words (interrupts:resolvedElsewhere), so
    // pin that this is the polite outcome NOTICE: spoken politely, nothing
    // assertive, and the optimistic drop STANDS (an error path restores the card).
    await vi.waitFor(() => expect(currentAnnouncements().polite).toContain('This review was just resolved elsewhere.'));
    expect(currentAnnouncements().assertive).toBe('');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByText('Decision recorded.')).toBeNull();
  });
});
