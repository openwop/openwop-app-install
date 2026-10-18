/**
 * OutletDetailPage (ADR 0281 P6 / the sales-map pin deep-link target) — pins the
 * ADR 0336 deep-link contract: the fetch is keyed on the DERIVED (orgId,
 * outletId), a missing `?org=` fails closed to not-found WITHOUT a fetch, a 404
 * renders not-found (no existence leak), a non-404 failure is a RETRYABLE error,
 * the feature gate blocks the fetch, and the owning-dealer link carries org +
 * dealer.
 *
 * The client module is the REAL one (spread) with only the two reads replaced,
 * and errors are the real `DealersApiError(message, status)` — a hand-rolled
 * error class with a different constructor would let the 404 branch be tested
 * against a type production never throws.
 *
 * Sabotage-witnessed (w52 /grade-tests, w52g2-od-*): the outlet id altered before
 * the fetch, the dealer link dropping `org=`, the missing-org guard removed, the
 * 404 branch keyed on another status, every failure mapped to not-found, Retry
 * wired to a no-op, the gate removed from the load effect, and the dealer-id
 * fallback blanked each turn a case red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { makeFeatureAccess, type FeatureAccessResult } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { DealersApiError, type Dealer, type Outlet } from '../dealersClient.js';

type DealersApi = typeof import('../dealersClient.js');
const { getOutlet, getDealer } = vi.hoisted(() => ({
  getOutlet: vi.fn<DealersApi['getOutlet']>(),
  getDealer: vi.fn<DealersApi['getDealer']>(),
}));
vi.mock('../dealersClient.js', async (orig) => ({ ...(await orig<DealersApi>()), getOutlet, getDealer }));
const access = vi.hoisted(() => ({ value: {} as Partial<FeatureAccessResult> }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess(access.value),
}));

import { OutletDetailPage } from '../OutletDetailPage.js';

const anOutlet: Outlet = { outletId: 'out_1', dealerId: 'dlr_1', name: 'Downtown Store', address: '1 Main St', lat: 34.05, lng: -118.24, status: 'active' };
const aDealer: Dealer = { dealerId: 'dlr_1', companyId: 'co_1', name: 'West Dealer', tier: 'Gold', status: 'active', updatedAt: '2026-07-12T00:00:00.000Z' };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/dealers/outlets/:outletId" element={<OutletDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  getOutlet.mockReset(); getDealer.mockReset();
  access.value = { enabled: true };
  getDealer.mockResolvedValue(aDealer);
});

describe('OutletDetailPage deep-link derivation', () => {
  it('fetches keyed on the derived (orgId, outletId) and renders the outlet + dealer link', async () => {
    getOutlet.mockResolvedValue(anOutlet);
    renderAt('/dealers/outlets/out_1?org=org_9');
    await waitFor(() => expect(getOutlet).toHaveBeenCalledWith('org_9', 'out_1'));
    expect(await screen.findByText('Downtown Store')).toBeTruthy();
    expect(await screen.findByText('1 Main St')).toBeTruthy();
    const dealerLink = (await screen.findByText('West Dealer')).closest('a');
    expect(dealerLink?.getAttribute('href')).toBe('/dealers?org=org_9&dealer=dlr_1');
  });

  it('missing ?org= fails closed to not-found without fetching', async () => {
    renderAt('/dealers/outlets/out_1');
    expect(await screen.findByText('Outlet not found')).toBeTruthy();
    expect(getOutlet).not.toHaveBeenCalled();
  });

  it('a 404 renders not-found (no existence leak)', async () => {
    getOutlet.mockRejectedValue(new DealersApiError('Outlet not found.', 404));
    renderAt('/dealers/outlets/out_x?org=org_9');
    expect(await screen.findByText('Outlet not found')).toBeTruthy();
    // The not-found came from the 404 of a REAL read for this target — not from
    // the missing-org branch — and it is not the retryable error state.
    expect(getOutlet).toHaveBeenCalledWith('org_9', 'out_x');
    expect(screen.queryByText('Could not load the outlet')).toBeNull();
  });

  it('a non-404 failure renders the retryable error state', async () => {
    getOutlet.mockRejectedValueOnce(new DealersApiError('boom', 500)).mockResolvedValue(anOutlet);
    renderAt('/dealers/outlets/out_1?org=org_9');
    expect(await screen.findByText('Could not load the outlet')).toBeTruthy();
    expect(screen.queryByText('Outlet not found')).toBeNull();
    // Retryable: the action re-runs the read and the outlet renders.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Downtown Store')).toBeTruthy();
    expect(getOutlet).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Could not load the outlet')).toBeNull();
  });

  it('a disabled feature gate blocks the fetch and shows the not-enabled state', async () => {
    access.value = { enabled: false };
    renderAt('/dealers/outlets/out_1?org=org_9');
    expect(await screen.findByText('Dealers is not enabled')).toBeTruthy();
    expect(getOutlet).not.toHaveBeenCalled();
  });

  // TWIN: `failedReads.test.tsx` › "a failed dealer lookup is labelled, not
  // silently an id" fails under the same sabotage (blank fallback; w52g2-od-fallback
  // and w52g2-fr-dealer-fallback both red). Kept here as the deep-link page's
  // own "enrichment never blocks the outlet" claim (protected file).
  it('a failed dealer enrichment still renders the outlet (dealer id fallback)', async () => {
    getOutlet.mockResolvedValue(anOutlet);
    getDealer.mockRejectedValue(new DealersApiError('boom', 500));
    renderAt('/dealers/outlets/out_1?org=org_9');
    expect(await screen.findByText('Downtown Store')).toBeTruthy();
    expect(await screen.findByText('dlr_1')).toBeTruthy();
    expect(getDealer).toHaveBeenCalledWith('org_9', 'dlr_1');
  });
});
