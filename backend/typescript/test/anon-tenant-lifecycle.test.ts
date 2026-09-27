/**
 * ADR 0372 — anon-tenant lifecycle sweep. Pins the contract that makes the
 * teardown safe:
 *  - OFF by default (env unset ⇒ zero teardowns — fail-safe);
 *  - scheduler-fired runs NEVER count as activity (the 2026-07-15
 *    misclassification lesson): a tenant kept "fresh" only by metadata.schedule
 *    runs is abandoned;
 *  - a recent HUMAN run or chat-session update keeps a tenant alive;
 *  - signed-in (`user:*`) tenants are never candidates;
 *  - teardown is complete (runs + kv gone) and tombstoned with an audit row.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { pruneAbandonedAnonTenants } from '../src/host/retentionSweepDaemon.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let storage: Storage;
const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const run = (runId: string, tenantId: string, daysAgo: number, scheduled: boolean): RunRecord => ({
  runId, workflowId: 'wf', tenantId, status: 'completed',
  inputs: {}, configurable: {},
  metadata: scheduled ? { schedule: { jobId: 'j1', source: 'schedule' } } : {},
  createdAt: iso(daysAgo), updatedAt: iso(daysAgo),
});

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

afterEach(() => { delete process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS; });

describe('ADR 0372 — pruneAbandonedAnonTenants', () => {
  it('is OFF by default: env unset ⇒ zero teardowns', async () => {
    await storage.insertRun(run('off-r1', 'anon:off-tenant', 90, false));
    expect(await pruneAbandonedAnonTenants({ storage }, NOW)).toBe(0);
    expect(await storage.getRun('off-r1')).not.toBeNull();
  });

  it('tears down a tenant kept "fresh" ONLY by scheduler-fired runs; keeps human-active ones; never touches user:*', async () => {
    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = '14';
    // Abandoned: old human run, RECENT scheduler runs (the flood shape).
    await storage.insertRun(run('fl-old', 'anon:flood', 60, false));
    await storage.insertRun(run('fl-cron', 'anon:flood', 1, true));
    await storage.kvSet('hostext:kanban:anon-flood-card', JSON.stringify({ id: 'anon-flood-card', tenantId: 'anon:flood' }));
    // Alive: recent human run.
    await storage.insertRun(run('hu-new', 'anon:human', 2, false));
    // Alive: old runs but a recent chat.
    await storage.insertRun(run('ch-old', 'anon:chatter', 60, false));
    await storage.createChatSession({ sessionId: 'cs-1', tenantId: 'anon:chatter', title: 't', createdAt: iso(60), updatedAt: iso(1), messageCount: 3 });
    // Signed-in tenant with ancient runs — out of scope by prefix.
    await storage.insertRun(run('us-old', 'user:abc', 200, false));

    const torn = await pruneAbandonedAnonTenants({ storage }, NOW);
    // 2 = anon:flood + the OFF-test's anon:off-tenant (90d idle — abandoned
    // the moment the env enables; shared store across tests, asserted here).
    expect(torn).toBe(2);
    expect(await storage.getRun('off-r1')).toBeNull();
    expect(await storage.getRun('fl-old')).toBeNull();
    expect(await storage.getRun('fl-cron')).toBeNull();
    expect(await storage.getRun('hu-new')).not.toBeNull();
    expect(await storage.getRun('ch-old')).not.toBeNull();
    expect(await storage.getRun('us-old')).not.toBeNull();
  });

  it('RE-ENTRANCY (RETENTION-DATA-1): a mid-teardown purge failure leaves the tenant re-surfaceable (runs intact)', async () => {
    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = '14';
    await storage.insertRun(run('re-old', 'anon:reentry', 90, false));
    // hostext purge throws → the run-delete (which removes the tenant from the
    // enumerator) must NOT have run, so the tenant re-surfaces next tick.
    const boom = { purgeHostExt: async () => { throw new Error('hostext purge failed'); }, purgeToggleOverrides: async () => undefined, purgeOwnedWorkflowDefs: async () => undefined };
    const torn = await pruneAbandonedAnonTenants({ storage }, NOW, boom);
    expect(torn).toBe(0);                                   // failed teardown not counted
    expect(await storage.getRun('re-old')).not.toBeNull();  // runs intact ⇒ re-surfaceable
    // The retry (purge now succeeds) completes it — proving idempotent recovery.
    const torn2 = await pruneAbandonedAnonTenants({ storage }, NOW, { purgeHostExt: async () => undefined, purgeToggleOverrides: async () => undefined, purgeOwnedWorkflowDefs: async () => undefined });
    expect(torn2).toBe(1);
    expect(await storage.getRun('re-old')).toBeNull();
  });
});

describe('grade-pass DATA-1 — the runless (hostext-anchored) leg', () => {
  // kvSet stamps updated_at with the REAL clock, so staleness is created by
  // moving `now` FORWARD past the retention window instead of back-dating rows.
  const DAYS = 14;
  const FUTURE = () => Date.now() + (DAYS + 1) * DAY;

  /**
   * A FRESH store for this leg — and the reason is a bug that already bit.
   *
   * The describe above back-dates its fixtures against a FIXED clock
   * (`NOW` = 2026-07-15). This one prunes against the REAL clock, because kvSet
   * stamps `updated_at` itself and cannot be back-dated. Sharing one module-level
   * `storage` between them means this leg also sees the other's tenants — and
   * judges them by a clock they were never written for.
   *
   * That is a DATE BOMB, not a flake. `anon:human` is inserted at `iso(2)` =
   * 2026-07-13T12:00Z; the real cutoff is `now - 14d`. On 2026-07-27T12:00Z the
   * two crossed, this leg started sweeping a tenant belonging to another test,
   * and `toBe(0)` became `1` — on a suite that had been green for weeks and with
   * nobody having touched retention. It gets worse every day it is left.
   *
   * Isolating the store fixes the cause rather than the symptom: the alternative
   * (assert on one tenant instead of the count) would keep the cross-describe
   * coupling and lose the "swept NOTHING" guarantee, which is the assertion worth
   * having on a teardown path.
   */
  beforeAll(async () => {
    storage = await openStorage('memory://');
    initHostExtPersistence(storage);
  });

  it('listHostExtTenantActivity enumerates only prefix-matching tenants and survives malformed rows', async () => {
    await storage.kvSet('hostext:roster:anon:hx-a:host:x', JSON.stringify({ rosterId: 'host:x', tenantId: 'anon:hx-a' }));
    await storage.kvSet('hostext:roster:user:hx-b:host:x', JSON.stringify({ rosterId: 'host:x', tenantId: 'user:hx-b' }));
    // Malformed value that still contains the probe substring — must be
    // skipped, never break the query.
    await storage.kvSet('hostext:junk:hx', 'not-json {"tenantId":"anon:hx-junk');
    // F-5 — a TOP-LEVEL tenantId OUTSIDE the purgeable `hostext:` keyspace
    // must NOT anchor (dropping the k-prefix filter reintroduces the H1
    // livelock; this is the row shape that catches it).
    await storage.kvSet('hostsurf:table:hx-ghost', JSON.stringify({ tenantId: 'anon:hx-ghost' }));
    const rows = await storage.listHostExtTenantActivity('anon:', 100);
    const ids = rows.map((r) => r.tenantId);
    expect(ids).toContain('anon:hx-a');
    expect(ids).not.toContain('user:hx-b');
    expect(ids).not.toContain('anon:hx-junk');
    expect(ids).not.toContain('anon:hx-ghost'); // non-hostext keyspace never anchors
    const a = rows.find((r) => r.tenantId === 'anon:hx-a')!;
    expect(typeof a.lastHostExtAt).toBe('string');
  });

  it('keeps a fresh runless tenant; tears down a stale one; chat activity protects', async () => {
    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = String(DAYS);
    await storage.kvSet('hostext:roster:anon:runless-1:host:a', JSON.stringify({ rosterId: 'host:a', tenantId: 'anon:runless-1' }));
    // FRESH relative to the real clock → kept.
    expect(await pruneAbandonedAnonTenants({ storage }, Date.now())).toBe(0);
    expect(await storage.kvGet('hostext:roster:anon:runless-1:host:a')).not.toBeNull();

    // Chat-protected: hostext stale under FUTURE now, but a chat session
    // updated inside the window keeps it.
    await storage.kvSet('hostext:roster:anon:runless-chat:host:b', JSON.stringify({ rosterId: 'host:b', tenantId: 'anon:runless-chat' }));
    const future = FUTURE();
    await storage.createChatSession({
      sessionId: 'cs-runless', tenantId: 'anon:runless-chat', title: 't',
      createdAt: new Date().toISOString(), updatedAt: new Date(future - DAY).toISOString(), messageCount: 1,
    });
    const tornFuture = await pruneAbandonedAnonTenants({ storage }, future);
    // runless-1 (stale, unprotected) is torn; runless-chat survives on chat.
    expect(await storage.kvGet('hostext:roster:anon:runless-1:host:a')).toBeNull();
    expect(await storage.kvGet('hostext:roster:anon:runless-chat:host:b')).not.toBeNull();
    expect(tornFuture).toBeGreaterThanOrEqual(1);
  });

  it('RE-ENTRANCY inverted for the runless anchor: hostext (the anchor) purges LAST', async () => {
    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = String(DAYS);
    await storage.kvSet('hostext:roster:anon:runless-order:host:c', JSON.stringify({ rosterId: 'host:c', tenantId: 'anon:runless-order' }));
    const calls: string[] = [];
    const spy = {
      purgeHostExt: async (tid: string) => { if (tid === 'anon:runless-order') calls.push('hostext'); },
      purgeToggleOverrides: async (tid: string) => { if (tid === 'anon:runless-order') calls.push('toggles'); },
      // ADR 0595 — the `wfreg:` purge joins the ordering assertion: it reads the
      // ownership rows `purgeHostExt` deletes, so it must precede BOTH legs.
      purgeOwnedWorkflowDefs: async (tid: string) => { if (tid === 'anon:runless-order') calls.push('wfdefs'); },
    };
    await pruneAbandonedAnonTenants({ storage }, FUTURE(), spy);
    expect(calls).toEqual(['wfdefs', 'toggles', 'hostext']); // anchor LAST — a crash re-surfaces the tenant
  });

  /**
   * ADR 0595 §Correction 5 — the hoisting §7 calls "load-bearing", witnessed.
   *
   * ADR 0595 moved the runless leg's run-EXISTS probe ABOVE the new `wfreg:`
   * purge. The reasoning is right (purging first would destroy an ACTIVE
   * tenant's workflows and then decline to tear the tenant down — a fix strictly
   * worse than the bug), and it had NO witness: re-applying the dangerous
   * ordering left both witness files green, because the ordering case above pins
   * the purge against the other PURGES and never against the PROBE.
   *
   * The distinguishing population is narrow and real: a tenant anchored by
   * hostext (so it reaches the runless leg) whose runs are past the 500-row
   * run-anchored cap (so the dedupe set missed it) but which HAS a run — the
   * exact case the probe exists for. It must be left completely alone.
   */
  it('the runless leg probes for a run BEFORE purging anything (a live tenant keeps its workflows)', async () => {
    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = String(DAYS);
    const tid = 'anon:runless-active';
    await storage.kvSet(`hostext:roster:${tid}:host:d`, JSON.stringify({ rosterId: 'host:d', tenantId: tid }));
    await storage.insertRun({
      runId: 'runless-active-r1', workflowId: 'wf-x', tenantId: tid, status: 'completed',
      inputs: {}, configurable: {}, metadata: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // §Measured: the first draft of this witness just inserted a run and
    // expected the runless leg. It does not reach it — a tenant with a run is
    // RUN-ANCHORED, takes the other leg, and (being stale under the FUTURE
    // clock) is legitimately torn down. The distinguishing population is
    // narrower than "has a run": the run-anchored enumerator must have MISSED
    // it, which is the review-M2 past-the-500-cap case the probe was written
    // for. Simulate exactly that — `listTenantActivity` blind, `listRuns`
    // truthful — instead of asserting over a population the branch never sees.
    const pastTheCap = new Proxy(storage, {
      get(target, prop, recv) {
        if (prop === 'listTenantActivity') return async () => [];
        return Reflect.get(target, prop, recv);
      },
    }) as typeof storage;
    const calls: string[] = [];
    const spy = {
      purgeHostExt: async (t: string) => { if (t === tid) calls.push('hostext'); },
      purgeToggleOverrides: async (t: string) => { if (t === tid) calls.push('toggles'); },
      purgeOwnedWorkflowDefs: async (t: string) => { if (t === tid) calls.push('wfdefs'); },
    };
    await pruneAbandonedAnonTenants({ storage: pastTheCap }, FUTURE(), spy);
    expect(
      calls,
      'the probe must gate the WORKFLOW purge too — purging first destroys an active tenant\'s workflows and THEN declines to tear the tenant down',
    ).toEqual([]);
    expect(await storage.getRun('runless-active-r1'), 'and the tenant is untouched').not.toBeNull();
    expect(await storage.kvGet(`hostext:roster:${tid}:host:d`)).not.toBeNull();
  });
});
