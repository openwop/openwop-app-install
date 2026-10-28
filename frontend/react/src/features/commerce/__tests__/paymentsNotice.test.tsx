/**
 * ADR 0877 D6 — the owner is told which lane the store's checkout settles on.
 * A store that has not connected Stripe takes DEMO orders on a live host; without
 * this notice its owner sees orders that will never be paid and no reason why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(), listProducts: vi.fn(), listOrders: vi.fn(),
  listQuotes: vi.fn(), listProductFields: vi.fn(), listPriceLists: vi.fn(),
  listCoupons: vi.fn(), getPaymentsReadiness: vi.fn(), startClientPayments: vi.fn(), syncClientPayments: vi.fn(),
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
  api.listProducts.mockResolvedValue([]);
  api.listOrders.mockResolvedValue([]);
  api.listQuotes.mockResolvedValue([]);
  api.listProductFields.mockResolvedValue([]);
  api.listPriceLists.mockResolvedValue([]);
  api.listCoupons.mockResolvedValue([]);
});
afterEach(cleanup);

const renderPage = (url = '/commerce'): void => { render(<MemoryRouter initialEntries={[url]}><CommercePage /></MemoryRouter>); };
const CLIENT_OWNER = { settlement: 'demo', reason: 'client_seller_required', connectAvailable: true, clientOrg: true, canOnboardClient: true } as const;

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
    expect(await screen.findByText(/ask your workspace operator/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /connect stripe/i })).toBeNull();
  });

  it('ADR 0948 D8/P0b — a client org owner: says the client\'s own account is not set up, offers ITS OWN setup, and NO Connect link (that would onboard the agency)', async () => {
    api.getPaymentsReadiness.mockResolvedValue(CLIENT_OWNER);
    api.startClientPayments.mockResolvedValue({ url: 'demo:connect-onboarding', mode: 'demo' });
    renderPage();
    expect(await screen.findByText(/own payment account is not set up yet/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /connect stripe/i })).toBeNull();
    const setup = screen.getByRole('button', { name: /set up this client's payments/i });
    await act(async () => { fireEvent.click(setup); });
    expect(api.startClientPayments).toHaveBeenCalledWith('o1');
    expect(toastApi.info).toHaveBeenCalledWith(expect.stringMatching(/demo mode/i));
  });

  it('ADR 0948 P0b — the setup button is busy while the request runs, and a second click starts nothing', async () => {
    api.getPaymentsReadiness.mockResolvedValue(CLIENT_OWNER);
    let finish: (v: unknown) => void = () => undefined;
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
    expect(toastApi.error).toHaveBeenCalledWith("Only this client organization's owner can set up its payments.");
  });

  it('ADR 0948 P0b — a member who is not the client org\'s owner is told who can act, with no button', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ ...CLIENT_OWNER, canOnboardClient: false });
    renderPage();
    expect(await screen.findByText(/ask this client organization's owner/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /client's payment/i })).toBeNull();
  });

  it('ADR 0948 P0b — with Commerce Connect off, a client org gets the operator sentence, not a button that must fail', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ ...CLIENT_OWNER, connectAvailable: false, canOnboardClient: false });
    renderPage();
    expect(await screen.findByText(/ask your workspace operator/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /client's payment/i })).toBeNull();
  });

  it('ADR 0948 P0b — a half-onboarded client org resumes ITS OWN setup, never the agency link', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ ...CLIENT_OWNER, reason: 'connect_incomplete' });
    renderPage();
    expect(await screen.findByRole('button', { name: /finish this client's payment setup/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /finish/i })).toBeNull();
  });

  it('ADR 0948 P0b — returning from Stripe syncs the client seller and re-reads the notice', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ ...CLIENT_OWNER, reason: 'connect_incomplete' });
    api.syncClientPayments.mockResolvedValue({ seller: {} });
    renderPage('/commerce?org=o1&onboarding=return');
    await waitFor(() => expect(api.syncClientPayments).toHaveBeenCalledWith('o1'));
    await waitFor(() => expect(api.getPaymentsReadiness.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(toastApi.success).toHaveBeenCalledWith(expect.stringMatching(/back from stripe/i));
  });

  it('connect: names the connected-account lane and the fee', async () => {
    api.getPaymentsReadiness.mockResolvedValue({ settlement: 'connect', applicationFeePct: 12, connectAvailable: true });
    renderPage();
    expect(await screen.findByText('Live payments go to your connected Stripe account. The platform keeps a 12% fee on each sale.')).toBeTruthy();
  });

  // One case per arm (a loop hid WHICH arm broke). Each waits for the notice's own
  // read to be issued and drains it before asserting the ABSENCE — a single
  // microtask after the tablist could assert before the read landed.
  it.each<[string, () => Promise<unknown>]>([
    ['platform', () => Promise.resolve({ settlement: 'platform', connectAvailable: false })],
    ['keyless', () => Promise.resolve({ settlement: 'demo', reason: 'no_key', connectAvailable: false })],
    ['a FAILED read', () => Promise.reject(new Error('500'))],
  ])('platform, keyless and a FAILED read render nothing (never a false demo claim): %s', async (_arm, answer) => {
    api.getPaymentsReadiness.mockImplementation(answer);
    renderPage();
    await screen.findByRole('tablist');
    await waitFor(() => expect(api.getPaymentsReadiness).toHaveBeenCalledWith('o1'));
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByText('Demo checkout only.')).toBeNull();
    expect(screen.queryByText(/Live payments go to/)).toBeNull();
  });
});
