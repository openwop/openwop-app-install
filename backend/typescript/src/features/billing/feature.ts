/**
 * Subscriptions & Billing (ADR 0176) — a new feature-package that reverses the
 * roadmap's commerce cut ADDITIVELY. Owns subscription/plan state + the prepaid
 * AI-token balance ledger; drives Stripe host-side (BYOK, demo-mode by default);
 * expresses commercial policy through ONE central entitlement resolver — never by
 * editing individual features. R-1 (the MyndHyve cutover): live mode works day-1
 * against the existing Stripe account (config price catalog + Stripe-id-preserving
 * importer + webhook parity/idempotency). Toggle OFF ⇒ zero behavior change.
 *
 * @see docs/adr/0176-subscriptions-billing.md
 */
import type { BackendFeature } from '../types.js';
import { registerBillingRoutes } from './routes.js';
import { setManagedBalanceProvider } from '../../host/managedBalanceHook.js';
import { registerPlanLimitsResolver } from '../../host/planLimitsSeam.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getBalance, drawFromBalance, resolveEntitlements, warnCheckoutConfigAtBoot } from './billingService.js';

/** ADR 0821 D2/D6 — the plan-limits resolver billing registers into
 *  `host/planLimitsSeam.ts`. Exported so tests exercise the production path. */
export async function billingPlanLimitsResolver(tenantId: string): Promise<Record<string, number>> {
  if (!process.env.OPENWOP_BILLING_PLAN_LIMITS) return {};
  const billing = await resolveOne('billing', { tenantId });
  return (await resolveEntitlements(tenantId, Boolean(billing?.enabled))).limits;
}

export const billingFeature: BackendFeature = {
  id: 'billing',
  registerRoutes: (deps) => {
    registerBillingRoutes(deps);
    // ADR 0176 Phase 2 — wire the prepaid-balance hook so the managed provider draws
    // from balance before the daily cap (dependency inversion; core stays feature-free).
    setManagedBalanceProvider({
      available: async (tenantId) => (await getBalance(tenantId)).totalAvailable,
      draw: (tenantId, tokens) => drawFromBalance(tenantId, tokens),
    });
    // ADR 0821 D2/D6 — core enforcement sites (the managed provider's plan
    // allowance, the run starter's monthly run limit) read plan LIMITS through
    // this seam, never by importing billing. Same resolution as the KickTodo tier
    // guard: billing toggle + the ONE entitlement resolver (superadmin ⇒ `{}`).
    // No limits configured ⇒ `{}` without a subscription read, so the per-call
    // and per-run hot paths cost nothing on an unpriced host.
    registerPlanLimitsResolver(billingPlanLimitsResolver);
    // ADR 0987 D3 — the plan's monthly run limit is charged at the one run-insert
    // seam (`host/runInsert.ts`, `reservePlanRun`), which reads the plan limits
    // through the resolver registered above. There is no second reserver to wire.
    // ADR 0890 — a `managed` checkout on a pinned API version that predates
    // Managed Payments' GA is worth one line in the boot log.
    warnCheckoutConfigAtBoot();
  },
  toggleDefault: {
    id: 'billing',
    label: 'Subscriptions & Billing',
    description:
      'Stripe subscriptions, plan tiers, and a prepaid AI-token balance — host-side (BYOK), demo-mode by default. Plan entitlements resolve through one central resolver; usage limits are governance policy. When off, all features are unrestricted.',
    category: 'Admin',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'billing',
  },
};
