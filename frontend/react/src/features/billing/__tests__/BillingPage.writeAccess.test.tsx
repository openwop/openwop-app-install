/**
 * ADR 0786 D5 — opening the Stripe billing portal (cancel the plan, change the
 * card, read invoices) is an admin act. The SERVER refuses anyone else with 403
 * (`test/adr0786-billing-money-truth.test.ts` pins that on all three writes); this
 * file pins the presentation: the button is not offered to a member who lacks
 * `host:billing:manage`, IS offered to one who holds it (both directions — "hidden"
 * alone would pass against a deleted button), a refusal reads as a refusal rather
 * than transport text, an anonymous session is told to sign in, and a checkout
 * return says the purchase is on its way instead of claiming it landed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { ApiError } from '../../../client/requestJson.js';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const access = vi.hoisted(() => ({ current: { access: { basis: 'member', scopes: [] as string[] }, resolved: true } }));
vi.mock('../billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: vi.fn(async () => ({ tenantId: 't', planTier: 'pro', status: 'active' })),
  getBalance: vi.fn(async () => ({ tenantId: 't', purchasedTokensTotal: 0, totalAvailable: 0 })),
  openPortal: vi.fn(),
  // ADR 0821 — the admin-only credit meter (pinned in BillingPage.aiCredits.test.tsx).
  getAiCredits: vi.fn(async () => ({ freeDaily: null, monthly: null, balanceCredits: 0, windowDays: 30, topFeatures: [], otherCredits: 0 })),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useEffectiveAccessState: () => access.current,
}));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));

import { BillingPage } from '../BillingPage.js';
import { openPortal } from '../billingClient.js';
// ADR 0820 §7 — the "Your data" panel's read (its own tests: dataExport.test.tsx).
vi.mock('../dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

const mPortal = vi.mocked(openPortal);
const at = (path = '/billing') => render(<MemoryRouter initialEntries={[path]}><BillingPage /></MemoryRouter>);
const ADMIN = { access: { basis: 'member', scopes: ['workspace:write', 'host:billing:manage'] }, resolved: true };
const EDITOR = { access: { basis: 'member', scopes: ['workspace:read', 'workspace:write'] }, resolved: true };

beforeEach(() => { vi.clearAllMocks(); access.current = ADMIN; });
afterEach(cleanup);

describe('BillingPage — the portal is offered only to a caller who may open it', () => {
  it('a member WITHOUT host:billing:manage sees why, and no Manage button', async () => {
    access.current = EDITOR;
    at();
    expect(await screen.findByText('Only workspace owners and admins can manage billing.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /manage billing/i })).toBeNull();
  });
  it('an ADMIN is offered Manage billing', async () => {
    at();
    expect(await screen.findByRole('button', { name: /manage billing/i })).toBeTruthy();
    expect(screen.queryByText('Only workspace owners and admins can manage billing.')).toBeNull();
  });
  it('a 403 from the server reads as a refusal, never as transport text', async () => {
    mPortal.mockRejectedValue(new ApiError({ status: 403, statusText: 'Forbidden', url: 'portal', body: { error: 'forbidden_scope', message: 'Missing required scope: host:billing:manage' }, message: 'Missing required scope: host:billing:manage' }));
    at();
    fireEvent.click(await screen.findByRole('button', { name: /manage billing/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    const shown = String(toasts.error.mock.calls[0]![0]);
    expect(shown).not.toMatch(/host:billing:manage|Missing required scope/);
  });
  it('an ANONYMOUS session is told to sign in', async () => {
    mPortal.mockRejectedValue(new ApiError({ status: 403, statusText: 'Forbidden', url: 'portal', body: { error: 'forbidden', message: 'Sign in to purchase or manage billing.', details: { reason: 'anonymous_session' } } }));
    at();
    fireEvent.click(await screen.findByRole('button', { name: /manage billing/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Sign in to purchase or manage billing.'));
  });
  it('a checkout return says the purchase is on its way (the webhook applies it)', async () => {
    at('/billing?checkout=success');
    // It must NOT claim the payment landed: a delayed method returns here unpaid (BILLUX-2).
    expect(await screen.findByText(/Checkout complete\. Your purchase is applied as soon as the payment confirms/)).toBeTruthy();
    expect(screen.queryByText(/Payment received/)).toBeNull();
  });
});

describe('BillingPage — status and renewal copy (BILLUX-3/4/5)', () => {
  it('a member who cannot open the portal is not told to use it when the read fails', async () => {
    access.current = EDITOR;
    const { getSubscription } = await import('../billingClient.js');
    vi.mocked(getSubscription).mockRejectedValueOnce(new Error('upstream 503'));
    at();
    expect(await screen.findByText(/ask a workspace owner or admin to check billing/)).toBeTruthy();
    expect(screen.queryByText(/Use “Manage billing”/)).toBeNull();
  });
  it('every Stripe status the backend can store has a label, and a cancelled plan never says "Renews"', async () => {
    const { getSubscription } = await import('../billingClient.js');
    vi.mocked(getSubscription).mockResolvedValueOnce({ tenantId: 't', planTier: 'pro', status: 'incomplete_expired', currentPeriodEnd: '2026-10-29T00:00:00.000Z' } as never);
    at();
    expect(await screen.findByText('Expired')).toBeTruthy();
    expect(screen.queryByText(/incomplete_expired/)).toBeNull();
    expect(screen.queryByText(/^Renews/)).toBeNull();
  });
});

describe('BillingPage — a plan set to cancel says so (BILLUX-5)', () => {
  it('an active subscription with cancel_at_period_end shows "Access until", never "Renews"', async () => {
    const { getSubscription } = await import('../billingClient.js');
    vi.mocked(getSubscription).mockResolvedValueOnce({ tenantId: 't', planTier: 'pro', status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2026-10-29T00:00:00.000Z' } as never);
    at();
    expect(await screen.findByText(/^Access until /)).toBeTruthy();
    expect(screen.queryByText(/^Renews/)).toBeNull();
  });
});

describe('the store explains a refusal in billing\'s words even when billing\'s catalog was never loaded (BILLUX-1)', () => {
  // i18n-setup preloads every lazy namespace, which is exactly why the raw-key bug
  // was invisible to render tests. This pins the mechanism statically instead:
  // every component that renders `billingErrorMessage` must ask for `billing`.
  it('each caller of billingErrorMessage loads the billing namespace', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    // vitest runs from frontend/react; jsdom's import.meta.url is not a file: URL.
    const root = join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(f); }
        else if (f.endsWith('.tsx')) files.push(f);
      }
    };
    walk(root);
    const callers = files.filter((f) => /billingErrorMessage\(/.test(readFileSync(f, 'utf8')));
    expect(callers.length).toBeGreaterThanOrEqual(2); // BillingPage + BundleShopPage — not vacuous
    for (const f of callers) {
      const src = readFileSync(f, 'utf8');
      expect(/useTranslation\((?:'billing'|\[[^\]]*'billing'[^\]]*\])/.test(src), `${f} renders billing copy without loading the billing namespace`).toBe(true);
    }
  });
});

describe('ADR 0820 §7 — the past_due banner', () => {
  it('a past_due plan with a grace window says until when access lasts; an active plan shows no banner (control)', async () => {
    const { getSubscription } = await import('../billingClient.js');
    vi.mocked(getSubscription).mockResolvedValueOnce({ tenantId: 't', planTier: 'pro', status: 'past_due', pastDueGraceEndsAt: '2026-10-12T00:00:00.000Z' });
    at();
    expect(await screen.findByText('Your last payment failed')).toBeTruthy();
    expect(screen.getByText(/Your plan stays active until/)).toBeTruthy();
    cleanup();
    at();
    await screen.findByRole('button', { name: /manage billing/i });
    expect(screen.queryByText('Your last payment failed')).toBeNull();
  });
  it('past_due without a grace window says paid features are paused', async () => {
    const { getSubscription } = await import('../billingClient.js');
    vi.mocked(getSubscription).mockResolvedValueOnce({ tenantId: 't', planTier: 'pro', status: 'past_due' });
    at();
    expect(await screen.findByText(/Paid features are paused/)).toBeTruthy();
  });
});
