/**
 * ADR 0877 D6 — the owner is told which lane the store's checkout settles on.
 * A store that has not connected Stripe takes DEMO orders on a live host; without
 * this notice its owner sees orders that will never be paid and no reason why.
 *
 * ADR 0948 P0b — a CLIENT org onboards its OWN seller from this notice: its owner
 * gets a setup button (never the agency's Commerce Connect link, which would
 * onboard the agency), anyone else is told who can act, and the return from
 * Stripe syncs the seller and re-reads the notice.
 *
 * "A second click starts nothing" is a DOUBLE guard: `Button loading` disables
 * the button AND `start()` returns while busy. A probe on either alone reads
 * vacuous; `w112g4-pn-busyboth` breaks both in one edit while keeping
 * `aria-busy` (so the call count, not the busy flag, is what reds).
 *
 * Each notice case waits for the notice's own title, then asserts synchronously,
 * so a wrong branch fails on its value rather than by a find timing out.
 * Sabotage-witnessed (waves 33/57 `pn-*`, wave 112 `w112g4-pn-*`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as CC from '../commerceClient.js';
import type { PaymentsReadiness } from '../commerceClient.js';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(), listProductsPage: vi.fn(), listOrdersPage: vi.fn(),
  listQuotes: vi.fn(), listProductFields: vi.fn(), listPriceLists: vi.fn(),
  listCoupons: vi.fn(),
  // The claim's own seams are typed against the real client.
  getPaymentsReadiness: vi.fn<typeof CC.getPaymentsReadiness>(),
  startClientPayments: vi.fn<typeof CC.startClientPayments>(),
  syncClientPayments: vi.fn<typeof CC.syncClientPayments>(),
}));
const toastApi = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../../../ui/toast.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, toast: { ...(actual.toast as object), ...toastApi } };
});
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../commerceClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, useFeatureAccess: access.useFeatureAccess };
});

import { CommercePage } from '../CommercePage.js';

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  api.listProductsPage.mockResolvedValue({ products: [] });
  api.listOrdersPage.mockResolvedValue({ orders: [] });
  api.listQuotes.mockResolvedValue([]);
  api.listProductFields.mockResolvedValue([]);
  api.listPriceLists.mockResolvedValue([]);
  api.listCoupons.mockResolvedValue([]);
});
afterEach(cleanup);

const renderPage = (url = '/commerce'): void => { render(<MemoryRouter initialEntries={[url]}><CommercePage /></MemoryRouter>); };
const CLIENT_OWNER: PaymentsReadiness = { settlement: 'demo', reason: 'client_seller_required', connectAvailable: true, clientOrg: true, canOnboardClient: true };
/** The demo notice has rendered (its title), so later reads are of a settled
 *  branch; returns the notice body that holds its sentence, link or button. */
const demoNotice = async (): Promise<HTMLElement> => {
  const body = (await screen.findByText('Demo checkout only.')).parentElement;
  if (!body) throw new Error('demo notice title has no container');
  return body;
};

describe('ADR 0877 D6 — payments readiness notice', () => {
  it('demo + connect_required: says no card is charged and links to Commerce Connect', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ settlement: 'demo', reason: 'connect_required', connectAvailable: true });
    renderPage();
    const link = await screen.findByRole('link', { name: /connect stripe/i });
    expect(link.getAttribute('href')).toBe('/commerce-connect');
    expect(screen.getByText(/no card is charged/i)).toBeTruthy();
    expect(api.getPaymentsReadiness).toHaveBeenCalledWith('o1');
  });

  it('demo without Commerce Connect available: tells the owner who can enable it, no dead link', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ settlement: 'demo', reason: 'connect_required', connectAvailable: false });
    renderPage();
    await demoNotice();
    expect(screen.getByText(/ask your workspace operator/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /connect stripe/i })).toBeNull();
  });

  it('ADR 0948 D8/P0b — a client org owner: says the client\'s own account is not set up, offers ITS OWN setup, and NO Connect link (that would onboard the agency)', async () => {
    api.getPaymentsReadiness.mockResolvedValue(CLIENT_OWNER);
    api.startClientPayments.mockResolvedValue({ url: 'demo:connect-onboarding', mode: 'demo' });
    renderPage();
    const notice = await demoNotice();
    expect(notice.textContent).toContain("This client's own payment account is not set up yet");
    expect(within(notice).queryByRole('link')).toBeNull();
    const setup = within(notice).getByRole('button', { name: /set up this client's payments/i });
    await act(async () => { fireEvent.click(setup); });
    expect(api.startClientPayments).toHaveBeenCalledExactlyOnceWith('o1');
    expect(toastApi.info).toHaveBeenCalledExactlyOnceWith('Payment setup started in demo mode: no Stripe account is created on this host.');
  });

  it('ADR 0948 P0b — the setup button is busy while the request runs, and a second click starts nothing', async () => {
    api.getPaymentsReadiness.mockResolvedValue(CLIENT_OWNER);
    let finish: (v: { url: string; mode: 'live' | 'demo' }) => void = () => undefined;
    api.startClientPayments.mockReturnValue(new Promise((res) => { finish = res; }));
    renderPage();
    const setup = await screen.findByRole('button', { name: /set up this client's payments/i });
    await act(async () => { fireEvent.click(setup); });
    expect(setup.getAttribute('aria-busy')).toBe('true');
    await act(async () => { fireEvent.click(setup); });
    expect(api.startClientPayments).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ url: 'demo:connect-onboarding', mode: 'demo' }); });
  });

  it('ADR 0948 P0b — a refusal is shown in the reader\'s words, never the server\'s scope message', async () => {
    api.getPaymentsReadiness.mockResolvedValue(CLIENT_OWNER);
    const { CommerceApiError } = await vi.importActual<typeof import('../commerceClient.js')>('../commerceClient.js');
    api.startClientPayments.mockRejectedValue(new CommerceApiError('Missing required scope: host:org:manage', 'forbidden_scope', undefined, 403));
    renderPage();
    const setup = await screen.findByRole('button', { name: /set up this client's payments/i });
    await act(async () => { fireEvent.click(setup); });
    expect(toastApi.error).toHaveBeenCalledExactlyOnceWith("Only this client organization's owner can set up its payments.");
  });

  it('ADR 0948 P0b — a member who is not the client org\'s owner is told who can act, with no button', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ ...CLIENT_OWNER, canOnboardClient: false });
    renderPage();
    await demoNotice();
    expect(screen.getByText(/ask this client organization's owner/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /client's payment/i })).toBeNull();
  });

  it('ADR 0948 P0b — with Commerce Connect off, a client org gets the operator sentence, not a button that must fail', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ ...CLIENT_OWNER, connectAvailable: false, canOnboardClient: false });
    renderPage();
    await demoNotice();
    expect(screen.getByText(/ask your workspace operator/i)).toBeTruthy();
    expect(screen.queryByText(/ask this client organization's owner/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /client's payment/i })).toBeNull();
  });

  it('ADR 0948 P0b — a half-onboarded client org resumes ITS OWN setup, never the agency link', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ ...CLIENT_OWNER, reason: 'connect_incomplete' });
    renderPage();
    const notice = await demoNotice();
    expect(within(notice).getByRole('button').textContent).toBe("Finish this client's payment setup");
    expect(within(notice).queryByRole('link')).toBeNull();
  });

  it('ADR 0948 P0b — returning from Stripe syncs the client seller and re-reads the notice', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ ...CLIENT_OWNER, reason: 'connect_incomplete' });
    api.syncClientPayments.mockResolvedValue({ seller: {} });
    renderPage('/commerce?org=o1&onboarding=return');
    await waitFor(() => expect(toastApi.success).toHaveBeenCalledTimes(1));
    expect(toastApi.success).toHaveBeenCalledWith("Back from Stripe. This client's payment status is up to date.");
    expect(api.syncClientPayments).toHaveBeenCalledExactlyOnceWith('o1');
    await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
    // The notice was READ AGAIN after the sync landed, not only before it.
    const reads = api.getPaymentsReadiness.mock.invocationCallOrder;
    expect(reads[reads.length - 1]!).toBeGreaterThan(api.syncClientPayments.mock.invocationCallOrder[0]!);
  });

  it('connect: names the connected-account lane and the fee', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ settlement: 'connect', applicationFeePct: 12, connectAvailable: true });
    renderPage();
    expect((await screen.findByText(/Live payments go to/)).textContent).toBe('Live payments go to your connected Stripe account. The platform keeps a 12% fee on each sale.');
  });

  // One case per arm (a loop hid WHICH arm broke). Each waits for the notice's own
  // read to be issued and drains it before asserting the ABSENCE — a single
  // microtask after the tablist could assert before the read landed.
  it.each<[string, () => Promise<PaymentsReadiness>]>([
    ['platform', () => Promise.resolve({ settlement: 'platform', connectAvailable: false })],
    ['keyless', () => Promise.resolve({ settlement: 'demo', reason: 'no_key', connectAvailable: false })],
    ['a FAILED read', () => Promise.reject(new Error('500'))],
  ])('%s renders nothing (never a false demo claim)', async (_arm, answer) => {
    api.getPaymentsReadiness.mockImplementation(answer);
    renderPage();
    await screen.findByRole('tablist');
    await waitFor(() => expect(api.getPaymentsReadiness).toHaveBeenCalledWith('o1'));
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByText('Demo checkout only.')).toBeNull();
    expect(screen.queryByText(/Live payments go to/)).toBeNull();
  });
});
