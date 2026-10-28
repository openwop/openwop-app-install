/**
 * ADR 0821 D6 — RATCHET: the pricing page and the entitlements route may only
 * display plan-limit keys that have an ENFORCEMENT SITE.
 *
 * Before ADR 0821, `limits.workflowRuns` (the example in the config doc) was
 * shown on `/public/pricing` and enforced nowhere. Two halves:
 *
 *   1. BEHAVIOUR — a configured key with no enforcement site (`seats`) is
 *      filtered out of `/public/pricing` and of `GET …/billing/entitlements`,
 *      while every enforced key survives (positive control).
 *   2. SOURCE — every key in `ENFORCED_PLAN_LIMIT_KEYS` names a file that
 *      actually reads it, so adding a key to the list without enforcing it
 *      fails here. Adding an enforcement site = add its key AND its row below.
 *
 * Tracker TST-BUL-1. Sabotage-witnessed (w62): red when `publicPricingCatalog`
 * or `displayablePlanLimits` stops filtering, when the entitlements route drops
 * the helper, when a key joins ENFORCED_PLAN_LIMIT_KEYS without a site, or when
 * an enforcement site stops reading its key.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  displayablePlanLimits, ENFORCED_PLAN_LIMIT_KEYS, PLAN_LIMIT_AI_CREDITS_MONTHLY, PLAN_LIMIT_KICKTODO_ENROLLMENTS, PLAN_LIMIT_WORKFLOW_RUNS,
} from '../src/host/planLimitsSeam.js';
import { publicPricingCatalog } from '../src/features/billing/billingService.js';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** key → [enforcing file, the token that proves the file reads THAT key]. */
const ENFORCEMENT_SITES: Record<string, [string, string]> = {
  [PLAN_LIMIT_WORKFLOW_RUNS]: ['host/planRunLimit.ts', 'resolvePlanLimit(tenantId, PLAN_LIMIT_WORKFLOW_RUNS)'],
  [PLAN_LIMIT_AI_CREDITS_MONTHLY]: ['host/managedCredits.ts', 'resolvePlanLimit(tenantId, PLAN_LIMIT_AI_CREDITS_MONTHLY)'],
  [PLAN_LIMIT_KICKTODO_ENROLLMENTS]: ['features/kicktodo-commerce/tierGuard.ts', `'${PLAN_LIMIT_KICKTODO_ENROLLMENTS}'`],
};

afterEach(() => { delete process.env.OPENWOP_BILLING_PLAN_LIMITS; });

describe('ADR 0821 D6 — displayed limits ⊆ enforced limits', () => {
  it('/public/pricing drops an unenforced key and keeps every enforced one', () => {
    process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ pro: { workflowRuns: 1000, aiCreditsMonthly: 500, 'kicktodo.maxActiveEnrollments': 3, seats: 10 } });
    const pro = publicPricingCatalog().find((t) => t.tier === 'pro')!;
    expect(pro.limits).toEqual({ workflowRuns: 1000, aiCreditsMonthly: 500, 'kicktodo.maxActiveEnrollments': 3 });
    expect(pro.limits).not.toHaveProperty('seats');
  });

  it('the entitlements route filters through the same helper (source pin) and the helper drops unknown keys', () => {
    const routes = read('features/billing/routes.ts');
    expect(routes).toContain('limits: displayablePlanLimits(ent.limits)');
    expect(displayablePlanLimits({ workflowRuns: 1, seats: 2 })).toEqual({ workflowRuns: 1 });
  });

  it('every enforced key has a named enforcement site that reads it', () => {
    expect([...ENFORCED_PLAN_LIMIT_KEYS].sort()).toEqual(Object.keys(ENFORCEMENT_SITES).sort());
    for (const [key, [file, token]] of Object.entries(ENFORCEMENT_SITES)) {
      expect(read(file), `${key} must be read in ${file}`).toContain(token);
    }
    // The run limit is reached from the ONE run starter.
    expect(read('host/runStarter.ts')).toContain('await reservePlanRun(input.tenantId)');
    // The allowance is reached from the managed provider's free-allowance gate.
    expect(read('providers/managedProvider.ts')).toContain('planAllowanceRemaining(tenantId)');
  });
});
