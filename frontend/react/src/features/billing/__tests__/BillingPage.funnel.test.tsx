/**
 * ADR 0820 §7 / monetization strategy §8 — the operator's paywall funnel panel on
 * the billing page (cross-workspace data: superadmin only).
 *  - shown (and fetched) ONLY for a superadmin; an owner/admin never requests it;
 *  - a rate with no denominator renders "—", never 0%;
 *  - demo-mode checkouts are named as excluded;
 *  - switching the window re-reads with days=30;
 *  - a failed read says so, and shows no bundle rows.
 *
 * Witnessed (wave 52): "—" → 0%, the wrong rate column, hiding the demo count,
 * a window button that always reads 7, "new" → "no change", a swallowed weekly
 * failure, offering the panel to a non-superadmin, and hiding the read failure
 * each turn a case red. The panel is `React.lazy`: the owner case awaits the
 * chunk (`settleLazy`) before asserting it never mounted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { PaywallFunnel, Subscription, TokenBalance, AiCreditMeter } from '../billingClient.js';

const access = vi.hoisted(() => ({ current: { access: { basis: 'member', scopes: [] as string[], superadmin: false as boolean }, resolved: true } }));
vi.mock('../billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: vi.fn(async (): Promise<Subscription> => ({ tenantId: 't', planTier: 'pro', status: 'active' })),
  getBalance: vi.fn(async (): Promise<TokenBalance> => ({ tenantId: 't', purchasedTokensTotal: 0, totalAvailable: 0 })),
  getAiCredits: vi.fn(async (): Promise<AiCreditMeter> => ({ freeDaily: null, monthly: null, balanceCredits: 0, windowDays: 30, topFeatures: [], otherCredits: 0 })),
  getPaywallFunnel: vi.fn(),
  getPaywallFunnelWeekly: vi.fn(),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useEffectiveAccessState: () => access.current,
}));

import { BillingPage } from '../BillingPage.js';
import { getPaywallFunnel, getPaywallFunnelWeekly, type PaywallFunnelWeekly } from '../billingClient.js';
// ADR 0820 §7 — the "Your data" panel's read (its own tests: dataExport.test.tsx).
vi.mock('../dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

const mFunnel = vi.mocked(getPaywallFunnel);
const mWeekly = vi.mocked(getPaywallFunnelWeekly);
const zeroWeek = { impressions: 0, clicks: 0, refusals: 0, checkoutsStarted: 0, checkoutsCompleted: 0, grantsStarted: 0, grantsEnded: 0 };
const WEEKLY: PaywallFunnelWeekly = {
  week: '2026-W41',
  current: { since: 's', until: 'u', totals: { ...zeroWeek, impressions: 120, clicks: 6, refusals: 3, grantsStarted: 2, grantsEnded: 1 } },
  previous: { since: 's', until: 'u', totals: { ...zeroWeek, impressions: 100, clicks: 8 } },
  change: { impressions: 0.2, clicks: -0.25, refusals: null, checkoutsStarted: null, checkoutsCompleted: null, grantsStarted: null, grantsEnded: null },
  bundles: [{ bundleId: 'crm', grantsStarted: 2, grantsEnded: 1, previousGrantsStarted: 0, previousGrantsEnded: 0 }],
};
const OPERATOR = { access: { basis: 'member', scopes: ['host:billing:manage'], superadmin: true }, resolved: true };
const OWNER = { access: { basis: 'member', scopes: ['host:billing:manage'], superadmin: false }, resolved: true };
const FUNNEL: PaywallFunnel = {
  days: 7, since: '2026-10-01T00:00:00.000Z', until: '2026-10-07T12:00:00.000Z',
  features: [],
  bundles: [
    { bundleId: 'crm', impressions: 10, clicks: 2, refusals: 5, refusedTenants: 1, checkoutsStarted: 2, checkoutsCompleted: 1, activeGrants: 3, grantsStarted: 0, grantsEnded: 0, clickThroughRate: 0.2, checkoutCompletionRate: 0.5 },
    { bundleId: 'agents', impressions: 0, clicks: 0, refusals: 0, refusedTenants: 0, checkoutsStarted: 0, checkoutsCompleted: 0, activeGrants: 1, grantsStarted: 0, grantsEnded: 0, clickThroughRate: null, checkoutCompletionRate: null },
  ],
  checkouts: [],
  plans: [{ tier: 'pro', active: 2, checkoutsStarted: 1, checkoutsCompleted: 1 }],
  totals: { impressions: 10, clicks: 2, refusals: 5, checkoutsStarted: 3, checkoutsCompleted: 2, demoCheckouts: 4, grantsStarted: 0, grantsEnded: 0 },
};
const at = () => render(<MemoryRouter initialEntries={['/billing']}><BillingPage /></MemoryRouter>);

/** Resolve the lazy panel chunk and let any mount effect run, so "never sent to"
 *  is checked after the panel WOULD have mounted — not while Suspense is pending. */
const settleLazy = async (): Promise<void> => {
  await act(async () => {
    await import('../PaywallFunnelPanel.js');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mFunnel.mockReset();
  mWeekly.mockReset();
  access.current = OPERATOR;
  mWeekly.mockResolvedValue(WEEKLY);
});
afterEach(cleanup);

describe('BillingPage — paywall funnel (superadmin)', () => {
  it('a superadmin sees per-bundle rows; a rate with nothing to divide by is "—"', async () => {
    mFunnel.mockResolvedValue(FUNNEL);
    at();
    expect(await screen.findByRole('heading', { name: 'Paywall funnel' })).toBeTruthy();
    expect(mFunnel).toHaveBeenCalledWith(7);
    const crm = (await screen.findByRole('rowheader', { name: 'crm' })).closest('tr')!;
    expect(within(crm).getByText('20%')).toBeTruthy();
    expect(within(crm).getByText('50%')).toBeTruthy();
    const agents = screen.getByRole('rowheader', { name: 'agents' }).closest('tr')!;
    expect(within(agents).getAllByText('—')).toHaveLength(2);
    expect(within(agents).queryByText('0%')).toBeNull();
    expect(screen.getByText(/Demo-mode checkouts excluded.*: 4/)).toBeTruthy();
    expect(screen.getByText(/Pro: 2 active, 1 checkouts started, 1 completed/)).toBeTruthy();
  });

  it('switching to 30 days re-reads the window', async () => {
    mFunnel.mockResolvedValue(FUNNEL);
    at();
    await screen.findByRole('heading', { name: 'Paywall funnel' });
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(mFunnel).toHaveBeenLastCalledWith(30);
  });

  it('switching to 90 days re-reads the window', async () => {
    mFunnel.mockResolvedValue(FUNNEL);
    at();
    await screen.findByRole('heading', { name: 'Paywall funnel' });
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    expect(mFunnel).toHaveBeenLastCalledWith(90);
  });

  it('shows "This week vs last week": the change, "new" with nothing before, and churn by bundle', async () => {
    mFunnel.mockResolvedValue(FUNNEL);
    at();
    const table = await screen.findByRole('table', { name: 'This week compared with last week' });
    expect(screen.getByRole('heading', { name: 'This week vs last week' })).toBeTruthy();
    const views = within(table).getByRole('rowheader', { name: 'Lock views' }).closest('tr')!;
    expect(within(views).getByText('120')).toBeTruthy();
    expect(within(views).getByText('+20%')).toBeTruthy();
    const clicks = within(table).getByRole('rowheader', { name: 'Upgrade clicks' }).closest('tr')!;
    expect(within(clicks).getByText('-25%')).toBeTruthy();
    const refusals = within(table).getByRole('rowheader', { name: 'Plan refusals' }).closest('tr')!;
    expect(within(refusals).getByText('new')).toBeTruthy();
    const started = within(table).getByRole('rowheader', { name: 'Checkouts started' }).closest('tr')!;
    expect(within(started).getByText('no change')).toBeTruthy();
    expect(screen.getByText('crm: 2 new, 1 cancelled')).toBeTruthy();
  });

  it('a failed weekly read says so without hiding the funnel', async () => {
    mFunnel.mockResolvedValue(FUNNEL);
    mWeekly.mockRejectedValue(new Error('down'));
    at();
    expect(await screen.findByText(/Could not load the weekly comparison\./)).toBeTruthy();
    expect(await screen.findByRole('rowheader', { name: 'crm' })).toBeTruthy();
  });

  it('an owner who is not a superadmin is never shown — or sent to — the funnel', async () => {
    access.current = OWNER;
    at();
    expect(await screen.findByRole('heading', { name: 'AI credits' })).toBeTruthy();
    await settleLazy();
    expect(screen.queryByRole('heading', { name: 'Paywall funnel' })).toBeNull();
    expect(mFunnel).not.toHaveBeenCalled();
    expect(mWeekly).not.toHaveBeenCalled();
  });

  it('a failed read says so', async () => {
    mFunnel.mockRejectedValue(new Error('network down'));
    at();
    expect(await screen.findByText(/Could not load the paywall funnel\./)).toBeTruthy();
    expect(screen.queryByRole('rowheader', { name: 'crm' })).toBeNull();
  });
});
