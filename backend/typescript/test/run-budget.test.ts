/**
 * Autonomous-run budget guardrail (host/runBudgetService.ts) +
 * its enforcement in the scheduler daemon.
 *
 *   - allows runs up to the limit, denies past it (atomic counter)
 *   - per-tenant isolation; window rollover resets the count
 *   - limit <= 0 ⇒ unlimited
 *   - scheduleDaemon drops over-budget fires but still advances nextFireAt
 *     (the schedule resumes next window — it cannot run away), while a
 *     within-budget tenant's job in the SAME pass still fires (positive control:
 *     `fired === 0` alone is also what a pass that fired nothing for any other
 *     reason returns)
 *
 * Breaks it (round-1 probes, witnessed): the `<=` limit compare (8fw2g2-rb-limit),
 * the limit<=0 short-circuit (rb-unlimited), the per-tenant scope key
 * (rb-scope), the window start (rb-window), the prune's deep-row growth and
 * live-row leak (rb-prune-growth, rb-prune-leak), the daemon's budget branch
 * (rb-daemon). The `deep:` bucket prefix needs a fixture where the two bucket
 * shapes COLLIDE without it — autonomous tenant `X:Y` vs deep (tenant X, room Y);
 * round 1 used tenant = room = 't-share', whose buckets differ anyway
 * (8fw2g2-rb-namespace VACUOUS) — fixed, re-probed as rb-namespace-r2.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerJob, getJob, resetScheduling } from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { checkAutonomousRunBudget, checkDeepInvestigationBudget, pruneRunBudget, type RunBudgetConfig } from '../src/host/runBudgetService.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};
const CFG: RunBudgetConfig = { limit: 3, windowMs: 3_600_000 };

let storage: Storage;
let deps: StartRunDeps;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await resetScheduling();
  deps = { storage, hostSuite };
});
afterEach(() => __resetHostExtPersistence());

describe('checkAutonomousRunBudget', () => {
  it('allows up to the limit then denies', async () => {
    const now = Date.parse('2026-06-02T12:00:00Z');
    const r = [];
    for (let i = 0; i < 5; i++) r.push((await checkAutonomousRunBudget(storage, 't1', now, CFG)).allowed);
    expect(r).toEqual([true, true, true, false, false]); // 3 allowed, rest denied
  });

  it('is per-tenant', async () => {
    const now = Date.parse('2026-06-02T12:00:00Z');
    for (let i = 0; i < 3; i++) await checkAutonomousRunBudget(storage, 't1', now, CFG);
    expect((await checkAutonomousRunBudget(storage, 't1', now, CFG)).allowed).toBe(false);
    expect((await checkAutonomousRunBudget(storage, 't2', now, CFG)).allowed).toBe(true); // fresh tenant
  });

  it('resets when the window rolls over', async () => {
    const w1 = Date.parse('2026-06-02T12:00:00Z');
    for (let i = 0; i < 3; i++) await checkAutonomousRunBudget(storage, 't1', w1, CFG);
    expect((await checkAutonomousRunBudget(storage, 't1', w1, CFG)).allowed).toBe(false);
    const w2 = w1 + CFG.windowMs; // next window
    expect((await checkAutonomousRunBudget(storage, 't1', w2, CFG)).allowed).toBe(true);
  });

  it('limit <= 0 means unlimited (no counter touched)', async () => {
    const now = Date.parse('2026-06-02T12:00:00Z');
    for (let i = 0; i < 100; i++) {
      expect((await checkAutonomousRunBudget(storage, 't1', now, { limit: 0, windowMs: CFG.windowMs })).allowed).toBe(true);
    }
    // No counter touched: the FIRST metered check in the same window reads 1, not 101.
    const metered = await checkAutonomousRunBudget(storage, 't1', now, { limit: 1, windowMs: CFG.windowMs });
    expect(metered).toEqual({ allowed: true, current: 1, limit: 1 });
  });
});

describe('scheduleDaemon honors the run budget', () => {
  it('drops over-budget fires but keeps advancing nextFireAt', async () => {
    // Pre-consume the tenant's whole budget so the schedule's fire is denied.
    const now = Date.parse('2026-06-02T11:00:30Z');
    for (let i = 0; i < CFG.limit; i++) await checkAutonomousRunBudget(storage, 't1', now, CFG);

    await registerJob({ jobId: 'j', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' },
      Date.parse('2026-06-02T10:15:00Z'));
    // Positive control in the SAME pass: a tenant with budget left still fires.
    await registerJob({ jobId: 'j2', tenantId: 't2', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' },
      Date.parse('2026-06-02T10:15:00Z'));
    const before = (await getJob('j'))!.nextFireAt!;

    // Env limit defaults to 120, so the daemon's own check would allow it — but
    // the tenant is already at the CFG limit of 3 via the pre-consume above only
    // if the daemon uses the same default. Set the env limit to 3 for this pass.
    const priorLimit = process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT;
    process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT = '3';
    let fired: number;
    try {
      fired = await processDueSchedules(deps, now);
    } finally {
      if (priorLimit === undefined) delete process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT;
      else process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT = priorLimit;
    }

    expect(fired).toBe(1); // only j2 — j was dropped over budget
    const j = (await getJob('j'))!;
    expect(j.lastSkipReason).toBe('budget');
    expect(j.lastRunId).toBeUndefined();
    const j2 = (await getJob('j2'))!;
    expect(typeof j2.lastRunId).toBe('string');
    expect(j2.lastSkipReason).toBeUndefined();
    const after = j.nextFireAt!;
    expect(after).toBeGreaterThan(now); // advanced anyway — no wedge, resumes next window
    expect(after).toBeGreaterThan(before);
  });
});

/**
 * XCH-GRP-3 — the deep-investigation budget (per ROOM, per window) sharing the
 * same atomic `run_budget` counter, plus the two bugs the shared table creates
 * for `pruneRunBudget` (which the autonomous budget alone never exposed).
 */
describe('deep-investigation budget (XCH-GRP-3)', () => {
  const DEEP: RunBudgetConfig = { limit: 2, windowMs: 3_600_000 };
  const NOW = Date.parse('2026-06-02T12:00:00Z'); // fixed epoch, not the wall clock

  it('allows up to the limit per ROOM, then denies — and rooms are isolated', async () => {
    const now = NOW;
    for (const n of [1, 2]) {
      const d = await checkDeepInvestigationBudget(storage, 't1', 'room-a', now, DEEP);
      expect(d.allowed, `deep run ${n} should be allowed`).toBe(true);
    }
    expect((await checkDeepInvestigationBudget(storage, 't1', 'room-a', now, DEEP)).allowed).toBe(false);
    // A DIFFERENT room in the same tenant is unaffected — the burst this guards
    // is a mention-storm in ONE room, not tenant-wide activity.
    expect((await checkDeepInvestigationBudget(storage, 't1', 'room-b', now, DEEP)).allowed).toBe(true);
    // And a different tenant's same-named room is its own bucket.
    expect((await checkDeepInvestigationBudget(storage, 't2', 'room-a', now, DEEP)).allowed).toBe(true);
  });

  it('does NOT share a counter with the autonomous budget (bucket namespacing)', async () => {
    const now = NOW;
    const cfg: RunBudgetConfig = { limit: 1, windowMs: 3_600_000 };
    // The colliding shape: an autonomous scope `t-share:room-x` and a deep scope
    // (tenant `t-share`, room `room-x`) render the SAME `<scope>:<windowStart>`
    // bucket unless the `deep:` prefix keeps them apart.
    expect((await checkAutonomousRunBudget(storage, 't-share:room-x', now, cfg)).allowed).toBe(true);
    expect((await checkAutonomousRunBudget(storage, 't-share:room-x', now, cfg)).allowed).toBe(false);
    // …the deep budget for that room must be untouched (its first spend reads 1).
    expect(await checkDeepInvestigationBudget(storage, 't-share', 'room-x', now, cfg)).toEqual({ allowed: true, current: 1, limit: 1 });
  });

  it('window rollover resets the room count', async () => {
    const now = NOW;
    for (const _ of [1, 2]) await checkDeepInvestigationBudget(storage, 't1', 'room-r', now, DEEP);
    expect((await checkDeepInvestigationBudget(storage, 't1', 'room-r', now, DEEP)).allowed).toBe(false);
    expect((await checkDeepInvestigationBudget(storage, 't1', 'room-r', now + DEEP.windowMs, DEEP)).allowed).toBe(true);
  });

  it('limit <= 0 ⇒ unlimited (the env convention) and consumes nothing', async () => {
    const now = NOW;
    const off: RunBudgetConfig = { limit: 0, windowMs: 3_600_000 };
    for (const _ of [1, 2, 3, 4]) {
      expect((await checkDeepInvestigationBudget(storage, 't1', 'room-off', now, off)).allowed).toBe(true);
    }
    // Consumed nothing: the first metered deep check for that room reads 1, not 5.
    expect(await checkDeepInvestigationBudget(storage, 't1', 'room-off', now, { limit: 1, windowMs: 3_600_000 }))
      .toEqual({ allowed: true, current: 1, limit: 1 });
  });

  // ── pruneRunBudget: the two bugs the SHARED table introduces ──
  it('prunes deep rows even when the AUTONOMOUS cap is disabled (no unbounded growth)', async () => {
    const now = 10 * 3_600_000;
    const autoOff: RunBudgetConfig = { limit: 0, windowMs: 3_600_000 };
    // A deep row in an OLD window.
    await checkDeepInvestigationBudget(storage, 't1', 'room-old', now - 3_600_000, DEEP);
    // Pre-fix this returned 0 immediately (autonomous limit <= 0), leaving deep
    // rows to accumulate forever.
    const pruned = await pruneRunBudget(storage, now, autoOff, DEEP);
    expect(pruned).toBe(1); // exactly the one old deep row
  });

  it('never prunes a LIVE deep row when the deep window is longer than the autonomous one', async () => {
    const now = 10 * 3_600_000 + 60_000; // just past an hour boundary
    const auto: RunBudgetConfig = { limit: 5, windowMs: 3_600_000 };       // 1h
    const deepLong: RunBudgetConfig = { limit: 2, windowMs: 24 * 3_600_000 }; // 24h
    // Spend the room's deep budget in the CURRENT (24h) window.
    await checkDeepInvestigationBudget(storage, 't1', 'room-long', now, deepLong);
    await checkDeepInvestigationBudget(storage, 't1', 'room-long', now, deepLong);
    expect((await checkDeepInvestigationBudget(storage, 't1', 'room-long', now, deepLong)).allowed).toBe(false);
    // Pruning at the AUTONOMOUS (1h) boundary would delete the live 24h row and
    // silently reset the counter — a budget that never enforces.
    await pruneRunBudget(storage, now, auto, deepLong);
    expect(
      (await checkDeepInvestigationBudget(storage, 't1', 'room-long', now, deepLong)).allowed,
      'the live deep row must survive the prune',
    ).toBe(false);
  });
});
