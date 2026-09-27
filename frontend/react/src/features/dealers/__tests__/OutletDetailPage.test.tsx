/**
 * OutletDetailPage (ADR 0281 P6 / the sales-map pin deep-link target) — pins the
 * ADR 0336 deep-link contract: the fetch is keyed on the DERIVED (orgId,
 * outletId), a missing `?org=` fails closed to not-found WITHOUT a fetch, a 404
 * renders not-found (no existence leak), the feature gate blocks the fetch, and
 * the owning-dealer link carries org + dealer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { getOutlet, getDealer, DealersApiError } = vi.hoisted(() => {
  class DealersApiError extends Error {
    status: number;
    constructor(status: number) { super(`http ${status}`); this.status = status; }
  }
  return { getOutlet: vi.fn(), getDealer: vi.fn(), DealersApiError };
});
vi.mock('../dealersClient.js', () => ({ getOutlet, getDealer, DealersApiError }));
const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => access.value }));

import { OutletDetailPage } from '../OutletDetailPage.js';

const anOutlet = { outletId: 'out_1', dealerId: 'dlr_1', name: 'Downtown Store', address: '1 Main St', lat: 34.05, lng: -118.24, status: 'active' as const };
const aDealer = { dealerId: 'dlr_1', companyId: 'co_1', name: 'West Dealer', tier: 'Gold', status: 'active' as const, updatedAt: '2026-07-12' };

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
  access.value = { enabled: true, loading: false, variant: undefined };
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
    getOutlet.mockRejectedValue(new DealersApiError(404));
    renderAt('/dealers/outlets/out_x?org=org_9');
    expect(await screen.findByText('Outlet not found')).toBeTruthy();
  });

  it('a non-404 failure renders the retryable error state', async () => {
    getOutlet.mockRejectedValue(new DealersApiError(500));
    renderAt('/dealers/outlets/out_1?org=org_9');
    expect(await screen.findByText('Could not load the outlet')).toBeTruthy();
  });

  it('a disabled feature gate blocks the fetch and shows the not-enabled state', async () => {
    access.value = { enabled: false, loading: false, variant: undefined };
    renderAt('/dealers/outlets/out_1?org=org_9');
    expect(await screen.findByText('Dealers is not enabled')).toBeTruthy();
    expect(getOutlet).not.toHaveBeenCalled();
  });

  it('a failed dealer enrichment still renders the outlet (dealer id fallback)', async () => {
    getOutlet.mockResolvedValue(anOutlet);
    getDealer.mockRejectedValue(new DealersApiError(500));
    renderAt('/dealers/outlets/out_1?org=org_9');
    expect(await screen.findByText('Downtown Store')).toBeTruthy();
    expect(await screen.findByText('dlr_1')).toBeTruthy();
  });
});
