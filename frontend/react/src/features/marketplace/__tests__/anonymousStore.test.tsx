/**
 * ADR 0820 §7 — a SIGNED-OUT visitor who opens `/marketplace/bundles` directly.
 *
 * The catalog read answers 401 `sign_in_required` for them (`resolveCallerUser`
 * in `GET …/marketplace/feature-bundles`), and the page used to fold that into
 * "Bundles could not be loaded". It now branches on that explicit 401 and offers
 * the EXISTING header sign-in (`.signin-trigger`, the #4534 helper shared with
 * /pricing), remembering the exact store URL — query included — to return to.
 * Controls: a 500 is still the failure card; a signed-in visitor sees the store.
 *
 * Sabotage-witnessed (/grade-tests wave 10): dropping the explicit-401 branch reds the
 * first three cases; widening it to any ApiError reds the CONTROL; dropping `signedIn`
 * from the catalog effect's deps reds the re-read case (the rerender keeps the SAME
 * tree, so the page is not remounted and only the sign-in can trigger the re-read).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from '../../../client/errorEnvelope.js';
import { takeReturn } from '../../../auth/signInReturn.js';

const api = vi.hoisted(() => ({
  fetchFeatureBundles: vi.fn(), fetchBundleCommerce: vi.fn(), fetchPublicPricing: vi.fn(), getSubscription: vi.fn(),
}));
const h = vi.hoisted(() => ({ backendUser: null as null | { userId: string }, signinClicks: 0 }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../marketplaceClient.js', () => ({
  fetchFeatureBundles: api.fetchFeatureBundles, fetchBundleCommerce: api.fetchBundleCommerce, fetchPublicPricing: api.fetchPublicPricing,
}));
vi.mock('../../billing/billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: api.getSubscription, getTokenPacks: vi.fn(async () => []),
}));
vi.mock('../../billing/AiCreditMeter.js', () => ({ AiCreditMeter: () => null }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false, isConfigured: true }) }));
vi.mock('../../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: h.backendUser }) }));
import { BundleShopPage } from '../BundleShopPage.js';
import type { BundleCommerce, FeatureBundleCatalog } from '../marketplaceClient.js';

const CATALOG: FeatureBundleCatalog = { available: true, groups: [], bundles: [{ id: 'crm', label: 'CRM', features: [{ id: 'crm', label: 'Accounts', dependsOn: [], registered: true }] }], standalone: [], core: [] };
const RETURN_KEY = 'openwop.pricing.returnTo';

function Where(): JSX.Element { const l = useLocation(); return <output data-testid="where">{l.pathname + l.search}</output>; }
const tree = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    {/* Stand-in for the header's real sign-in trigger (auth/SignInButton). */}
    <button type="button" className="signin-trigger" onClick={() => { h.signinClicks++; }}>header sign in</button>
    <Routes><Route path="/marketplace/bundles" element={<><BundleShopPage /><Where /></>} /></Routes>
  </MemoryRouter>
);
const mount = (entry: string) => render(tree(entry));

beforeEach(() => {
  h.backendUser = null;
  h.signinClicks = 0;
  window.sessionStorage.clear();
  api.fetchFeatureBundles.mockReset().mockRejectedValue(new ApiError('Sign in to access your account.', 401, 'Sign in to access your account.'));
  api.fetchBundleCommerce.mockReset().mockRejectedValue(new ApiError('401', 401));
  api.fetchPublicPricing.mockReset().mockResolvedValue([]);
  api.getSubscription.mockReset().mockRejectedValue(new ApiError('401', 401));
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); });

describe('feature store — anonymous visitor (ADR 0820 §7)', () => {
  it('a 401 catalog read shows the sign-in prompt, not the failure card or outage notices', async () => {
    mount('/marketplace/bundles');
    expect(await screen.findByText('Sign in to open the feature store')).toBeTruthy();
    expect(screen.queryByText('Bundles could not be loaded')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('Sign in opens the HEADER sign-in and remembers the exact store URL, query included', async () => {
    mount('/marketplace/bundles?bundle=crm&view=compare');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(h.signinClicks).toBe(1);
    // Read back through the real reader — the one the store itself consumes.
    expect(takeReturn()).toBe('/marketplace/bundles?bundle=crm&view=compare');
  });

  it('after sign-in the store re-reads and renders, and the return key is consumed', async () => {
    const view = mount('/marketplace/bundles?bundle=crm');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    h.backendUser = { userId: 'u-1' };
    api.fetchFeatureBundles.mockReset().mockResolvedValue(CATALOG);
    api.fetchBundleCommerce.mockReset().mockResolvedValue([
      { bundleId: 'crm', forSale: true, owned: false, purchasable: true, cadences: ['month'], priceDisplay: { price: '$29', cadence: '/mo' } },
    ] satisfies BundleCommerce[]);
    api.getSubscription.mockReset().mockResolvedValue({ tenantId: 't', planTier: 'free', status: 'none' });
    // The SAME tree: the page stays mounted, so only the sign-in can trigger the re-read.
    view.rerender(tree('/marketplace/bundles?bundle=crm'));
    // Rendered, not merely past the sign-in card (the skeleton would satisfy that).
    expect(await screen.findByRole('heading', { level: 4, name: 'CRM' })).toBeTruthy();
    expect(screen.queryByText('Sign in to open the feature store')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/marketplace/bundles?bundle=crm');
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('CONTROL: a non-401 failure is still the honest failure card with Retry', async () => {
    api.fetchFeatureBundles.mockReset().mockRejectedValue(new ApiError('boom', 500));
    mount('/marketplace/bundles');
    expect(await screen.findByText('Bundles could not be loaded')).toBeTruthy();
    expect(screen.queryByText('Sign in to open the feature store')).toBeNull();
  });
});
