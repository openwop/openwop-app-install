/**
 * Marketplace hub wayfinding — Billing is where a workspace owner goes to change
 * what they pay for, so it links to the feature store (the Marketplace hub's
 * primary tab). The link follows the store's own gate: shown only while the
 * `marketplace` toggle is on (the route would render "not enabled" otherwise).
 * Both directions are pinned so "hidden" cannot pass against a deleted link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const marketplace = vi.hoisted(() => ({ on: true }));
vi.mock('../billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: vi.fn(async () => ({ tenantId: 't', planTier: 'free', status: 'none' })),
  getBalance: vi.fn(async () => ({ tenantId: 't', purchasedTokensTotal: 0, totalAvailable: 0 })),
  getAiCredits: vi.fn(async () => ({ freeDaily: null, monthly: null, balanceCredits: 0, windowDays: 30, topFeatures: [], otherCredits: 0 })),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => makeFeatureAccess({ enabled: id === 'marketplace' ? marketplace.on : true, loading: false }),
}));
vi.mock('../../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useEffectiveAccessState: () => ({ access: { basis: 'member', scopes: ['workspace:write', 'host:billing:manage'] }, resolved: true }),
}));

import { BillingPage } from '../BillingPage.js';
// ADR 0820 §7 — the "Your data" panel's read (its own tests: dataExport.test.tsx).
vi.mock('../dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

const at = () => render(<MemoryRouter initialEntries={['/billing']}><BillingPage /></MemoryRouter>);

beforeEach(() => { marketplace.on = true; });
afterEach(cleanup);

describe('BillingPage — links buyers to the feature store', () => {
  it('marketplace ON: a "Feature store" link to /marketplace/bundles', async () => {
    at();
    const link = await screen.findByRole('link', { name: /feature store/i });
    expect(link.getAttribute('href')).toBe('/marketplace/bundles');
  });
  it('marketplace OFF: no store link (control)', async () => {
    marketplace.on = false;
    at();
    await screen.findByRole('button', { name: /manage billing/i });
    expect(screen.queryByRole('link', { name: /feature store/i })).toBeNull();
  });
});
