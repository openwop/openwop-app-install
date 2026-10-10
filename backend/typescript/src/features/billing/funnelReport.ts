/**
 * The operator's paywall → checkout → grant funnel (monetization strategy §8).
 *
 * PURE: it combines three reads the route makes and does no I/O, so the funnel
 * arithmetic is testable on its own.
 *   - paywall counts (`host/paywallFunnel` — impressions, clicks, refusals, and
 *     the server-written ledger metrics: checkouts started / completed / demo and
 *     bundle grants started / ended, per UTC day of the event);
 *   - the checkout ledger (`listCheckoutsSince` — started / completed) for the
 *     rows written BEFORE those counts existed (a row marked `startedCounted` /
 *     `completedCounted` is already in the counts and is skipped here, so the
 *     cutover is exact per row and nothing counts twice);
 *   - live entitlements (`countActiveEntitlements` — a snapshot, not windowed).
 *
 * Honesty rules the shape encodes:
 *   - a rate is `null` when its denominator is 0, never 0% or 100%;
 *   - demo-mode checkouts (no Stripe key) are reported apart and never counted as
 *     started, since they can never complete;
 *   - `refusedTenants` sits beside `refusals`: a daemon re-checking one tenant
 *     every tick inflates the second, never the first.
 */
import { isLedgerMetric, type PaywallCountRow } from '../../host/paywallFunnel.js';
import type { CheckoutFunnelRow } from './billingService.js';

interface Triple { impressions: number; clicks: number; refusals: number }
export interface FunnelFeatureRow extends Triple {
  featureId: string;
  bundleId: string | null;
  refusedTenants: number;
  surfaces: Record<string, Triple>;
}
export interface FunnelBundleRow extends Triple {
  bundleId: string;
  refusedTenants: number;
  checkoutsStarted: number;
  checkoutsCompleted: number;
  activeGrants: number;
  /** Grants that became entitled / reached a terminal status in the window
   *  (counted going forward from the funnel digest; there is no older history). */
  grantsStarted: number;
  grantsEnded: number;
  /** clicks ÷ impressions. */
  clickThroughRate: number | null;
  /** completed ÷ started (live checkouts). */
  checkoutCompletionRate: number | null;
}
export interface FunnelCheckoutRow { product: string; kind: string; started: number; completed: number; demoStarted: number }
export interface FunnelReport {
  days: number;
  since: string;
  until: string;
  features: FunnelFeatureRow[];
  bundles: FunnelBundleRow[];
  checkouts: FunnelCheckoutRow[];
  plans: Array<{ tier: string; active: number; checkoutsStarted: number; checkoutsCompleted: number }>;
  totals: Triple & { checkoutsStarted: number; checkoutsCompleted: number; demoCheckouts: number; grantsStarted: number; grantsEnded: number };
}

/** n ÷ d to 4 places, or null when there is nothing to divide by. */
export function rate(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null;
}

const add = (t: Triple, metric: PaywallCountRow['metric'], n: number): void => {
  if (metric === 'impression') t.impressions += n;
  else if (metric === 'click') t.clicks += n;
  else t.refusals += n;
};
const zero = (): Triple => ({ impressions: 0, clicks: 0, refusals: 0 });

export function buildFunnelReport(input: {
  days: number;
  since: string;
  until: string;
  counts: readonly PaywallCountRow[];
  checkouts: readonly CheckoutFunnelRow[];
  active: { bundles: Record<string, number>; plans: Record<string, number> };
}): FunnelReport {
  const features = new Map<string, FunnelFeatureRow & { tenants: Set<string> }>();
  for (const r of input.counts) {
    if (isLedgerMetric(r.metric)) continue; // checkouts + grants, below
    let f = features.get(r.featureId);
    if (!f) {
      f = { featureId: r.featureId, bundleId: r.bundleId || null, ...zero(), refusedTenants: 0, surfaces: {}, tenants: new Set() };
      features.set(r.featureId, f);
    }
    add(f, r.metric, r.count);
    add((f.surfaces[r.surface] ??= zero()), r.metric, r.count);
    if (r.metric === 'refusal' && r.count > 0) f.tenants.add(r.tenantId);
  }

  const bundles = new Map<string, FunnelBundleRow & { tenants: Set<string> }>();
  const bundle = (id: string): FunnelBundleRow & { tenants: Set<string> } => {
    let b = bundles.get(id);
    if (!b) {
      b = { bundleId: id, ...zero(), refusedTenants: 0, checkoutsStarted: 0, checkoutsCompleted: 0, activeGrants: 0, grantsStarted: 0, grantsEnded: 0, clickThroughRate: null, checkoutCompletionRate: null, tenants: new Set() };
      bundles.set(id, b);
    }
    return b;
  };
  for (const f of features.values()) {
    if (!f.bundleId) continue;
    const b = bundle(f.bundleId);
    b.impressions += f.impressions; b.clicks += f.clicks; b.refusals += f.refusals;
    for (const t of f.tenants) b.tenants.add(t);
  }

  const checkouts = new Map<string, FunnelCheckoutRow>();
  const plans = new Map<string, { tier: string; active: number; checkoutsStarted: number; checkoutsCompleted: number }>();
  const plan = (tier: string) => {
    let p = plans.get(tier);
    if (!p) { p = { tier, active: 0, checkoutsStarted: 0, checkoutsCompleted: 0 }; plans.set(tier, p); }
    return p;
  };
  let demoCheckouts = 0;
  const product = (key: string, kind: string): FunnelCheckoutRow => {
    let row = checkouts.get(key);
    if (!row) { row = { product: key, kind, started: 0, completed: 0, demoStarted: 0 }; checkouts.set(key, row); }
    return row;
  };
  /** Add `started` / `completed` to the product's bundle or plan row. */
  const credit = (key: string, started: number, completed: number): void => {
    const [kind, id] = key.split(':', 2) as [string, string | undefined];
    if (!id || id === 'unknown') return;
    if (kind === 'bundle') { const b = bundle(id); b.checkoutsStarted += started; b.checkoutsCompleted += completed; }
    else if (kind === 'plan') { const p = plan(id); p.checkoutsStarted += started; p.checkoutsCompleted += completed; }
  };
  // (a) the ledger, for rows the counts do not already hold
  for (const c of input.checkouts) {
    const startHere = !c.startedCounted;
    const doneHere = Boolean(c.fulfilledAt) && !c.completedCounted && c.mode !== 'demo';
    if (!startHere && !doneHere) continue;
    const row = product(c.product, c.kind);
    if (c.mode === 'demo') { row.demoStarted += 1; demoCheckouts += 1; continue; }
    const s = startHere ? 1 : 0;
    const d = doneHere ? 1 : 0;
    row.started += s; row.completed += d;
    credit(c.product, s, d);
  }
  // (b) the daily counts
  const KIND_OF: Record<string, string> = { plan: 'plan', bundle: 'bundle', pack: 'token-pack' };
  for (const r of input.counts) {
    if (!isLedgerMetric(r.metric) || !r.product) continue;
    if (r.metric === 'grant-started' || r.metric === 'grant-ended') {
      if (!r.bundleId) continue;
      const b = bundle(r.bundleId);
      if (r.metric === 'grant-started') b.grantsStarted += r.count; else b.grantsEnded += r.count;
      continue;
    }
    const row = product(r.product, KIND_OF[r.product.split(':', 1)[0]!] ?? 'unknown');
    if (r.metric === 'checkout-demo') { row.demoStarted += r.count; demoCheckouts += r.count; continue; }
    const s = r.metric === 'checkout-started' ? r.count : 0;
    const d = r.metric === 'checkout-completed' ? r.count : 0;
    row.started += s; row.completed += d;
    credit(r.product, s, d);
  }
  for (const [id, n] of Object.entries(input.active.bundles)) bundle(id).activeGrants = n;
  for (const [tier, n] of Object.entries(input.active.plans)) plan(tier).active = n;

  const featureRows: FunnelFeatureRow[] = [...features.values()]
    .map(({ tenants, ...f }) => ({ ...f, refusedTenants: tenants.size }))
    .sort((a, b) => (b.impressions + b.refusals) - (a.impressions + a.refusals) || a.featureId.localeCompare(b.featureId));
  const bundleRows: FunnelBundleRow[] = [...bundles.values()]
    .map(({ tenants, ...b }) => ({
      ...b,
      refusedTenants: tenants.size,
      clickThroughRate: rate(b.clicks, b.impressions),
      checkoutCompletionRate: rate(b.checkoutsCompleted, b.checkoutsStarted),
    }))
    .sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  const checkoutRows = [...checkouts.values()].sort((a, b) => a.product.localeCompare(b.product));

  const totals = { ...zero(), checkoutsStarted: 0, checkoutsCompleted: 0, demoCheckouts, grantsStarted: 0, grantsEnded: 0 };
  for (const f of featureRows) { totals.impressions += f.impressions; totals.clicks += f.clicks; totals.refusals += f.refusals; }
  for (const c of checkoutRows) { totals.checkoutsStarted += c.started; totals.checkoutsCompleted += c.completed; }
  for (const b of bundleRows) { totals.grantsStarted += b.grantsStarted; totals.grantsEnded += b.grantsEnded; }

  return {
    days: input.days, since: input.since, until: input.until,
    features: featureRows, bundles: bundleRows, checkouts: checkoutRows,
    plans: [...plans.values()].sort((a, b) => a.tier.localeCompare(b.tier)),
    totals,
  };
}
