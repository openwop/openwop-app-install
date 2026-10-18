/**
 * ADR 0877 D6 — the owner is told which lane the store's checkout settles on.
 * A store that has not connected Stripe takes DEMO orders on a live host; without
 * this notice its owner sees orders that will never be paid and no reason why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(), listProducts: vi.fn(), listOrders: vi.fn(),
  listQuotes: vi.fn(), listProductFields: vi.fn(), listPriceLists: vi.fn(),
  listCoupons: vi.fn(), getPaymentsReadiness: vi.fn(),
}));
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

const renderPage = (): void => { render(<MemoryRouter><CommercePage /></MemoryRouter>); };

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
