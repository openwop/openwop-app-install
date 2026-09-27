/**
 * A failed billing read must never state a plan or a balance.
 *
 * `getSubscription`/`getBalance` are typed NON-nullable — they resolve a record
 * or throw. So `sub === null` / `balance === null` in the page meant exactly one
 * thing: the read failed. The render nonetheless defaulted to
 * `plan_${sub?.planTier ?? 'free'}`, status `none`, and `balance?.totalAvailable
 * ?? 0`, so a transient 500 told a PAYING customer they were on the Free plan
 * with zero tokens — a money claim made by a read that never landed, on a page
 * whose "Manage billing" button leads straight to the payment provider.
 *
 * Both arms are asserted: without the success arm, the fix could regress into
 * "always show the error" and stay green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../billingClient.js', () => ({
  getSubscription: vi.fn(), getBalance: vi.fn(), openPortal: vi.fn(),
  getEntitlements: vi.fn(), startCheckout: vi.fn(),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { BillingPage } from '../BillingPage.js';
import { getSubscription, getBalance } from '../billingClient.js';

const mSub = vi.mocked(getSubscription);
const mBal = vi.mocked(getBalance);

beforeEach(() => { mSub.mockReset(); mBal.mockReset(); });
afterEach(cleanup);

describe('BillingPage — a failed read makes no money claim', () => {
  it('does NOT render "Free" or a 0 balance when the read fails', async () => {
    mSub.mockRejectedValue(new Error('billing upstream 503'));
    mBal.mockRejectedValue(new Error('billing upstream 503'));
    render(<BillingPage />);

    // ORDER IS LOAD-BEARING. Settle on something that renders in BOTH the fixed and
    // the broken state — the header's Manage action — so the money-claim assertions
    // below are actually REACHED when the fix is reverted.
    //
    // They were not, originally: a `waitFor` on the error copy threw first, so the
    // probe went red without ever evaluating the two assertions the test exists for.
    // The file being red is not evidence that the assertion you rely on is live.
    // (openwop-app-2 hit the same class in #2577 from the other direction.)
    await waitFor(() => expect(screen.getByRole('button', { name: /manage|opening/i })).toBeTruthy());
    // The two claims that used to be fabricated — checked FIRST:
    expect(screen.queryByText(/^Free$/)).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
    // Then that we say what happened, and surface the server's reason.
    expect(screen.getByText(/Could not load your plan or balance/i)).toBeTruthy();
    expect(screen.getByText(/billing upstream 503/)).toBeTruthy();
  });

  it('renders the real plan and balance when the read SUCCEEDS', async () => {
    mSub.mockResolvedValue({ planTier: 'pro', status: 'active' } as never);
    mBal.mockResolvedValue({ totalAvailable: 12345 } as never);
    render(<BillingPage />);

    await waitFor(() => expect(screen.getByText('12,345')).toBeTruthy());
    expect(screen.queryByText(/Could not load your plan or balance/i)).toBeNull();
  });

  it('a genuinely free account still reads Free — the fix is not "always error"', async () => {
    mSub.mockResolvedValue({ planTier: 'free', status: 'none' } as never);
    mBal.mockResolvedValue({ totalAvailable: 0 } as never);
    render(<BillingPage />);

    await waitFor(() => expect(screen.getByText(/^Free$/)).toBeTruthy());
    expect(screen.queryByText(/Could not load your plan or balance/i)).toBeNull();
  });
});
