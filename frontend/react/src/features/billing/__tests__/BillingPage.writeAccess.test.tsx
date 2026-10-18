/**
 * ADR 0786 D5 — opening the Stripe billing portal (cancel the plan, change the
 * card, read invoices) is an admin act. The SERVER refuses anyone else with 403
 * (`test/adr0786-billing-money-truth.test.ts` pins that on all three writes); this
 * file pins the presentation: the button is not offered to a member who lacks
 * `host:billing:manage`, IS offered to one who holds it (both directions — "hidden"
 * alone would pass against a deleted button), a refusal reads as a refusal rather
 * than transport text, an anonymous session is told to sign in, and a checkout
 * return says the purchase is on its way instead of claiming it landed.
 *
 * Witnessed (wave 52): offering the button to a member (or keying it on
 * workspace:write), toasting raw transport text — or nothing — on a 403, losing the
 * anonymous sign-in reason, ignoring `?checkout=success`, telling a member to use
 * the portal, a non-renewing status saying "Renews", any status label missing
 * (every member of the backend's `SubscriptionStatus` union is rendered),
 * `cancelAtPeriodEnd` ignored, the store's billing namespace dropped, and the
 * past_due banner/grace copy each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { ApiError } from '../../../client/requestJson.js';
import type { Subscription, TokenBalance, AiCreditMeter } from '../billingClient.js';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const access = vi.hoisted(() => ({ current: { access: { basis: 'member', scopes: [] as string[] }, resolved: true } }));
vi.mock('../billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: vi.fn(async (): Promise<Subscription> => ({ tenantId: 't', planTier: 'pro', status: 'active' })),
  getBalance: vi.fn(async (): Promise<TokenBalance> => ({ tenantId: 't', purchasedTokensTotal: 0, totalAvailable: 0 })),
  openPortal: vi.fn(),
  // ADR 0821 — the admin-only credit meter (pinned in BillingPage.aiCredits.test.tsx).
  getAiCredits: vi.fn(async (): Promise<AiCreditMeter> => ({ freeDaily: null, monthly: null, balanceCredits: 0, windowDays: 30, topFeatures: [], otherCredits: 0 })),
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
import { openPortal, getSubscription } from '../billingClient.js';
// ADR 0820 §7 — the "Your data" panel's read (its own tests: dataExport.test.tsx).
vi.mock('../dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

const mPortal = vi.mocked(openPortal);
const mSub = vi.mocked(getSubscription);
const ACTIVE: Subscription = { tenantId: 't', planTier: 'pro', status: 'active' };
const at = (path = '/billing') => render(<MemoryRouter initialEntries={[path]}><BillingPage /></MemoryRouter>);
const ADMIN = { access: { basis: 'member', scopes: ['workspace:write', 'host:billing:manage'] }, resolved: true };
const EDITOR = { access: { basis: 'member', scopes: ['workspace:read', 'workspace:write'] }, resolved: true };

beforeEach(() => {
  vi.clearAllMocks();
  mSub.mockReset();
  mSub.mockResolvedValue(ACTIVE);
  access.current = ADMIN;
});
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
    // The refusal itself, in the shared localized words (en `common:error_forbidden`, literal).
    expect(shown).toBe("You don't have permission to do that here. Ask an admin of this workspace for access.");
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
    mSub.mockRejectedValue(new Error('upstream 503'));
    at();
    expect(await screen.findByText(/ask a workspace owner or admin to check billing/)).toBeTruthy();
    expect(screen.queryByText(/Use “Manage billing”/)).toBeNull();
  });
  it('every Stripe status the backend can store has a label, and a cancelled plan never says "Renews"', async () => {
    // The OTHER side is READ, not copied: the backend's `SubscriptionStatus` union.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), '..', '..', 'backend/typescript/src/features/billing/billingService.ts'), 'utf8');
    const union = /export type SubscriptionStatus =([^;]+);/.exec(src)?.[1] ?? '';
    const statuses = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(statuses).toHaveLength(9); // measured 2026-10-16: 9 members — a parse failure cannot pass empty
    for (const status of statuses) {
      mSub.mockResolvedValue({ tenantId: 't', planTier: 'pro', status, currentPeriodEnd: '2026-10-29T00:00:00.000Z' });
      at();
      await screen.findByRole('button', { name: /manage billing/i });
      // A label, never the raw stored id (i18next would fall back to `defaultValue: status`).
      expect(screen.queryByText(status), `status ${status} has no label`).toBeNull();
      // "Renews" only for a still-billing subscription (positive control for active/trialing).
      if (status === 'active' || status === 'trialing') expect(screen.getByText(/^Renews /)).toBeTruthy();
      else expect(screen.queryByText(/^Renews/), `status ${status} says Renews`).toBeNull();
      cleanup();
    }
    mSub.mockResolvedValue({ tenantId: 't', planTier: 'pro', status: 'incomplete_expired', currentPeriodEnd: '2026-10-29T00:00:00.000Z' });
    at();
    expect(await screen.findByText('Expired')).toBeTruthy();
    expect(screen.queryByText(/incomplete_expired/)).toBeNull();
    expect(screen.queryByText(/^Renews/)).toBeNull();
  });
});

describe('BillingPage — a plan set to cancel says so (BILLUX-5)', () => {
  it('an active subscription with cancel_at_period_end shows "Access until", never "Renews"', async () => {
    mSub.mockResolvedValue({ tenantId: 't', planTier: 'pro', status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2026-10-29T00:00:00.000Z' });
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
    // Measured 2026-10-16: exactly 2 callers (BillingPage, BundleShopPage) — not vacuous.
    expect(callers.length).toBeGreaterThanOrEqual(2);
    const NS = /useTranslation\((?:'billing'|\[[^\]]*'billing'[^\]]*\])/;
    for (const f of callers) {
      const src = readFileSync(f, 'utf8');
      // Check the COMPONENT that renders the copy, not "any component in the file":
      // the slice from the nearest preceding `function ` declaration to each call
      // must load the namespace (BundleShopPage also holds a marketplace-only one).
      for (const m of src.matchAll(/billingErrorMessage\(/g)) {
        const before = src.slice(0, m.index);
        const start = before.lastIndexOf('function ');
        expect(start, `${f}: no enclosing function for a billingErrorMessage call`).toBeGreaterThanOrEqual(0);
        expect(NS.test(src.slice(start, m.index)), `${f} renders billing copy without loading the billing namespace`).toBe(true);
      }
    }
  });
});

describe('ADR 0820 §7 — the past_due banner', () => {
  it('a past_due plan with a grace window says until when access lasts; an active plan shows no banner (control)', async () => {
    mSub.mockResolvedValueOnce({ tenantId: 't', planTier: 'pro', status: 'past_due', pastDueGraceEndsAt: '2026-10-12T00:00:00.000Z' });
    at();
    expect(await screen.findByText('Your last payment failed')).toBeTruthy();
    expect(screen.getByText(/Your plan stays active until/)).toBeTruthy();
    cleanup();
    at();
    await screen.findByRole('button', { name: /manage billing/i });
    expect(screen.queryByText('Your last payment failed')).toBeNull();
  });
  it('past_due without a grace window says paid features are paused', async () => {
    mSub.mockResolvedValue({ tenantId: 't', planTier: 'pro', status: 'past_due' });
    at();
    expect(await screen.findByText(/Paid features are paused/)).toBeTruthy();
  });
});
