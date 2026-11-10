/**
 * ADR 0987 D5 / Q2 (P3) — the monthly plan limit's failure posture follows the
 * ADR 0981 profile.
 *
 * WHY. `reservePlanRun` failed OPEN on both a counter error and sustained
 * compare-and-swap contention, so under either a limited tenant's run started
 * uncounted. The user accepted Q2: the limit is shown on the pricing page as a
 * limit, so where tenants pay (the strict `auth` profile) it fails CLOSED, and it
 * stays open under the evaluation profiles (the public demo, dev, tests).
 *
 * Pins, each under both profiles:
 *   - a counter READ error: strict → 503 `plan_run_limit_unavailable`;
 *     evaluation → the run is admitted uncounted (today's posture);
 *   - sustained CAS contention: strict → 429 `plan_run_limit_contention`;
 *     evaluation → admitted uncounted;
 *   - the healthy path is unchanged under strict (positive control), and a tenant
 *     with no limit never touches the counter, so a broken store cannot refuse it.
 *
 * Sabotage witnesses (probes w80g3-pp-*, 2026-11-03; each reds only its case):
 * strict falls back to open on a counter error or on contention; evaluation
 * fails closed on either; the no-limit short-circuit is skipped; the healthy
 * CAS stops counting. The evaluation cases assert the counter was actually
 * read (or contended, with retries), so they cannot pass on a short-circuit.
 * "Nothing is counted" under contention holds by construction (the spy refuses
 * every counter CAS); it guards against a future non-CAS write path.
 * Every case reads and reserves with one `at`, so a UTC month boundary cannot
 * split the counter key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerPlanLimitsResolver } from '../src/host/planLimitsSeam.js';
import { planRunsThisMonth, reservePlanRun } from '../src/host/planRunLimit.js';
import { billingPlanLimitsResolver } from '../src/features/billing/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'billing', label: 'Billing', description: 'b', status: 'on', bucketUnit: 'tenant', salt: 'billing' });
  registerPlanLimitsResolver(billingPlanLimitsResolver);
  vi.stubEnv('OPENWOP_BILLING_PLAN_LIMITS', JSON.stringify({ free: { workflowRuns: 5 } }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  registerPlanLimitsResolver(null);
  __resetHostExtPersistence();
});

const strict = () => vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
const evaluation = () => vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'cookie-per-visitor');
/** Fault only the plan's month counter (`runs:plan-month-count`): every other
 *  collection, including the billing state the limit resolves from, keeps working. */
const COUNTER = 'runs:plan-month-count';
const isCounter = (c: unknown): boolean => (c as { name?: string }).name === COUNTER;
function breakReads() {
  const real = DurableCollection.prototype.get;
  const counterReads = vi.fn();
  vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(function (this: DurableCollection<unknown>, id: string) {
    if (!isCounter(this)) return real.call(this, id);
    counterReads();
    return Promise.reject(new Error('connection reset'));
  });
  return counterReads;
}
function contend(): { counterSwaps: () => number } {
  const real = DurableCollection.prototype.compareAndSwap;
  let n = 0;
  vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(function (this: DurableCollection<unknown>, a: unknown, b: unknown) {
    if (!isCounter(this)) return real.call(this, a, b);
    n += 1;
    return Promise.resolve(false);
  });
  return { counterSwaps: () => n };
}

describe('ADR 0987 D5 — the plan limit fails closed under the strict profile', () => {
  it('positive control: the healthy path counts under strict', async () => {
    strict();
    const at = new Date();
    await reservePlanRun('t-ok', at);
    expect(await planRunsThisMonth('t-ok', at)).toBe(1);
  });

  it('a counter error is a 503 plan_run_limit_unavailable under strict', async () => {
    strict();
    breakReads();
    await expect(reservePlanRun('t-err')).rejects.toMatchObject({ httpStatus: 503, details: { reason: 'plan_run_limit_unavailable' } });
  });

  it('sustained contention is a 429 plan_run_limit_contention under strict, and nothing is counted', async () => {
    strict();
    const at = new Date();
    const cas = contend();
    await expect(reservePlanRun('t-cas', at)).rejects.toMatchObject({ httpStatus: 429, details: { reason: 'plan_run_limit_contention' } });
    expect(cas.counterSwaps()).toBeGreaterThan(1);
    vi.restoreAllMocks();
    expect(await planRunsThisMonth('t-cas', at)).toBe(0);
  });

  it('a tenant with no limit never reads the counter, so a broken store cannot refuse it', async () => {
    strict();
    vi.stubEnv('OPENWOP_BILLING_PLAN_LIMITS', JSON.stringify({}));
    const reads = breakReads();
    await expect(reservePlanRun('t-free')).resolves.toBeDefined();
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('ADR 0987 D5 — the plan limit stays open under the evaluation profile', () => {
  it('a counter error admits the run uncounted', async () => {
    evaluation();
    const at = new Date();
    const reads = breakReads();
    await expect(reservePlanRun('t-err-e', at)).resolves.toBeDefined();
    // The error path was reached: the counter was read, not short-circuited.
    expect(reads).toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await planRunsThisMonth('t-err-e', at)).toBe(0);
  });

  it('sustained contention admits the run uncounted', async () => {
    evaluation();
    const at = new Date();
    const cas = contend();
    await expect(reservePlanRun('t-cas-e', at)).resolves.toBeDefined();
    // The retry loop ran against the counter before admitting uncounted.
    expect(cas.counterSwaps()).toBeGreaterThan(1);
    vi.restoreAllMocks();
    expect(await planRunsThisMonth('t-cas-e', at)).toBe(0);
  });
});
