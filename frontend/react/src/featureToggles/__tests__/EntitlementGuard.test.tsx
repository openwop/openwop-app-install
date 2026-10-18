/**
 * ADR 0419 — EntitlementGuard ROUTING. The guard decides, from `useFeatureAccess`,
 * whether to render the feature, a busy state, or the (lazy) locked panel. The
 * locked panel's own for-sale logic is tested in LockedState.test.tsx; here the
 * catalog sells nothing, so the panel settles on its generic locked copy.
 *
 * Sabotage that turns it red: `if (!locked) return children` → always (case 2),
 * → never (case 1); dropping `if (loading) return busy()` (case 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { makeFeatureAccess } from '../__testing__/makeFeatureAccess.js';
import type { BundleCommerce, FeatureBundleCatalog, PublicPlanTier } from '../../features/marketplace/marketplaceClient.js';

let state = { locked: false, loading: false };
vi.mock('../FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ ...state, enabled: true, entitled: !state.locked }),
  // ADR 0873 D12 — online throughout; the offline legs live in offlineEntitlement.test.tsx.
  useAccessOffline: () => ({ offline: false, retry: () => {} }),
}));

import { EntitlementGuard } from '../EntitlementGuard.js';
// ADR 0820 §7 — the lock page's export button read (its own tests: features/billing/__tests__/dataExport.test.tsx).
vi.mock('../../features/billing/dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

vi.mock('../../features/marketplace/marketplaceClient.js', () => ({
  fetchFeatureBundles: async (): Promise<FeatureBundleCatalog> => ({ available: true, bundles: [], standalone: [], core: [] }),
  fetchBundleCommerce: async (): Promise<BundleCommerce[]> => [],
  fetchPublicPricing: async (): Promise<PublicPlanTier[]> => [],
}));

const LOCKED_TITLE = 'This feature needs an upgrade';
const view = () => render(
  <MemoryRouter><EntitlementGuard featureId="crm"><div>FEATURE CONTENT</div></EntitlementGuard></MemoryRouter>,
);
beforeEach(() => { state = { locked: false, loading: false }; });
afterEach(cleanup);

describe('EntitlementGuard routing (ADR 0419)', () => {
  it('renders the feature when not locked', () => {
    view();
    expect(screen.getByText('FEATURE CONTENT')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does NOT render the feature when locked (defers to the locked panel)', async () => {
    state = { locked: true, loading: false };
    view();
    // Wait for the lazy locked panel to actually render, then assert no leak.
    expect(await screen.findByText(LOCKED_TITLE, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText('FEATURE CONTENT')).toBeNull();
  });

  it('does not flash the feature while access is resolving', () => {
    state = { locked: false, loading: true };
    view();
    expect(screen.queryByText('FEATURE CONTENT')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy(); // busy, announced
    expect(screen.queryByText(LOCKED_TITLE)).toBeNull(); // busy is not "locked"
  });
});
