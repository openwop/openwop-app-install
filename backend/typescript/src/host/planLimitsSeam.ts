/**
 * Plan-limit seam (ADR 0821 D2/D6) — how core reads a tenant's plan LIMITS without
 * importing the billing feature (ADR 0001: core must not depend on a feature).
 *
 * The billing feature REGISTERS a resolver at boot (the same inversion as
 * `host/managedBalanceHook.ts` and `host/entitlementSeam.ts`). Core enforcement
 * sites read one key at a time through `resolvePlanLimit`:
 *
 *   - `workflowRuns`     → `host/runStarter.ts` (`host/planRunLimit.ts`), monthly per tenant;
 *   - `aiCreditsMonthly` → `providers/managedProvider.ts` (`host/managedCredits.ts`);
 *   - `kicktodo.maxActiveEnrollments` → `features/kicktodo-commerce/tierGuard.ts`
 *     (pre-existing; it reads billing directly because it is itself a feature).
 *
 * `ENFORCED_PLAN_LIMIT_KEYS` is the list of keys that HAVE an enforcement site.
 * The public pricing page and the entitlements route filter limits through
 * `displayablePlanLimits`, so the product can never advertise a limit nobody
 * enforces (ADR 0821 D6; ratchet: `test/adr0821-displayed-limits-ratchet.test.ts`).
 *
 * `OPENWOP_BILLING_EXEMPT_TENANTS` (ADR 0821 architect #1) names operator-service
 * tenants (conformance, showcase) that are exempt from LIMITS AND CREDITS ONLY.
 * It is read by the limit/credit enforcement sites and NEVER by the feature
 * paywall (`features/billing/entitlementGuard.ts`): a service tenant must not
 * become a free-everything backdoor.
 */

/** The plan-limit keys that have an enforcement site somewhere in the host. */
export const PLAN_LIMIT_WORKFLOW_RUNS = 'workflowRuns';
export const PLAN_LIMIT_AI_CREDITS_MONTHLY = 'aiCreditsMonthly';
export const PLAN_LIMIT_KICKTODO_ENROLLMENTS = 'kicktodo.maxActiveEnrollments';

export const ENFORCED_PLAN_LIMIT_KEYS: readonly string[] = [
  PLAN_LIMIT_WORKFLOW_RUNS,
  PLAN_LIMIT_AI_CREDITS_MONTHLY,
  PLAN_LIMIT_KICKTODO_ENROLLMENTS,
];

/** Returns the tenant's plan limits (`{}` = none configured / billing off). */
export type PlanLimitsResolver = (tenantId: string) => Promise<Record<string, number>>;

let resolver: PlanLimitsResolver | null = null;

/** Wire the plan-limits resolver (billing feature, at boot). Last wins. */
export function registerPlanLimitsResolver(fn: PlanLimitsResolver | null): void {
  resolver = fn;
}

/**
 * One plan limit for a tenant, or `null` when none is configured (billing off,
 * superadmin tenant, unset key, or no resolver wired). FAIL-OPEN on a read
 * error, the same posture as `workflowBudgetExhausted`: a limit read must never
 * be why a paying tenant's run fails. Callers decide what `null` means: for a
 * CAP it is "unlimited", for an ALLOWANCE it is "zero".
 */
export async function resolvePlanLimit(tenantId: string, key: string): Promise<number | null> {
  if (!resolver) return null;
  try {
    const limits = await resolver(tenantId);
    const v = limits[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * `OPENWOP_BILLING_EXEMPT_TENANTS` — a JSON array (`["conformance-prod"]`) or a
 * comma list. EXACT tenant-id match: these are operator-named service tenants,
 * and a prefix match would let a tenant id minted from user input inherit the
 * exemption.
 */
export function billingExemptTenants(): string[] {
  const raw = process.env.OPENWOP_BILLING_EXEMPT_TENANTS?.trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
    } catch {
      return [];
    }
  }
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** True iff the tenant is exempt from plan LIMITS and AI CREDITS (never the paywall).
 *
 *  ADR 0877 Q3 (user decision 2026-10-12): this list is NOT read by commerce
 *  platform settlement. Exempting a tenant from limits never lets its storefront
 *  take live money on the operator's Stripe account — that is the explicit
 *  `OPENWOP_COMMERCE_PLATFORM_TENANTS` list (`commerce-connect/storefrontSettlement.ts`). */
export function isBillingExemptTenant(tenantId: string): boolean {
  return billingExemptTenants().includes(tenantId);
}

/** Only the limit keys that have an enforcement site (ADR 0821 D6 display rule). */
export function displayablePlanLimits(limits: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(limits)) if (ENFORCED_PLAN_LIMIT_KEYS.includes(k)) out[k] = v;
  return out;
}
