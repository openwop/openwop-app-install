/**
 * ADR 0821 D6 (+ architect #1) / P5 — the plan's MONTHLY workflow-run limit,
 * enforced durably at run start.
 *
 * `limits.workflowRuns` (OPENWOP_BILLING_PLAN_LIMITS.<plan>.workflowRuns) was
 * displayed on the pricing page and enforced nowhere. It is now counted per
 * tenant per UTC month in a DurableCollection (NOT the per-instance in-memory
 * quota maps of `middleware/rateLimit.ts`, which reset on deploy and are not
 * shared across instances).
 *
 * WHAT COUNTS. One unit per NEW run created through `host/runStarter.ts`
 * `startWorkflowRun` (schedules, heartbeats, triggers routed through it, agent
 * dispatch, approved proposals, …):
 *   - a REPLAY never counts — re-presenting a deterministic run id resolves to the
 *     existing run before the check, and a re-fired start inside a replay fork is
 *     refused by `assertEffectAllowed` before it;
 *   - a FORK is a new run and counts — but forks are created by `POST
 *     /v1/runs/:id:fork` (`routes/runs.ts`), which does not route through
 *     `startWorkflowRun`; enforcing there is the inventoried follow-up (ADR 0821 P5);
 *   - a REFUSED launch never counts — the check runs AFTER the launch definition
 *     resolves (`resolveLaunchWorkflow`), after the approve-what-you-see hash
 *     check and after the workflow-budget hard cap, and a failed insert releases
 *     its reservation.
 *
 * Only counted while a limit is configured for the tenant: with no limit there is
 * nothing to enforce and no write on the run-start path (today's behaviour). A
 * limit introduced mid-month therefore counts from that point.
 *
 * `OPENWOP_BILLING_EXEMPT_TENANTS` (conformance, showcase) are exempt from this
 * limit — and ONLY from limits and credits; the feature paywall never reads it.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { isBillingExemptTenant, PLAN_LIMIT_WORKFLOW_RUNS, resolvePlanLimit } from './planLimitsSeam.js';

const log = createLogger('host.planRunLimit');

interface RunMonthCount {
  tenantId: string;
  /** UTC month, YYYY-MM. */
  month: string;
  runs: number;
  updatedAt: string;
}

const runMonths = new DurableCollection<RunMonthCount>(
  'runs:plan-month-count',
  (r) => `${r.tenantId}:${r.month}`,
  undefined,
  (r) => r.tenantId,
);

const CAS_ATTEMPTS = 8;

/** A reservation the caller releases if the run it was taken for never lands. */
export interface PlanRunReservation { release: () => Promise<void> }

const NOOP: PlanRunReservation = { release: async () => undefined };

/**
 * Reserve one run against the tenant's monthly plan limit, or throw a typed 429
 * `plan_run_limit_reached`. A no-op (nothing counted) when the tenant is exempt
 * or has no limit. FAIL-OPEN on a counter read/write error, the same posture as
 * `workflowBudgetExhausted`: a ledger hiccup must not stop a paying tenant's run.
 */
export async function reservePlanRun(tenantId: string, at: Date = new Date()): Promise<PlanRunReservation> {
  if (isBillingExemptTenant(tenantId)) return NOOP;
  const limit = await resolvePlanLimit(tenantId, PLAN_LIMIT_WORKFLOW_RUNS);
  if (limit === null) return NOOP;
  const month = at.toISOString().slice(0, 7);
  const key = `${tenantId}:${month}`;
  try {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, Math.random() * 25));
      const existing = (await runMonths.get(key)) ?? null;
      const runs = existing?.runs ?? 0;
      if (runs >= limit) {
        throw new OpenwopError(
          'rate_limited',
          `Your plan allows ${limit} workflow run${limit === 1 ? '' : 's'} per month, and this month's are used. Runs resume on the 1st (UTC), or upgrade your plan.`,
          429,
          { reason: 'plan_run_limit_reached', limit, month },
        );
      }
      const next: RunMonthCount = { tenantId, month, runs: runs + 1, updatedAt: at.toISOString() };
      if (await runMonths.compareAndSwap(existing, next)) return { release: () => releasePlanRun(key) };
    }
    log.warn('plan_run_limit_contention', { key, attempts: CAS_ATTEMPTS });
    return NOOP;
  } catch (err) {
    if (err instanceof OpenwopError) throw err;
    log.warn('plan_run_limit_unavailable', { tenantId, error: err instanceof Error ? err.message : String(err) });
    return NOOP;
  }
}

async function releasePlanRun(key: string): Promise<void> {
  try {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const existing = await runMonths.get(key);
      if (!existing || existing.runs <= 0) return;
      if (await runMonths.compareAndSwap(existing, { ...existing, runs: existing.runs - 1, updatedAt: new Date().toISOString() })) return;
    }
  } catch { /* best-effort compensation */ }
}

/** This month's counted runs for a tenant (0 when none were counted). */
export async function planRunsThisMonth(tenantId: string, at: Date = new Date()): Promise<number> {
  return (await runMonths.get(`${tenantId}:${at.toISOString().slice(0, 7)}`))?.runs ?? 0;
}
