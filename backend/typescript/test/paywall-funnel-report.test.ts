/**
 * ADR 0820 §7 / monetization strategy §8 — the funnel ARITHMETIC
 * (`buildFunnelReport`, pure, no I/O). The route test
 * (`paywall-funnel-routes.test.ts`) proves the reads feed it.
 *
 * Sabotages each case is red against (probed, /grade-tests 8f w1):
 *   - `rate` dividing on `d >= 0` (a zero denominator reads as 0%/100%);
 *   - the demo-checkout `continue` dropped (demo counted as started);
 *   - `refusedTenants` reporting the refusal COUNT, or counting tenants over
 *     every metric (the t3 impression-only row below makes that visible);
 *   - the bundle roll-up assigning instead of summing; a grants-only bundle
 *     dropped; a loose feature's `''` bundle not normalised to null.
 * Not claimed here: the ledger-count path (b) and the `startedCounted` /
 * `completedCounted` cutover (a grade-code gap, not this file's claim).
 */
import { describe, expect, it } from 'vitest';
import { buildFunnelReport, rate } from '../src/features/billing/funnelReport.js';
import type { PaywallCountRow } from '../src/host/paywallFunnel.js';
import type { CheckoutFunnelRow } from '../src/features/billing/billingService.js';

const row = (p: Partial<PaywallCountRow> & Pick<PaywallCountRow, 'metric' | 'featureId' | 'count'>): PaywallCountRow => ({
  day: '2026-10-07', tenantId: 't1', bundleId: 'crm', surface: 'sidebar', updatedAt: '2026-10-07T00:00:00.000Z', ...p,
});
const co = (p: Partial<CheckoutFunnelRow> & Pick<CheckoutFunnelRow, 'product'>): CheckoutFunnelRow => ({
  tenantId: 't1', kind: 'bundle', mode: 'live', createdAt: '2026-10-07T01:00:00.000Z', ...p,
});

describe('strategy §8 — funnel arithmetic', () => {
  it('rate is null on a zero denominator, never 0% or 100%', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(3, 0)).toBeNull();
    expect(rate(1, 3)).toBe(0.3333);
    expect(rate(2, 2)).toBe(1);
  });

  it('sums per feature, per surface and per bundle; counts refused tenants apart from refusals', () => {
    const r = buildFunnelReport({
      days: 7, since: 's', until: 'u',
      counts: [
        row({ metric: 'impression', featureId: 'crm', count: 8, surface: 'sidebar' }),
        row({ metric: 'impression', featureId: 'crm', count: 2, surface: 'locked-page' }),
        row({ metric: 'click', featureId: 'crm', count: 3, surface: 'sidebar' }),
        // a daemon re-checking ONE tenant every tick: many refusals, one tenant
        row({ metric: 'refusal', featureId: 'crm', count: 40, surface: 'lane' }),
        row({ metric: 'refusal', featureId: 'crm', count: 1, surface: 'route', tenantId: 't2' }),
        // a tenant that only SAW the paywall: it must not count as a refused tenant
        row({ metric: 'impression', featureId: 'crm', count: 1, surface: 'sidebar', tenantId: 't3' }),
        row({ metric: 'impression', featureId: 'crm-sign', count: 5, surface: 'palette' }),
        row({ metric: 'impression', featureId: 'loose', count: 1, bundleId: '' }),
      ],
      checkouts: [
        co({ product: 'bundle:crm', fulfilledAt: '2026-10-07T01:05:00.000Z' }),
        co({ product: 'bundle:crm' }),
        co({ product: 'bundle:crm', mode: 'demo' }),
        co({ product: 'plan:pro', kind: 'plan', fulfilledAt: 'x' }),
        co({ product: 'pack:pack_abc', kind: 'token-pack' }),
      ],
      active: { bundles: { crm: 4, agents: 1 }, plans: { pro: 2 } },
    });

    const crm = r.features.find((f) => f.featureId === 'crm')!;
    expect(crm).toMatchObject({ bundleId: 'crm', impressions: 11, clicks: 3, refusals: 41, refusedTenants: 2 });
    expect(crm.surfaces.sidebar).toEqual({ impressions: 9, clicks: 3, refusals: 0 });
    expect(crm.surfaces.lane).toEqual({ impressions: 0, clicks: 0, refusals: 40 });
    expect(r.features.find((f) => f.featureId === 'loose')?.bundleId).toBeNull();

    const b = r.bundles.find((x) => x.bundleId === 'crm')!;
    // two features of the same bundle roll up into it
    expect(b).toMatchObject({ impressions: 16, clicks: 3, refusals: 41, refusedTenants: 2, checkoutsStarted: 2, checkoutsCompleted: 1, activeGrants: 4 });
    expect(b.clickThroughRate).toBe(0.1875); // 3 / 16, by hand
    expect(b.checkoutCompletionRate).toBe(0.5);
    // a bundle with grants but no traffic still appears, with honest null rates
    const agents = r.bundles.find((x) => x.bundleId === 'agents')!;
    expect(agents).toMatchObject({ activeGrants: 1, impressions: 0, clickThroughRate: null, checkoutCompletionRate: null });

    // demo checkouts are reported apart and never counted as started
    expect(r.checkouts.find((c) => c.product === 'bundle:crm')).toEqual({ product: 'bundle:crm', kind: 'bundle', started: 2, completed: 1, demoStarted: 1 });
    expect(r.plans).toEqual([{ tier: 'pro', active: 2, checkoutsStarted: 1, checkoutsCompleted: 1 }]);
    expect(r.totals).toEqual({ impressions: 17, clicks: 3, refusals: 41, checkoutsStarted: 4, checkoutsCompleted: 2, demoCheckouts: 1, grantsStarted: 0, grantsEnded: 0 });
  });

  it('an empty window is an empty report, not an error', () => {
    const r = buildFunnelReport({ days: 30, since: 's', until: 'u', counts: [], checkouts: [], active: { bundles: {}, plans: {} } });
    expect(r).toMatchObject({ days: 30, features: [], bundles: [], checkouts: [], plans: [] });
    expect(r.totals.impressions).toBe(0);
  });
});
