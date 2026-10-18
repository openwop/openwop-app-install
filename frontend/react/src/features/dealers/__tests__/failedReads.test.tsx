/**
 * UX_UPGRADE-dealers — DLR-G1 / DLR-G2 / DLR-G3.
 *
 * Three reads on this feature swallowed their failure into an empty value, so
 * "there are none" and "we could not load them" rendered identically. The worst
 * was the companies read: an empty list drives the select's "create a company
 * first" option, so a failed read actively instructed the operator to create
 * something that may already exist — and disabled the control that would have
 * shown it.
 *
 * Sabotage-witnessed (w52 /grade-tests, w52g2-fr-*): each catch reporting
 * success (companies, outlets, registrations), the company select falling back
 * to "create a company first", the outlets Retry wired to a no-op, and the
 * outlet detail dropping the "name could not be loaded" label, the id fallback,
 * or the dealer link each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Dealer, Outlet, Company } from '../dealersClient.js';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

type DealersApi = typeof import('../dealersClient.js');
const listDealers = vi.fn<DealersApi['listDealers']>();
const listCompanies = vi.fn<DealersApi['listCompanies']>();
const listOutlets = vi.fn<DealersApi['listOutlets']>();
const listRegistrations = vi.fn<DealersApi['listRegistrations']>();
const getOutlet = vi.fn<DealersApi['getOutlet']>();
const getDealer = vi.fn<DealersApi['getDealer']>();

// The real module, spread; only the reads are replaced. Arguments are passed
// through so a case can check WHICH org/dealer a read was for.
vi.mock('../dealersClient.js', async (orig) => ({
  ...(await orig<DealersApi>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listDealers: (orgId: string) => listDealers(orgId),
  listCompanies: (orgId: string) => listCompanies(orgId),
  listOutlets: (orgId: string, dealerId: string) => listOutlets(orgId, dealerId),
  listRegistrations: (orgId: string, dealerId?: string) => listRegistrations(orgId, dealerId),
  getOutlet: (orgId: string, outletId: string) => getOutlet(orgId, outletId),
  getDealer: (orgId: string, dealerId: string) => getDealer(orgId, dealerId),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { DealersPage } from '../DealersPage.js';
import { OutletDetailPage } from '../OutletDetailPage.js';

// Complete fixtures, no cast. The `as Dealer` escape hid that these were missing
// required fields AND carried an `orgId` the type does not have — so the fixture
// did not describe what the client actually returns.
const DEALER: Dealer = {
  dealerId: 'd1', companyId: 'c1', name: 'North Motors', tier: 'gold',
  status: 'active', updatedAt: '2026-07-01T00:00:00.000Z',
};
const OUTLET: Outlet = { outletId: 'o1', dealerId: 'd1', name: 'North Depot', status: 'active' };

const dealersView = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/dealers?org=org-1&dealer=d1']}><DealersPage /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(listDealers).toHaveBeenCalled());
};

const outletView = async (): Promise<void> => {
  render(
    <MemoryRouter initialEntries={['/dealers/outlets/o1?org=org-1']}>
      <Routes><Route path="/dealers/outlets/:outletId" element={<OutletDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await waitFor(() => expect(screen.getByText('North Depot')).toBeTruthy());
};

beforeEach(() => {
  for (const m of [listDealers, listCompanies, listOutlets, listRegistrations, getOutlet, getDealer]) m.mockReset();
  listDealers.mockResolvedValue([DEALER]);
  const company: Company = { companyId: 'c1', name: 'Acme Corp', tags: [] };
  listCompanies.mockResolvedValue([company]);
  listOutlets.mockResolvedValue([]);
  listRegistrations.mockResolvedValue([]);
  getOutlet.mockResolvedValue(OUTLET);
  getDealer.mockResolvedValue(DEALER);
});
afterEach(cleanup);

describe('DLR-G2: a failed companies read must not tell you to create one', () => {
  it('says the list could not be loaded, instead of "create a company first"', async () => {
    listCompanies.mockRejectedValue(new Error('companies store down'));
    await dealersView();
    expect(await screen.findByText(/companies could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/create a company in CRM first/i)).toBeNull();
  });

  it('a genuinely empty company list still nudges you to create one', async () => {
    listCompanies.mockResolvedValue([]);
    await dealersView();
    // The nudge is CORRECT here — the distinction is the whole point.
    expect(await screen.findByText(/create a company in CRM first/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});

describe('DLR-G1: failed outlet/registration reads are not "none yet"', () => {
  it('a failed outlets read says so, with a retry', async () => {
    listOutlets.mockRejectedValueOnce(new Error('outlets down')).mockResolvedValue([OUTLET]);
    await dealersView();
    expect(await screen.findByText(/outlets could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no outlets yet/i)).toBeNull();
    expect(listOutlets).toHaveBeenCalledWith('org-1', 'd1');
    // "With a retry" — and the retry WORKS: the click re-runs the read and the
    // real list replaces the warning (w52: presence-only was probe-vacuous).
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('North Depot')).toBeTruthy();
    expect(screen.queryByText(/outlets could not be loaded/i)).toBeNull();
    expect(listOutlets).toHaveBeenCalledTimes(2);
  });

  it('a failed registrations read says so', async () => {
    listRegistrations.mockRejectedValue(new Error('regs down'));
    await dealersView();
    expect(await screen.findByText(/deal registrations could not be loaded/i)).toBeTruthy();
    // ...and NOT also the empty-state sentence (failure presented as "none").
    expect(screen.queryByText('No registrations from this dealer yet.')).toBeNull();
  });

  it('a genuinely empty dealer still reads as empty, not as an error', async () => {
    await dealersView();
    expect(await screen.findByText(/no outlets yet/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});

describe('DLR-G3: the outlet detail says when the dealer name is missing', () => {
  it('a failed dealer lookup is labelled, not silently an id', async () => {
    getDealer.mockRejectedValue(new Error('dealer down'));
    await outletView();
    expect(await screen.findByText("(the dealer's name could not be loaded)")).toBeTruthy();
    // The id is still shown — it is the only handle the reader has.
    expect(screen.getByText('d1')).toBeTruthy();
  });

  it('a successful lookup links the dealer and says nothing about failure', async () => {
    await outletView();
    expect(screen.getByRole('link', { name: 'North Motors' })).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});
