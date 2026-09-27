/**
 * MPL-2 (review fold-in) — the client half of the scope gate on Buy.
 *
 * MPL-2 put `workspace:write` on `POST …/purchase/checkout` (and on the listing
 * writes), but NOTHING client-side learned about it. `purchasable` is computed by
 * `listingPricingFor` from TENANT-level facts only — lifecycle, seller state,
 * region, already-purchased — so a VIEWER in a shared workspace was still rendered
 * a primary **Buy** button and discovered the truth by pressing it: the 403 came
 * back through `toast.error(e.message)` as the raw, untranslated string
 * `Missing required scope: workspace:write`.
 *
 * The fix is the presentation-only pattern the repo already uses at
 * `DocumentsPage.tsx:169` / `ProjectsPage.tsx:84` — the backend remains the
 * authority (the route still 403s; `commerce-connect-rbac.test.ts` pins that on
 * five writes), the UI merely stops offering what it knows will be refused.
 *
 * WHY THIS FILE EXISTS SEPARATELY: `purchaseReturn.test.tsx` MOCKS the access hook
 * so its MKT-UX-9 toast cases have a Buy button to click. A gate that is mocked
 * away in the only file that renders it would be untested — so the discrimination
 * lives here, where the hook is the thing under test and both directions are
 * asserted. Asserting only the hidden direction would pass against a Buy button
 * that had simply been deleted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EffectiveAccess } from '../../../client/accessClient.js';

const api = vi.hoisted(() => ({
  listListings: vi.fn(),
  fetchDisabledPacks: vi.fn(),
  listOrgs: vi.fn(),
  getPurchaseOrder: vi.fn(),
  purchaseListing: vi.fn(),
}));
const access = vi.hoisted(() => ({ current: { roles: [], scopes: [], basis: 'none' } as EffectiveAccess }));

vi.mock('../marketplaceClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() }, Toaster: () => null }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/useEffectiveAccess.js')>()),
  useEffectiveAccess: () => access.current,
}));

import { MarketplacePage } from '../MarketplacePage.js';

/** A native-paid listing the TENANT is fully allowed to buy — every leg of
 *  `purchasable` is already true, so the ONLY variable below is the caller's
 *  scope. Without this the "hidden" case could pass for the wrong reason. */
const PAID = {
  packName: 'vendor.paid.nodes', version: '1.0.0', title: 'Paid Pack', category: 'nodes',
  installed: false, origin: 'registry' as const,
  pricing: { lane: 'native-paid' as const, priceMajorUnits: 99, currency: 'usd', purchasable: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listListings.mockResolvedValue({ listings: [PAID], pricingDegraded: false });
  api.fetchDisabledPacks.mockResolvedValue([]);
  api.listOrgs.mockResolvedValue([]);
});
afterEach(cleanup);

const at = () => render(
  <MemoryRouter initialEntries={['/marketplace']}><MarketplacePage /></MemoryRouter>,
);

describe('MPL-2 — Buy is gated on workspace:write, not on `purchasable` alone', () => {
  it('an EDITOR (workspace:write) is offered Buy', async () => {
    access.current = { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' };
    at();
    expect(await screen.findByRole('button', { name: /^buy$/i })).toBeTruthy();
  });

  it('a VIEWER on the SAME purchasable listing is not', async () => {
    access.current = { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' };
    at();
    // Wait for the listing to actually render, so "no Buy" is a statement about
    // the gate and not about an unfinished first paint — the assertion would pass
    // vacuously against an empty page.
    await waitFor(() => expect(screen.getByText('vendor.paid.nodes')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^buy$/i })).toBeNull();
  });

  it('an UNRESOLVED access read fails closed (no Buy), never open', async () => {
    // The hook resolves `basis:'none'` with zero scopes until the fetch lands and
    // on any fetch error. Buy moves money, so the ambiguous state must not offer it.
    access.current = { roles: [], scopes: [], basis: 'none' };
    at();
    await waitFor(() => expect(screen.getByText('vendor.paid.nodes')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^buy$/i })).toBeNull();
  });

  it('an OWNER is offered Buy — the gate is not simply closed', async () => {
    // `resolveEffectiveAccess` returns `[...OWNER_SCOPES]` on both `tenant-owner`
    // branches (`accessControlService.ts:1282,1299`), and OWNER_SCOPES ⊇
    // EDITOR_SCOPES ∋ `workspace:write`. Verified because a scopes-based check
    // would silently hide Buy from every owner — and from the demo host's
    // anonymous visitor — if ownership were implied rather than enumerated.
    access.current = { roles: ['owner'], scopes: ['workspace:read', 'workspace:write'], basis: 'tenant-owner' };
    at();
    expect(await screen.findByRole('button', { name: /^buy$/i })).toBeTruthy();
  });
});
