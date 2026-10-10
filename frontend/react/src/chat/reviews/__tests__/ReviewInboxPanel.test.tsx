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
import type { ReviewRequest } from '../reviewClient.js';

const listReviews = vi.fn<() => Promise<ReviewRequest[]>>();
const decideReview = vi.fn<() => Promise<{ reviewId: string; status: string }>>();

class MockReviewRequestError extends Error {
  constructor(message: string, readonly errorCode: string, readonly httpStatus: number, readonly reason?: string) {
    super(message);
    this.name = 'ReviewRequestError';
  }
  get status(): number { return this.httpStatus; }
}

vi.mock('../reviewClient.js', () => ({
  listReviews: (...a: unknown[]) => listReviews(...(a as [])),
  decideReview: (...a: unknown[]) => decideReview(...(a as [])),
  getReview: vi.fn(),
  ReviewRequestError: MockReviewRequestError,
}));
vi.mock('../SlaPolicySection.js', () => ({ SlaPolicySection: () => null }));
vi.mock('../../../notifications/signalBus.js', () => ({ subscribeReviewSignal: () => () => {} }));

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
  });

  it('a 409 says "resolved elsewhere", never "Decision recorded"', async () => {
    listReviews.mockResolvedValueOnce([only]).mockResolvedValue([]);
    decideReview.mockRejectedValue(new MockReviewRequestError('conflict: already', 'conflict', 409));
    render(<ReviewInboxPanel onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText(/resolved elsewhere/)).toBeTruthy();
    expect(screen.queryByText('Decision recorded.')).toBeNull();
  });
});
