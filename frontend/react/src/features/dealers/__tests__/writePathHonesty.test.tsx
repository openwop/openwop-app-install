/**
 * UX_UPGRADE-dealers ROUND 2 — the write path, which round 1 never reached.
 *
 * Round 1 fixed three READS that rendered their failure as data. Everything below is
 * the other half of the same feature:
 *
 *  - DLR2-B4  nothing about a dealer was editable, so a "reversible" suspension had
 *             no reversal anywhere in the product
 *  - DLR2-B5  the outlet form captured no coordinates, and nothing else in the
 *             product produces one — so the sales map plots nothing, forever
 *  - DLR2-B2  a registration whose review card never landed read "Awaiting review"
 *  - DLR2-M2  a failed DEALERS read left a skeleton shimmering with no retry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Dealer, Outlet, Company, DealRegistration } from '../dealersClient.js';

const getOutlet = vi.fn();
const getDealer = vi.fn();
const updateOutlet = vi.fn();
const listDealers = vi.fn();
const listCompanies = vi.fn();
const listOutlets = vi.fn();
const listRegistrations = vi.fn();
const createOutlet = vi.fn();
const updateDealer = vi.fn();

vi.mock('../dealersClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listDealers: () => listDealers(),
  listCompanies: () => listCompanies(),
  listOutlets: () => listOutlets(),
  listRegistrations: () => listRegistrations(),
  createOutlet: (...a: unknown[]) => createOutlet(...a),
  updateDealer: (...a: unknown[]) => updateDealer(...a),
  updateOutlet: (...a: unknown[]) => updateOutlet(...a),
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

const DEALER: Dealer = {
  dealerId: 'd1', companyId: 'c1', name: 'North Motors', tier: 'gold',
  status: 'active', updatedAt: '2026-07-01T00:00:00.000Z',
};
const REG: DealRegistration = {
  regId: 'r1', dealerId: 'd1', dealTitle: 'Q4 fleet', companyName: 'Globex',
  status: 'pending', at: '2026-08-01T00:00:00.000Z',
};

const view = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/dealers?org=org-1&dealer=d1']}><DealersPage /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(listDealers).toHaveBeenCalled());
};

beforeEach(() => {
  for (const m of [listDealers, listCompanies, listOutlets, listRegistrations, createOutlet, updateDealer, updateOutlet, getOutlet, getDealer]) m.mockReset();
  getOutlet.mockResolvedValue({ outletId: 'o1', dealerId: 'd1', name: 'North Depot', status: 'active' } as Outlet);
  getDealer.mockResolvedValue(DEALER);
  updateOutlet.mockResolvedValue({});
  listDealers.mockResolvedValue([DEALER]);
  listCompanies.mockResolvedValue([{ companyId: 'c1', name: 'Acme Corp' } as Company]);
  listOutlets.mockResolvedValue([] as Outlet[]);
  listRegistrations.mockResolvedValue([]);
  createOutlet.mockResolvedValue({});
  updateDealer.mockResolvedValue(DEALER);
});
afterEach(cleanup);

describe('DLR2-M4 — a suspension documented as reversible needs a reversal', () => {
  it('a suspended dealer can be reactivated from the console', async () => {
    listDealers.mockResolvedValue([{ ...DEALER, status: 'suspended' }]);
    await view();
    // `suspendDealersForCompany` calls itself "non-destructive + REVERSIBLE", the PATCH
    // route and service have existed since P1 — and the client exposed no update
    // function and the page rendered no control, so the only escape from a suspension
    // was Delete + recreate, cascading the outlets, registrations and partner link.
    fireEvent.click(screen.getByRole('button', { name: /reactivate/i }));
    await waitFor(() => expect(updateDealer).toHaveBeenCalled());
    expect(updateDealer.mock.calls[0]).toEqual(['org-1', 'd1', { status: 'active' }]);
  });

  it('an active dealer offers suspend, not reactivate (the negative control)', async () => {
    await view();
    expect(screen.queryByRole('button', { name: /reactivate/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /suspend/i }));
    await waitFor(() => expect(updateDealer).toHaveBeenCalled());
    expect(updateDealer.mock.calls[0]![2]).toEqual({ status: 'suspended' });
  });
});

describe('DLR2-B5 — an outlet that can never be plotted', () => {
  it('sends the coordinates the form now captures', async () => {
    await view();
    fireEvent.change(screen.getByLabelText(/outlet name/i), { target: { value: 'Store A' } });
    fireEvent.change(screen.getByLabelText(/latitude/i), { target: { value: '51.5074' } });
    fireEvent.change(screen.getByLabelText(/longitude/i), { target: { value: '-0.1278' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);
    await waitFor(() => expect(createOutlet).toHaveBeenCalled());
    // The backend has accepted lat/lng on create since P1; the form never sent them,
    // and no other surface produces a coordinate — so every real tenant's sales map
    // was empty and its "N outlets are not on the map" line read "all of them".
    expect(createOutlet.mock.calls[0]![2]).toMatchObject({ name: 'Store A', lat: 51.5074, lng: -0.1278 });
  });

  it('refuses HALF a location — one coordinate is not a place', async () => {
    await view();
    fireEvent.change(screen.getByLabelText(/outlet name/i), { target: { value: 'Store B' } });
    fireEvent.change(screen.getByLabelText(/latitude/i), { target: { value: '51.5074' } });
    const add = screen.getAllByRole('button', { name: /^add$/i })[0] as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  it('refuses an out-of-range coordinate, and says which', async () => {
    await view();
    fireEvent.change(screen.getByLabelText(/outlet name/i), { target: { value: 'Store C' } });
    fireEvent.change(screen.getByLabelText(/latitude/i), { target: { value: '999' } });
    fireEvent.change(screen.getByLabelText(/longitude/i), { target: { value: '0' } });
    expect((screen.getAllByRole('button', { name: /^add$/i })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/between -90 and 90/i)).toBeTruthy();
  });

  it('an outlet with NO coordinates still saves (the negative control)', async () => {
    await view();
    fireEvent.change(screen.getByLabelText(/outlet name/i), { target: { value: 'Store D' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);
    await waitFor(() => expect(createOutlet).toHaveBeenCalled());
    expect(createOutlet.mock.calls[0]![2]).not.toHaveProperty('lat');
  });
});

describe('review fold-in B3 — the capture never reached an EXISTING outlet', () => {
  const outletView = async (): Promise<void> => {
    render(
      <MemoryRouter initialEntries={['/dealers/outlets/o1?org=org-1']}>
        <Routes><Route path="/dealers/outlets/:outletId" element={<OutletDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    await waitFor(() => expect(getOutlet).toHaveBeenCalled());
  };

  it('an outlet with no coordinates can be given them here', async () => {
    // The fix shipped on the CREATE form only, and the population it exists for is the
    // outlets that already exist — an operator reading "50 outlets are not on the map"
    // had nowhere to type them.
    await outletView();
    expect(screen.getByText(/not on the map/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/latitude/i), { target: { value: '51.5074' } });
    fireEvent.change(screen.getByLabelText(/longitude/i), { target: { value: '-0.1278' } });
    fireEvent.click(screen.getByRole('button', { name: /save coordinates/i }));
    await waitFor(() => expect(updateOutlet).toHaveBeenCalled());
    expect(updateOutlet.mock.calls[0]![2]).toEqual({ lat: 51.5074, lng: -0.1278 });
  });

  it('prefills from the row, so saving is an edit and not a silent blanking', async () => {
    getOutlet.mockResolvedValue({ outletId: 'o1', dealerId: 'd1', name: 'North Depot', status: 'active', lat: 10, lng: 20 } as Outlet);
    await outletView();
    expect((screen.getByLabelText(/latitude/i) as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText(/longitude/i) as HTMLInputElement).value).toBe('20');
  });

  it('refuses half a location here too', async () => {
    await outletView();
    fireEvent.change(screen.getByLabelText(/latitude/i), { target: { value: '51.5' } });
    expect((screen.getByRole('button', { name: /save coordinates/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DLR2-B2 — "Awaiting review" was a guess that read as a fact', () => {
  it('a registration whose review card never landed says so', async () => {
    listRegistrations.mockResolvedValue([{ ...REG, queueFailed: true }]);
    await view();
    // The chip was derived from `status`, which is `pending` whether or not anybody was
    // ever asked to decide — and the review card is the ONLY decision path, so a lost
    // one means the deal is never decided while every surface says it is waiting.
    expect(await screen.findByText(/not sent for review/i)).toBeTruthy();
    expect(screen.queryByText(/awaiting review/i)).toBeNull();
  });

  it('a queued registration still reads as awaiting review (the negative control)', async () => {
    listRegistrations.mockResolvedValue([REG]);
    await view();
    expect(screen.queryByText(/not sent for review/i)).toBeNull();
    // Review I4 — MEASURED vacuous: deleting the healthy chip entirely left 10/10 green,
    // because both cases asserted only the ABSENCE of the failure copy. An "X is absent"
    // assertion means nothing unless the same helper asserts X's presence somewhere.
    expect(screen.getByText(/awaiting review/i)).toBeTruthy();
  });
});

describe('DLR2-M2 — a failed dealers read shimmered forever', () => {
  it('offers a retry instead of a permanent skeleton', async () => {
    listDealers.mockRejectedValue(new Error('dealers store down'));
    await view();
    // NOT `[]` — that is the failure-as-empty defect round 1 closed one level down.
    // This is the read those two hang off, and it got neither treatment nor a retry.
    expect(await screen.findByText(/could not load your dealers/i)).toBeTruthy();
    const retry = screen.getAllByRole('button', { name: /retry/i })[0]!;
    fireEvent.click(retry);
    await waitFor(() => expect(listDealers.mock.calls.length).toBeGreaterThan(1));
  });

  it('an empty directory is still an empty directory (the negative control)', async () => {
    listDealers.mockResolvedValue([]);
    await view();
    expect(screen.queryByText(/could not load your dealers/i)).toBeNull();
    expect(screen.getByText(/no dealers yet/i)).toBeTruthy();   // see the note above
  });
});
