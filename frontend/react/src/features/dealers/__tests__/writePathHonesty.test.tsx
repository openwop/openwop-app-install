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
 *
 * Sabotage-witnessed (w52 /grade-tests, w52g2-wp-*): reactivate/suspend sending the
 * wrong status, create dropping lat/lng, the half-location guard removed (create form
 * and outlet detail), the range guard removed (create form; no case here covers the
 * outlet-detail range guard), the no-coords create blocked, the outlet save
 * dropping the coordinates or the prefill, the queue-failed chip falling back to
 * "Awaiting review", and the dealers read failure shown as an empty directory or
 * without a working Retry. Writes are asserted as the FULL call (org, target,
 * body) — a toast is not the write.
 *
 * ADR 1034 D9 (re-probed wave 115): suspending confirms first. The confirm dropped,
 * its `danger` flag dropped, or its answer ignored each turn a D9 case red. Wave 115
 * also re-probed every claim above at HEAD, and made the no-coords body strict, the
 * queue-failed chip and the dealers-failed card value checks after a settle (they
 * used to red only by a `findBy` timing out), and the failed card's "no dealers yet"
 * absence explicit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Dealer, Outlet, Company, DealRegistration } from '../dealersClient.js';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

type DealersApi = typeof import('../dealersClient.js');
const getOutlet = vi.fn<DealersApi['getOutlet']>();
const getDealer = vi.fn<DealersApi['getDealer']>();
const updateOutlet = vi.fn<DealersApi['updateOutlet']>();
const listDealers = vi.fn<DealersApi['listDealers']>();
const listCompanies = vi.fn<DealersApi['listCompanies']>();
const listOutlets = vi.fn<DealersApi['listOutlets']>();
const listRegistrations = vi.fn<DealersApi['listRegistrations']>();
const createOutlet = vi.fn<DealersApi['createOutlet']>();
const updateDealer = vi.fn<DealersApi['updateDealer']>();

vi.mock('../dealersClient.js', async (orig) => ({
  ...(await orig<DealersApi>()),
  listOrgs: vi.fn<DealersApi['listOrgs']>(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listDealers: (orgId: string) => listDealers(orgId),
  listCompanies: (orgId: string) => listCompanies(orgId),
  listOutlets: (orgId: string, dealerId: string) => listOutlets(orgId, dealerId),
  listRegistrations: (orgId: string, dealerId?: string) => listRegistrations(orgId, dealerId),
  createOutlet: (...a: Parameters<DealersApi['createOutlet']>) => createOutlet(...a),
  updateDealer: (...a: Parameters<DealersApi['updateDealer']>) => updateDealer(...a),
  updateOutlet: (...a: Parameters<DealersApi['updateOutlet']>) => updateOutlet(...a),
  getOutlet: (orgId: string, outletId: string) => getOutlet(orgId, outletId),
  getDealer: (orgId: string, dealerId: string) => getDealer(orgId, dealerId),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// ADR 1034 D9 — suspending now confirms first (it kills the partner's link).
type ConfirmApi = typeof import('../../../ui/confirm.js');
const confirmMock = vi.fn<ConfirmApi['confirm']>();
vi.mock('../../../ui/confirm.js', async (orig) => ({
  ...(await orig<ConfirmApi>()),
  confirm: (o: Parameters<ConfirmApi['confirm']>[0]) => confirmMock(o),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { DealersPage } from '../DealersPage.js';
import { OutletDetailPage } from '../OutletDetailPage.js';

const DEALER: Dealer = {
  dealerId: 'd1', companyId: 'c1', name: 'North Motors', tier: 'gold',
  status: 'active', updatedAt: '2026-07-01T00:00:00.000Z',
};
const OUTLET: Outlet = { outletId: 'o1', dealerId: 'd1', name: 'North Depot', status: 'active' };
const COMPANY: Company = { companyId: 'c1', name: 'Acme Corp', tags: [] };
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
  getOutlet.mockResolvedValue(OUTLET);
  getDealer.mockResolvedValue(DEALER);
  updateOutlet.mockResolvedValue({ ...OUTLET, lat: 51.5074, lng: -0.1278 });
  listDealers.mockResolvedValue([DEALER]);
  listCompanies.mockResolvedValue([COMPANY]);
  listOutlets.mockResolvedValue([]);
  listRegistrations.mockResolvedValue([]);
  createOutlet.mockResolvedValue({ ...OUTLET, outletId: 'o2', name: 'Store A' });
  updateDealer.mockResolvedValue(DEALER);
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
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
    expect(updateDealer.mock.calls[0]).toEqual(['org-1', 'd1', { status: 'suspended' }]);
    // ADR 1034 D9 — it said, before doing it, that the partner's link stops working.
    expect(confirmMock.mock.calls[0]?.[0]).toMatchObject({ danger: true, body: expect.stringMatching(/partner link stops working/) });
  });

  it('declining the suspend confirm suspends nothing (ADR 1034 D9)', async () => {
    confirmMock.mockResolvedValue(false);
    await view();
    fireEvent.click(screen.getByRole('button', { name: /suspend/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await act(async () => {});
    expect(updateDealer).not.toHaveBeenCalled();
  });
});

describe('DLR2-B5 — an outlet that can never be plotted', () => {
  it('sends the coordinates the form now captures', async () => {
    await view();
    fireEvent.change(screen.getByLabelText(/outlet name/i), { target: { value: 'Store A' } });
    fireEvent.change(screen.getByLabelText(/latitude/i), { target: { value: '51.5074' } });
    fireEvent.change(screen.getByLabelText(/longitude/i), { target: { value: '-0.1278' } });
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!); });
    // The backend has accepted lat/lng on create since P1; the form never sent them,
    // and no other surface produces a coordinate — so every real tenant's sales map
    // was empty and its "N outlets are not on the map" line read "all of them".
    expect(createOutlet.mock.calls).toStrictEqual([['org-1', 'd1', { name: 'Store A', lat: 51.5074, lng: -0.1278 }]]);
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
    expect(screen.queryAllByText(/between -90 and 90/i)).toHaveLength(1);
  });

  it('an outlet with NO coordinates still saves (the negative control)', async () => {
    await view();
    fireEvent.change(screen.getByLabelText(/outlet name/i), { target: { value: 'Store D' } });
    // Clicked and settled, then the exact call list: a blocked create fails on the
    // value (no call), not on a wait timing out.
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!); });
    // Exact body: no lat/lng keys at all (not `null`, not `NaN`, and not present as
    // `undefined` either — `toEqual` ignores undefined-valued keys, so it is strict).
    expect(createOutlet.mock.calls).toStrictEqual([['org-1', 'd1', { name: 'Store D' }]]);
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
    expect(updateOutlet.mock.calls[0]).toEqual(['org-1', 'o1', { lat: 51.5074, lng: -0.1278 }]);
  });

  it('prefills from the row, so saving is an edit and not a silent blanking', async () => {
    getOutlet.mockResolvedValue({ ...OUTLET, lat: 10, lng: 20 });
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
    // Settle on the registrations read for THIS dealer, then assert the values: the
    // wrong chip fails here on what rendered, not by a `findBy` running out of time.
    await waitFor(() => expect(listRegistrations).toHaveBeenCalledWith('org-1', 'd1'));
    await act(async () => {});
    expect(screen.queryByText(/awaiting review/i)).toBeNull();
    expect(screen.getByText(/not sent for review/i)).toBeTruthy();
  });

  it('a queued registration still reads as awaiting review (the negative control)', async () => {
    listRegistrations.mockResolvedValue([REG]);
    await view();
    // Settle on this dealer's registrations read, then count: a missing healthy chip
    // fails on the value, not on a lookup throw.
    await waitFor(() => expect(listRegistrations).toHaveBeenCalledWith('org-1', 'd1'));
    await act(async () => {});
    expect(screen.queryByText(/not sent for review/i)).toBeNull();
    // Review I4 — MEASURED vacuous: deleting the healthy chip entirely left 10/10 green,
    // because both cases asserted only the ABSENCE of the failure copy. An "X is absent"
    // assertion means nothing unless the same helper asserts X's presence somewhere.
    expect(screen.queryAllByText(/awaiting review/i)).toHaveLength(1);
  });
});

describe('DLR2-M2 — a failed dealers read shimmered forever', () => {
  it('offers a retry instead of a permanent skeleton', async () => {
    listDealers.mockRejectedValue(new Error('dealers store down'));
    await view();
    // NOT `[]` — that is the failure-as-empty defect round 1 closed one level down.
    // This is the read those two hang off, and it got neither treatment nor a retry.
    await act(async () => {});
    expect(document.body.textContent).toContain('We could not load your dealers');
    expect(screen.queryByText(/no dealers yet/i)).toBeNull();
    const retry = screen.getAllByRole('button', { name: /retry/i })[0]!;
    await act(async () => { fireEvent.click(retry); });
    // Asserted after the click settles, as the exact call list: a Retry wired to
    // nothing fails on the value, not on a wait timing out.
    expect(listDealers.mock.calls).toEqual([['org-1'], ['org-1']]);
  });

  it('an empty directory is still an empty directory (the negative control)', async () => {
    listDealers.mockResolvedValue([]);
    await view();
    await act(async () => {});
    expect(screen.queryByText(/could not load your dealers/i)).toBeNull();
    expect(screen.queryAllByText(/no dealers yet/i)).toHaveLength(1);   // see the note above
  });
});
