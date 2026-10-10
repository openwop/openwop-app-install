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
import { registerRunLimitReserver } from '../../host/runLimitSeam.js';
import { reservePlanRun } from '../../host/planRunLimit.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getBalance, drawFromBalance, resolveEntitlements } from './billingService.js';

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
    // ADR 0821 P5 follow-up — the ~10 run-minting sites OUTSIDE `startWorkflowRun`
    // (`POST /v1/runs`, `:fork`, debug, redrive, triggers, kanban, MCP, CRM,
    // workflow-author, creative-briefs) call `host/runLimitSeam.ts` `withRunLimit`,
    // a no-op until this registration. The reserver is the SAME durable counter
    // `startWorkflowRun` calls directly (`host/planRunLimit.ts`), so every new run
    // draws from one monthly count. It inherits that counter's postures: exempt
    // tenants and tenants with no `workflowRuns` limit are a no-op (no write), and
    // each site reserves only after its own refusals, releasing on a failed insert.
    registerRunLimitReserver(reservePlanRun);
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
