/**
 * UX_UPGRADE-dealers — DLR-G1 / DLR-G2 / DLR-G3.
 *
 * Three reads on this feature swallowed their failure into an empty value, so
 * "there are none" and "we could not load them" rendered identically. The worst
 * was the companies read: an empty list drives the select's "create a company
 * first" option, so a failed read actively instructed the operator to create
 * something that may already exist — and disabled the control that would have
 * shown it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Dealer, Outlet, Company } from '../dealersClient.js';

const listDealers = vi.fn();
const listCompanies = vi.fn();
const listOutlets = vi.fn();
const listRegistrations = vi.fn();
const getOutlet = vi.fn();
const getDealer = vi.fn();

vi.mock('../dealersClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listDealers: () => listDealers(),
  listCompanies: () => listCompanies(),
  listOutlets: () => listOutlets(),
  listRegistrations: () => listRegistrations(),
  getOutlet: () => getOutlet(),
  getDealer: () => getDealer(),
  createDealer: vi.fn(async () => ({})),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
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
  listCompanies.mockResolvedValue([{ companyId: 'c1', name: 'Acme Corp' } as Company]);
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
    listOutlets.mockRejectedValue(new Error('outlets down'));
    await dealersView();
    expect(await screen.findByText(/outlets could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no outlets yet/i)).toBeNull();
    // The name promised "with a retry" and the body asserted none — a test name
    // that over-promises is the same defect as a checklist row that does, just
    // smaller. `DealersPage.tsx:250` renders it, so assert it rather than
    // renaming the test down to what it happened to cover. (Presence only; that
    // the click re-runs the read is still unasserted.)
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('a failed registrations read says so', async () => {
    listRegistrations.mockRejectedValue(new Error('regs down'));
    await dealersView();
    expect(await screen.findByText(/deal registrations could not be loaded/i)).toBeTruthy();
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
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
    // The id is still shown — it is the only handle the reader has.
    expect(screen.getByText('d1')).toBeTruthy();
  });

  it('a successful lookup links the dealer and says nothing about failure', async () => {
    await outletView();
    expect(screen.getByRole('link', { name: 'North Motors' })).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});
