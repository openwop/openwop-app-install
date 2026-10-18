/**
 * ADR 0419 — LockedState: the panel a locked route renders.
 *
 * ADR 0419 §8 follow-on / ADR 0820 §7 — it names the bundle that sells the feature
 * and what it costs, resolved from catalog + store DATA:
 *  - buyable + may buy → "Add {bundle} · $X/mo" opening `?bundle=<id>` (never checkout),
 *    the yearly price underneath, and a plan line when a plan is the better buy;
 *  - buyable, may NOT buy (no `host:billing:manage`) → "ask a workspace admin", no CTA;
 *  - unpurchasable (DATA-419-2: unpriced) or the store unreadable → honest, no CTA;
 *  - a feature in no bundle → the generic copy, exactly as before.
 * While resolving it shows a busy card (no premature copy/CTA to swap).
 *
 * `forSale` and `purchasable` are SEPARATE knobs: DATA-419-2's unpriced bundle is
 * listed for sale but a checkout would not be accepted (`forSale:true,
 * purchasable:false`), which only `canPurchase`'s `purchasable` branch decides.
 * Sabotage that turns it red: `purchasable` → `forSale` in `canPurchase`; the
 * CTA ungated by `canBuy`; the `!upsell.purchasable` arm removed; the catch in
 * `useUpsell` leaving the card busy; the locked_view emitted while resolving.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let forSale = true;
let purchasable = true;
let clientThrows = false;
let storeThrows = false;
let resolveNever = false;
const calls = { catalog: 0, store: 0, pricing: 0 };
vi.mock('../../features/marketplace/marketplaceClient.js', () => ({
  fetchFeatureBundles: async () => {
    calls.catalog += 1;
    if (resolveNever) return new Promise(() => {}); // never settles → the resolving state
    if (clientThrows) throw new Error('offline');
    return {
      available: true,
      bundles: [
        { id: 'crm', label: 'CRM Suite', features: [{ id: 'crm', registered: true, dependsOn: [] }] },
        { id: 'leadership', label: 'Planning & Strategy', features: [{ id: 'okrs', registered: true, dependsOn: [] }] },
      ],
      standalone: [],
      core: [{ id: 'chat', registered: true, dependsOn: [] }],
    };
  },
  fetchBundleCommerce: async () => {
    calls.store += 1;
    if (clientThrows || storeThrows) throw new Error('offline');
    return [
      { bundleId: 'crm', forSale, owned: false, purchasable, cadences: ['month', 'year'],
        priceDisplay: { price: '$29', cadence: '/mo', priceAnnual: '$290', cadenceAnnual: '/yr', blurb: 'Pipeline, contacts and deals.' } },
      { bundleId: 'leadership', forSale: true, owned: false, purchasable: true, cadences: ['month'],
        priceDisplay: { price: '$19', cadence: '/mo' } },
    ];
  },
  fetchPublicPricing: async () => {
    calls.pricing += 1;
    return [{ tier: 'pro', name: 'Pro', limits: {}, features: ['bundle:crm', 'bundle:leadership'], display: { price: '$39', cadence: '/mo' } }];
  },
}));

let canBuy = true;
vi.mock('../../lib/writeAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useScopeWriteAccess: () => canBuy,
}));

const events: Array<{ name: string; ctx: Record<string, unknown> | undefined }> = [];
vi.mock('../../platform/telemetry.js', () => ({
  telemetry: { reportEvent: (name: string, ctx?: Record<string, unknown>) => { events.push({ name, ctx }); }, reportError() {}, reportMetric() {} },
}));

import { LockedState } from '../LockedState.js';
import { __resetLockedUpsellCacheForTest } from '../../features/marketplace/lockedUpsell.js';
// ADR 0820 §7 — the lock page's export button read (its own tests: features/billing/__tests__/dataExport.test.tsx).
vi.mock('../../features/billing/dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

const view = (featureId = 'crm') => render(<MemoryRouter><LockedState featureId={featureId} /></MemoryRouter>);
beforeEach(() => {
  forSale = true; purchasable = true; clientThrows = false; storeThrows = false; resolveNever = false; canBuy = true; events.length = 0;
  calls.catalog = 0; calls.store = 0; calls.pricing = 0;
  __resetLockedUpsellCacheForTest();
});
afterEach(cleanup);

describe('LockedState (ADR 0419)', () => {
  it('names the bundle, its value and price, and adds it via the store detail panel', async () => {
    view();
    const cta = await screen.findByRole('link', { name: 'Add CRM Suite · $29/mo' });
    expect(cta.getAttribute('href')).toBe('/marketplace/bundles?bundle=crm');
    expect(screen.getByText('This feature is part of CRM Suite')).toBeTruthy();
    expect(screen.getByText('Pipeline, contacts and deals.')).toBeTruthy();
    expect(screen.getByText(/or \$290\/yr/)).toBeTruthy();
  });

  it('offers the cheaper plan with a link to the comparison', async () => {
    view();
    expect(await screen.findByText(/Or get it with Pro \(\$39\/mo\), which includes 2 bundles/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Compare plans' }).getAttribute('href')).toBe('/marketplace/bundles?view=compare');
  });

  it('a viewer who cannot buy is told to ask an admin, with NO buy CTA', async () => {
    canBuy = false;
    view();
    expect(await screen.findByText('Ask a workspace admin to add CRM Suite.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Add /i })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Compare plans' })).toBeNull();
  });

  it('offers NO link and no price when the owning bundle is NOT for sale (DATA-419-2)', async () => {
    // The unpriced shape: listed for sale, but the store says a checkout would not
    // be accepted. Only the `purchasable` field stands between it and a CTA.
    purchasable = false;
    view();
    // Wait for the RESOLVED state, then assert the absence — not the other way round
    // (an absence is already true while the card is busy).
    await screen.findByText(/CRM Suite is not available to buy right now/);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/\$29/)).toBeNull();
  });

  it('a feature in NO bundle keeps the generic locked copy', async () => {
    view('chat');
    await waitFor(() => expect(screen.getByText(/administrator/i)).toBeTruthy());
    expect(screen.getByText('This feature needs an upgrade')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('fails HONEST when the store cannot be read — no dead-end CTA', async () => {
    // Leg 1 — the STORE read fails, the catalog does not: the bundle is named, but
    // nothing is offered for sale.
    storeThrows = true;
    view();
    await screen.findByText(/CRM Suite is not available to buy right now/);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/\$29/)).toBeNull();
    // Leg 2 — the CATALOG read fails too: the generic copy, still no link.
    cleanup();
    __resetLockedUpsellCacheForTest();
    clientThrows = true;
    view();
    await waitFor(() => expect(screen.getByText(/administrator/i)).toBeTruthy());
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows a BUSY card while resolving — no premature copy or CTA to swap', () => {
    resolveNever = true;
    view();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('several locked panels read each endpoint ONCE', async () => {
    render(<MemoryRouter><LockedState featureId="crm" /><LockedState featureId="okrs" /><LockedState featureId="crm" /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Add Planning & Strategy · $19/mo' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Add CRM Suite · $29/mo' })).toHaveLength(2);
    expect(calls).toEqual({ catalog: 1, store: 1, pricing: 1 });
  });

  it('UI-ENT-1: reports ONE locked_view once buyability is known, naming the bundle', async () => {
    forSale = false;
    view();
    await screen.findByText(/not available to buy/);
    const views = events.filter((e) => e.name === 'app.entitlement.locked_view');
    expect(views).toHaveLength(1);
    expect(views[0]?.ctx).toEqual({ feature: 'crm', buyable: false, bundle: 'crm' });
  });

  it('UI-ENT-1: does not report a view while still resolving (buyable would be a guess)', () => {
    resolveNever = true;
    view();
    expect(events.filter((e) => e.name === 'app.entitlement.locked_view')).toHaveLength(0);
  });

  it('UI-ENT-1: reports upsell_click with the bundle when the CTA is followed', async () => {
    view();
    fireEvent.click(await screen.findByRole('link', { name: /^Add CRM Suite/ }));
    expect(events.filter((e) => e.name === 'app.entitlement.upsell_click')).toEqual([
      { name: 'app.entitlement.upsell_click', ctx: { feature: 'crm', bundle: 'crm', target: 'bundle' } },
    ]);
  });
});
