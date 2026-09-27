/**
 * ADR 0419 — LockedState: the "this feature needs an upgrade" panel.
 *
 * The CTA is CONDITIONAL. ADR 0419 §Operator note (DATA-419-2): a gated feature
 * whose bundle carries no configured price is a permanent 403 with no store path —
 * sending the user to a store with nothing to sell would be a fabricated affordance.
 * So the "go to the feature store" button renders ONLY once we KNOW the owning
 * bundle is for sale; while resolving it shows a busy card (no premature copy/CTA to
 * swap); on any store-read error it fails honest (no CTA).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let forSale = true;
let clientThrows = false;
let resolveNever = false;
vi.mock('../../features/marketplace/marketplaceClient.js', () => ({
  fetchFeatureBundles: async () => {
    if (resolveNever) return new Promise(() => {}); // never settles → the resolving state
    if (clientThrows) throw new Error('offline');
    return {
      available: true,
      bundles: [{ id: 'crm', label: 'CRM', features: [{ id: 'crm', registered: true, dependsOn: [] }] }],
      standalone: [],
      core: [],
    };
  },
  fetchBundleCommerce: async () => {
    if (clientThrows) throw new Error('offline');
    return [{ bundleId: 'crm', forSale, owned: false }];
  },
}));

const events: Array<{ name: string; ctx?: Record<string, unknown> }> = [];
vi.mock('../../platform/telemetry.js', () => ({
  telemetry: { reportEvent: (name: string, ctx?: Record<string, unknown>) => { events.push({ name, ctx }); }, reportError() {}, reportMetric() {} },
}));

import { LockedState } from '../LockedState.js';

const view = () => render(<MemoryRouter><LockedState featureId="crm" /></MemoryRouter>);
beforeEach(() => { forSale = true; clientThrows = false; resolveNever = false; events.length = 0; });
afterEach(cleanup);

describe('LockedState (ADR 0419)', () => {
  it('offers the feature-store link when the owning bundle is for sale', async () => {
    view();
    const link = await screen.findByRole('link', { name: /feature store/i });
    expect(link.getAttribute('href')).toBe('/marketplace/bundles');
  });

  it('offers NO link when the owning bundle is NOT for sale (DATA-419-2)', async () => {
    forSale = false;
    view();
    // Wait for the RESOLVED state, then assert the absence — not the other way round.
    //
    // This previously awaited the ABSENCE of the store link, which is already true
    // while the card is still busy (no link is rendered then either). A `waitFor`
    // on an already-satisfied condition returns on the first tick and provides NO
    // synchronisation, so the assertion below raced the async bundle resolution and
    // ran against the busy card — failing intermittently under load with
    // `aria-busy="true"` in the DOM. Diagnosed as environmental flake; it was a
    // race the test creates itself.
    await waitFor(() => expect(screen.getByText(/administrator/i)).toBeTruthy());
    // The panel still explains WHY the page is empty — it just cannot offer a store.
    expect(screen.queryByRole('link', { name: /feature store/i })).toBeNull();
  });

  it('fails HONEST when the store cannot be read — no dead-end CTA', async () => {
    clientThrows = true;
    view();
    await waitFor(() => expect(screen.getByText(/administrator/i)).toBeTruthy());
    expect(screen.queryByRole('link', { name: /feature store/i })).toBeNull();
  });

  it('shows a BUSY card while resolving — no premature copy or CTA to swap', () => {
    resolveNever = true;
    view();
    // aria-busy region, no link, no committed body — settles once, never flips.
    const card = document.querySelector('[aria-busy="true"]');
    expect(card).toBeTruthy();
    expect(screen.queryByRole('link', { name: /feature store/i })).toBeNull();
  });

  it('UI-ENT-1: reports ONE locked_view once buyability is known, with an honest buyable flag', async () => {
    forSale = false;
    view();
    await screen.findByText(/administrator/i);
    const views = events.filter((e) => e.name === 'app.entitlement.locked_view');
    expect(views).toHaveLength(1);
    expect(views[0].ctx).toMatchObject({ feature: 'crm', buyable: false });
  });

  it('UI-ENT-1: does not report a view while still resolving (buyable would be a guess)', () => {
    resolveNever = true;
    view();
    expect(events.filter((e) => e.name === 'app.entitlement.locked_view')).toHaveLength(0);
  });

  it('UI-ENT-1: reports upsell_click when the store CTA is followed', async () => {
    view();
    fireEvent.click(await screen.findByRole('link', { name: /feature store/i }));
    expect(events.some((e) => e.name === 'app.entitlement.upsell_click' && e.ctx?.feature === 'crm')).toBe(true);
  });
});
