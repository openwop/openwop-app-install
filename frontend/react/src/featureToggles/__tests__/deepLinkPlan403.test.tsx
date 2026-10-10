/**
 * ADR 0419 §8 follow-on — a DEEP-LINKED feature page whose read gets the plan 403
 * ("Your plan (free) does not include this feature.") renders the specific upgrade
 * prompt, not an error card.
 *
 * End to end through the ONE shared mapping, with no per-page code: the page's
 * `requestJson` read 403s → `noteRequestStatus` re-resolves the access context
 * (UI-ENT-1b) → the entitlements now exclude the feature → `EntitlementGuard`
 * swaps the page for the lazy `LockedState` → which names the bundle and price.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect, useState } from 'react';

const entitlements = vi.hoisted(() => ({ current: '*' as '*' | string[] }));
vi.mock('../../client/featureTogglesClient.js', () => ({
  fetchAssignments: async () => [{ id: 'crm', status: 'on', enabled: true, variant: null }],
  fetchEntitlements: async () => entitlements.current,
}));
vi.mock('../../features/marketplace/marketplaceClient.js', () => ({
  fetchFeatureBundles: async () => ({
    available: true,
    bundles: [{ id: 'crm', label: 'CRM Suite', features: [{ id: 'crm', registered: true, dependsOn: [] }] }],
    standalone: [], core: [],
  }),
  fetchBundleCommerce: async () => [{
    bundleId: 'crm', forSale: true, owned: false, purchasable: true, cadences: ['month'],
    priceDisplay: { price: '$29', cadence: '/mo' },
  }],
  fetchPublicPricing: async () => [],
}));
vi.mock('../../lib/writeAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useScopeWriteAccess: () => true,
}));

// The page's own read: the backend refuses it with the central plan 403 — and,
// from this moment, so does the entitlements read.
vi.stubGlobal('fetch', vi.fn(async () => {
  entitlements.current = ['chat'];
  return new Response(JSON.stringify({ error: 'forbidden', message: 'Your plan (free) does not include this feature.', details: { feature: 'crm', plan: 'free' } }), {
    status: 403, headers: { 'content-type': 'application/json' },
  });
}));

import { FeatureAccessProvider } from '../FeatureAccessContext.js';
import { EntitlementGuard } from '../EntitlementGuard.js';
import { requestJson } from '../../client/requestJson.js';
import { __resetEntitlementRefreshForTest } from '../../client/entitlementRefresh.js';
// ADR 0820 §7 — the lock page's export button read (its own tests: features/billing/__tests__/dataExport.test.tsx).
vi.mock('../../features/billing/dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

function CrmPage(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { requestJson('/v1/host/openwop-app/crm/contacts').catch((e: Error) => setError(e.message)); }, []);
  return <div>{error ? `Couldn't load contacts: ${error}` : 'CRM PAGE'}</div>;
}

afterEach(() => { cleanup(); __resetEntitlementRefreshForTest(); });

describe('deep-linked page + plan 403 → the upgrade prompt (ADR 0419)', () => {
  it('replaces the page with the bundle-specific prompt, via the shared refresh + guard', async () => {
    render(
      <MemoryRouter>
        <FeatureAccessProvider>
          <EntitlementGuard featureId="crm"><CrmPage /></EntitlementGuard>
        </FeatureAccessProvider>
      </MemoryRouter>,
    );
    const cta = await screen.findByRole('link', { name: 'Add CRM Suite · $29/mo' }, { timeout: 4000 });
    expect(cta.getAttribute('href')).toBe('/marketplace/bundles?bundle=crm');
    expect(screen.queryByText(/Couldn't load contacts/)).toBeNull();
    expect(screen.queryByText('CRM PAGE')).toBeNull();
  });
});
