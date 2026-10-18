/**
 * ADR 0877 D4 / grade-ux CC2UX-1 — a DEMO seller row offers the live re-onboard.
 *
 * A demo row reads "Enabled" after "Refresh status" (the demo sync flips it), and
 * the page offered a CTA only for `pending|restricted` — so the store owner the
 * "Connect Stripe" notice sent here met a page with NO action, while the backend's
 * D4 upgrade path waited behind `startOnboarding`. Also pins the two arrivals from
 * Stripe that were silent (CC2UX-5 link expired, CC2UX-6 refresh failed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  getSellerAccount: vi.fn(), getSellerStats: vi.fn(), syncSellerAccount: vi.fn(), startOnboarding: vi.fn(),
  listApprovals: vi.fn(), listAdminOrders: vi.fn(), listAdminDisputes: vi.fn(), listOwnListings: vi.fn(),
}));
vi.mock('../commerceConnectClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
import { ApiError, type SellerAccount } from '../commerceConnectClient.js';
import { CommerceConnectPage } from '../CommerceConnectPage.js';

const seller = (over: Partial<SellerAccount> = {}): SellerAccount => ({
  tenantId: 't1', stripeAccountId: 'acct_demo_t1', onboardingState: 'enabled', chargesEnabled: true, payoutsEnabled: true,
  region: 'US', capabilities: ['card_payments', 'transfers'], mode: 'demo', createdAt: '', updatedAt: '', ...over,
});
const forbidden = () => Promise.reject(new ApiError('forbidden', 403));

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; a rejected sync must not survive into another case.
  api.syncSellerAccount.mockReset();
  api.startOnboarding.mockReset();
  api.getSellerStats.mockResolvedValue(null);
  api.listOwnListings.mockResolvedValue([]);
  api.listApprovals.mockImplementation(forbidden);
  api.listAdminOrders.mockImplementation(forbidden);
  api.listAdminDisputes.mockImplementation(forbidden);
});
afterEach(cleanup);

describe('ADR 0877 — the Connect page for a store owner', () => {
  it('a demo row reading "Enabled" still offers the live connect, which calls onboarding', async () => {
    api.getSellerAccount.mockResolvedValue(seller());
    api.startOnboarding.mockResolvedValue({ seller: seller(), url: 'demo:connect-onboarding', mode: 'demo' });
    render(<MemoryRouter><CommerceConnectPage /></MemoryRouter>);
    const cta = await screen.findByRole('button', { name: /connect your real stripe account/i });
    fireEvent.click(cta);
    expect(api.startOnboarding).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/store’s checkout now takes live payments/i)).toBeNull();
  });

  it('a live enabled account says the store checkout is live and links back to the store', async () => {
    api.getSellerAccount.mockResolvedValue(seller({ mode: 'live', stripeAccountId: 'acct_live_1' }));
    render(<MemoryRouter><CommerceConnectPage /></MemoryRouter>);
    expect(await screen.findByText(/store’s checkout now takes live payments/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /back to your store/i }).getAttribute('href')).toBe('/commerce');
    expect(screen.queryByRole('button', { name: /connect your real stripe account/i })).toBeNull();
  });

  it('?onboarding=refresh explains the expired link', async () => {
    api.getSellerAccount.mockResolvedValue(seller({ mode: 'live', onboardingState: 'pending', chargesEnabled: false }));
    render(<MemoryRouter initialEntries={['/commerce-connect?onboarding=refresh']}><CommerceConnectPage /></MemoryRouter>);
    expect(await screen.findByText(/setup link expired/i)).toBeTruthy();
    expect(api.syncSellerAccount).not.toHaveBeenCalled();
  });

  it('?onboarding=return with a failed sync states it and shows the last status we had', async () => {
    api.getSellerAccount.mockResolvedValue(seller({ mode: 'live', onboardingState: 'pending', chargesEnabled: false }));
    api.syncSellerAccount.mockRejectedValue(new Error('stripe down'));
    render(<MemoryRouter initialEntries={['/commerce-connect?onboarding=return']}><CommerceConnectPage /></MemoryRouter>);
    const notices = await screen.findAllByText(
      'Back from Stripe, but we could not refresh your status from Stripe. This is the last status we had; use “Refresh status” to try again.',
    );
    expect(notices.length).toBeGreaterThanOrEqual(1);
    // CC2UX-6's second half: the fallback read ran, and the status it returned is on screen.
    expect(api.syncSellerAccount).toHaveBeenCalledTimes(1);
    expect(api.getSellerAccount).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Onboarding pending').length).toBeGreaterThanOrEqual(1);
  });
});
