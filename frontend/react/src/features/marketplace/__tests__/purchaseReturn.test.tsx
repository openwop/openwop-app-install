/**
 * MKT-UX-2 / MKT-UX-9 — the buyer's post-checkout screen, and the demo toast that
 * lied about a live charge.
 *
 * MKT-UX-2. Stripe's `successUrl` was `/commerce-connect?purchase=success` — the
 * SELLER-ONBOARDING page — and `grep -rn "purchase=success" frontend/react/src`
 * returned ZERO hits, so the param persisted in the URL, unread. For the typical
 * buyer (not a seller) `getSellerAccount()` resolves null and that page renders
 * "Become a seller … Start selling". The screen shown immediately after a
 * completed charge therefore named no amount, no pack, no order id and no
 * fulfilment expectation, and offered a Stripe onboarding CTA. The data was
 * already on the wire and thrown away: the route returns the full order and the
 * client typed the response as `{ url, mode }`.
 *
 * MKT-UX-9. `if (mode === 'live' && /^https:/.test(url))` fell through to the
 * DEMO toast — "no Stripe key is configured … recorded as a pending demo order" —
 * for a LIVE response with an unusable url. That sentence asserts the ABSENCE OF
 * A CHARGE to a user whose live checkout session may exist server-side, and the
 * demo sentinel (`demo:checkout:<id>`) fails the same regex, so the two branches
 * were conflated by construction rather than distinguished.
 *
 * The receipt must be built from the ORDER and never from optimism: fulfilment
 * rides the webhook, so `pending` is the honest arrival state, and an order we
 * cannot READ must not be reported as a failed purchase.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listListings: vi.fn(),
  fetchDisabledPacks: vi.fn(),
  listOrgs: vi.fn(),
  getPurchaseOrder: vi.fn(),
  purchaseListing: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../marketplaceClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});
vi.mock('../../../ui/toast.js', () => ({ toast: toasts, Toaster: () => null }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
// MPL-2 (review fold-in) — Buy is now ALSO gated on the caller holding
// `workspace:write` (the scope `POST …/purchase/checkout` requires), and the hook
// fails CLOSED, so without this fixture there is no Buy button to click and these
// MKT-UX-9 cases would go red for a reason that has nothing to do with what they
// assert. The gate itself is exercised in `buyScopeGate.test.tsx`; here it is a
// precondition, mocked the way `chrome/__tests__/Sidebar.lock.test.tsx` does.
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/useEffectiveAccess.js')>()),
  useEffectiveAccess: () => ({ roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' }),
}));

import { MarketplacePage } from '../MarketplacePage.js';

const ORDER = {
  orderId: 'cco_abc', packName: 'vendor.acme.nodes', amountMajorUnits: 99,
  currency: 'usd', applicationFeeMajorUnits: 12, status: 'pending' as const,
  mode: 'live' as const, createdAt: '2026-01-01T00:00:00Z',
};

const at = (search: string) => render(
  <MemoryRouter initialEntries={[`/marketplace${search}`]}><MarketplacePage /></MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.listListings.mockResolvedValue({ listings: [], pricingDegraded: false });
  api.fetchDisabledPacks.mockResolvedValue([]);
  api.listOrgs.mockResolvedValue([]);
});
afterEach(cleanup);

describe('MKT-UX-2 — a buyer returning from Stripe gets a receipt, on the page they started from', () => {
  it('reads ?purchase=success, fetches the order, and names the pack AND the amount', async () => {
    api.getPurchaseOrder.mockResolvedValue(ORDER);
    at('?purchase=success&order=cco_abc&pack=vendor.acme.nodes');

    await waitFor(() => expect(api.getPurchaseOrder).toHaveBeenCalledWith('cco_abc'));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const msg = String(toasts.success.mock.calls[0]?.[0]);
    expect(msg, 'the receipt must name the pack').toContain('vendor.acme.nodes');
    expect(msg, 'and the money — the whole point of a receipt').toMatch(/99/);
    // Pending is the HONEST arrival state: fulfilment rides the webhook.
    expect(msg).toMatch(/confirm/i);
  });

  it('re-reads the catalog so a webhook that already landed shows as purchased', async () => {
    api.getPurchaseOrder.mockResolvedValue({ ...ORDER, status: 'paid' });
    at('?purchase=success&order=cco_abc');
    // Once on mount, once after the return is handled.
    await waitFor(() => expect(api.listListings.mock.calls.length).toBeGreaterThan(1));
  });

  it('an UNREADABLE order is not reported as a failed purchase', async () => {
    // The failure-as-answer shape, on money. "We could not read it" and "it
    // failed" are different facts and only one of them is known here.
    api.getPurchaseOrder.mockResolvedValue(null);
    at('?purchase=success&order=cco_abc');
    await waitFor(() => expect(toasts.info).toHaveBeenCalled());
    expect(String(toasts.info.mock.calls[0]?.[0])).toMatch(/not a sign that the purchase failed/i);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('a FAILED order says nothing was charged', async () => {
    api.getPurchaseOrder.mockResolvedValue({ ...ORDER, status: 'failed' });
    at('?purchase=success&order=cco_abc');
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(String(toasts.error.mock.calls[0]?.[0])).toMatch(/nothing was charged/i);
  });

  it('?purchase=cancelled says nothing was charged, and never fetches an order', async () => {
    at('?purchase=cancelled&order=cco_abc&pack=vendor.acme.nodes');
    await waitFor(() => expect(toasts.info).toHaveBeenCalled());
    expect(String(toasts.info.mock.calls[0]?.[0])).toMatch(/nothing was charged/i);
    expect(api.getPurchaseOrder).not.toHaveBeenCalled();
  });

  it('an ordinary visit with no ?purchase toasts nothing (the handler is not always-on)', async () => {
    at('');
    await waitFor(() => expect(api.listListings).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.info).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });
});

describe('MKT-UX-9 — a LIVE mode with an unusable url no longer claims "no real charge"', () => {
  const PAID = {
    packName: 'vendor.paid.nodes', version: '1.0.0', title: 'Paid Pack', category: 'nodes',
    installed: false, origin: 'registry' as const,
    pricing: { lane: 'native-paid' as const, priceMajorUnits: 99, currency: 'usd', purchasable: true },
  };

  it('reports that we could NOT open checkout, instead of the demo sentence', async () => {
    api.listListings.mockResolvedValue({ listings: [PAID], pricingDegraded: false });
    // A live session whose url is unusable — empty, `http://`, or malformed.
    api.purchaseListing.mockResolvedValue({ order: ORDER, url: '', mode: 'live' });
    at('');

    const buy = await screen.findByRole('button', { name: /^buy$/i });
    buy.click();

    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    const msg = String(toasts.error.mock.calls[0]?.[0]);
    expect(msg, 'must not assert the absence of a charge').not.toMatch(/no real charge|demo mode/i);
    expect(msg).toMatch(/could not open the checkout page/i);
    expect(toasts.info, 'the DEMO toast must not fire for a live response').not.toHaveBeenCalled();
  });

  it('a genuine DEMO response still gets the demo sentence (the branches stay distinguished)', async () => {
    api.listListings.mockResolvedValue({ listings: [PAID], pricingDegraded: false });
    api.purchaseListing.mockResolvedValue({ order: { ...ORDER, mode: 'demo' }, url: 'demo:checkout:cco_abc', mode: 'demo' });
    at('');

    (await screen.findByRole('button', { name: /^buy$/i })).click();
    await waitFor(() => expect(toasts.info).toHaveBeenCalled());
    expect(String(toasts.info.mock.calls[0]?.[0])).toMatch(/demo mode/i);
    expect(toasts.error).not.toHaveBeenCalled();
  });
});
