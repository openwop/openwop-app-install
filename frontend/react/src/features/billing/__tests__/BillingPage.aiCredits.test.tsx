/**
 * ADR 0821 D1/D2/D4 — the billing page's AI credit meter. Pins the presentation:
 *   - it is offered only to a caller who may manage billing (the server read is
 *     `host:billing:manage`), and for a member it is never even requested;
 *   - a leg the server returns as `null` is NOT rendered — no "0 of 0" bar that
 *     would read as an exhausted allowance — while a real leg is;
 *   - a failed read says so, and never renders as zero credits.
 *
 * Witnessed (wave 52): rendering a null leg as a 0-of-0 bar, a 0 used value, a
 * blank attribution label, offering the meter to a member, or turning a failed
 * read into a zero meter each turn a case red. The meter is `React.lazy`; the
 * member case awaits the chunk itself (`settleLazy`) so its absence assertions
 * cannot pass on a Suspense fallback when the file runs shuffled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { AiCreditMeter, Subscription, TokenBalance } from '../billingClient.js';

const access = vi.hoisted(() => ({ current: { access: { basis: 'member', scopes: [] as string[] }, resolved: true } }));
vi.mock('../billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: vi.fn(async (): Promise<Subscription> => ({ tenantId: 't', planTier: 'pro', status: 'active' })),
  getBalance: vi.fn(async (): Promise<TokenBalance> => ({ tenantId: 't', purchasedTokensTotal: 0, totalAvailable: 0 })),
  getAiCredits: vi.fn(),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useEffectiveAccessState: () => access.current,
}));

import { BillingPage } from '../BillingPage.js';
import { getAiCredits } from '../billingClient.js';
// ADR 0820 §7 — the "Your data" panel's read (its own tests: dataExport.test.tsx).
vi.mock('../dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

const mCredits = vi.mocked(getAiCredits);
const ADMIN = { access: { basis: 'member', scopes: ['workspace:write', 'host:billing:manage'] }, resolved: true };
const EDITOR = { access: { basis: 'member', scopes: ['workspace:read', 'workspace:write'] }, resolved: true };
const at = () => render(<MemoryRouter initialEntries={['/billing']}><BillingPage /></MemoryRouter>);
const METER: AiCreditMeter = {
  freeDaily: { day: '2026-10-05', usedCredits: 12.5, capCredits: 200, scope: 'subject' },
  monthly: null,
  balanceCredits: 120,
  windowDays: 30,
  topFeatures: [{ featureId: 'chat', label: 'AI chat', usedCredits: 40, chargedCredits: 2, calls: 9 }, { featureId: 'chat-autotitle', usedCredits: 1, chargedCredits: 0, calls: 3 }],
  otherCredits: 0,
};

/** Resolve the lazy meter chunk and let any mount effect run, so an absence check
 *  is made after the meter WOULD have rendered — not while Suspense is pending. */
const settleLazy = async (): Promise<void> => {
  await act(async () => {
    await import('../AiCreditMeter.js');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  });
};

beforeEach(() => { vi.clearAllMocks(); mCredits.mockReset(); access.current = ADMIN; });
afterEach(cleanup);

describe('BillingPage — AI credit meter', () => {
  it('an ADMIN sees the real legs, and a null leg is not rendered at all', async () => {
    mCredits.mockResolvedValue(METER);
    at();
    expect(await screen.findByRole('heading', { name: 'AI credits' })).toBeTruthy();
    expect(screen.getByText('Free allowance today')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /Free allowance today: 12\.5 of 200 credits/ })).toBeTruthy();
    expect(screen.queryByText('Plan allowance this month')).toBeNull();
    expect(screen.getByText('Purchased credits')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('AI chat')).toBeTruthy();
    expect(screen.getByText(/40 credits used · 2 charged/)).toBeTruthy();
    // No toggle label ⇒ the attribution id itself, never a blank row.
    expect(screen.getByText('chat-autotitle')).toBeTruthy();
  });

  it('a plan allowance renders as its own bar', async () => {
    mCredits.mockResolvedValue({ ...METER, freeDaily: null, monthly: { month: '2026-10', usedCredits: 300, allowanceCredits: 1000 } });
    at();
    expect(await screen.findByRole('progressbar', { name: /Plan allowance this month: 300 of 1,000 credits/ })).toBeTruthy();
    expect(screen.queryByText('Free allowance today')).toBeNull();
  });

  it('a member without host:billing:manage is never shown — or sent to — the meter', async () => {
    access.current = EDITOR;
    at();
    expect(await screen.findByText('Only workspace owners and admins can manage billing.')).toBeTruthy();
    await settleLazy();
    expect(screen.queryByRole('heading', { name: 'AI credits' })).toBeNull();
    expect(mCredits).not.toHaveBeenCalled();
  });

  it('a failed read says so, never "0 credits"', async () => {
    mCredits.mockRejectedValue(new Error('network down'));
    at();
    expect(await screen.findByText(/Could not load your AI credit usage\./)).toBeTruthy();
    expect(screen.queryByText('Purchased credits')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'AI credits' })).toBeNull();
  });
});
