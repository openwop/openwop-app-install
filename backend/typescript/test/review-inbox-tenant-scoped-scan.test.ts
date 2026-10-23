/**
 * The pending review inbox read EVERY tenant's open interrupts (up to 500) and
 * fetched one run per interrupt, sequentially, only to discard the other
 * tenants'. MEASURED 2026-09-28 in prod: 100-120 s per inbox read, which held
 * the 4-connection pool and timed out the roster/kanban/fleet reads on the same
 * page ("Loading your agents…", then "agent not found"). The inbox now asks the
 * store for this tenant's open interrupts in one query.
 *
 * DOUBLE GUARDS. Tenant: the SQL `r.tenant_id = ?` AND `listReviews`'
 * `run.tenantId !== ctx.tenantId`. Terminal: the SQL `NOT IN (…)` AND
 * `isTerminalRunStatus` in `listReviews`. The listReviews copies run only on the
 * GLOBAL-SCAN FALLBACK (an adapter without `listOpenInterruptsForTenant`), which no
 * case drove in round 1 (probes inbox-tenantcheck / inbox-terminalcheck were
 * vacuous). Cases 2 and 5 now each add a fallback leg through `withoutTenantScan`,
 * which witnesses the listReviews copy on its own.
 *
 * Sabotages that red this file (8fw1g4 round 1 + 2): the SQL tenant and terminal
 * filters, falling back to the global scan when the tenant query exists, per-row
 * `getRun` instead of the batch read, the listReviews tenant and terminal checks
 * (fallback legs), and the canDecide reviewer match.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Storage } from '../src/storage/storage.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { listReviews } from '../src/host/reviewProjection.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

/** The same store as an adapter WITHOUT the tenant-scoped query, so `listReviews`
 *  takes the global-scan fallback (every tenant's open interrupts). */
function withoutTenantScan(storage: Storage): Storage {
  return new Proxy<Storage>(storage, {
    get(target, prop) {
      if (prop === 'listOpenInterruptsForTenant') return undefined;
      const v: unknown = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

let seq = 0;
async function seed(storage: ReturnType<typeof openSqliteStorage>, tenantId: string, opts: { resolved?: boolean } = {}): Promise<string> {
  const now = new Date(Date.now() + ++seq).toISOString();
  const run: RunRecord = {
    runId: `run-inbox-${seq}`, workflowId: 'wf-inbox', tenantId, status: 'waiting-input',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const it: InterruptRecord = {
    interruptId: `int-inbox-${seq}`, runId: run.runId, nodeId: 'gate', kind: 'clarification',
    token: `tok-inbox-${seq}`, data: { prompt: 'go?' }, createdAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  await storage.insertInterrupt(it);
  if (opts.resolved) await storage.resolveInterrupt(it.interruptId, { ok: true }, now);
  return it.interruptId;
}

describe('the pending inbox reads only its own tenant', () => {
  it('the store returns exactly this tenant\'s OPEN interrupts, oldest first', async () => {
    const storage = openSqliteStorage(':memory:');
    const a1 = await seed(storage, 't-mine');
    await seed(storage, 't-other');
    await seed(storage, 't-mine', { resolved: true });
    const a2 = await seed(storage, 't-mine');
    const got = await storage.listOpenInterruptsForTenant!('t-mine', 500);
    expect(got.map((i) => i.interruptId)).toEqual([a1, a2]);
    expect(await storage.listOpenInterruptsForTenant!('t-mine', 1)).toHaveLength(1);
    await storage.close();
  });

  it('listReviews neither scans other tenants nor reads their runs', async () => {
    const storage = openSqliteStorage(':memory:');
    initHostExtPersistence(storage); // the approvals half of the inbox reads host-ext rows
    for (let i = 0; i < 20; i++) await seed(storage, 't-noise');
    const mine = await seed(storage, 't-mine');
    const globalScan = vi.spyOn(storage, 'listOpenInterruptsAll');
    const getRun = vi.spyOn(storage, 'getRun');
    const getRunsByIds = vi.spyOn(storage, 'getRunsByIds');

    const items = await listReviews(storage, { tenantId: 't-mine' }, { status: 'pending' });

    expect(items.map((r) => r.reviewId)).toEqual([expect.stringContaining(mine)]);
    expect(globalScan).not.toHaveBeenCalled();
    // ADR 0778 D8 — the page's runs in ONE batched read (this tenant's only),
    // and no per-row `getRun` at all. #4215 left one `getRun` per distinct run.
    expect(getRun.mock.calls.filter(([id]) => String(id).startsWith('run-inbox-')).length).toBe(0);
    expect(getRunsByIds).toHaveBeenCalledTimes(1);
    expect(getRunsByIds.mock.calls[0]![0]).toEqual([mine.replace('int-', 'run-')]);

    // Fallback leg: the global scan HANDS listReviews all 21 gates, so only its own
    // tenant re-check keeps the 20 t-noise gates out.
    const fallback = withoutTenantScan(storage);
    expect(fallback.listOpenInterruptsForTenant, 'fixture: the fallback must be taken').toBeUndefined();
    expect((await fallback.listOpenInterruptsAll(500)).length, 'fixture: the global scan must see the noise').toBeGreaterThanOrEqual(21);
    const viaFallback = await listReviews(fallback, { tenantId: 't-mine' }, { status: 'pending' });
    expect(viaFallback.map((r) => r.interruptId), 'another tenant\'s gate leaked through the fallback').toEqual([mine]);
    await storage.close();
  });

  it('ADR 0778 D8 — a page of N interrupts over N runs is still ONE run read', async () => {
    const storage = openSqliteStorage(':memory:');
    initHostExtPersistence(storage);
    for (let i = 0; i < 25; i++) await seed(storage, 't-many');
    const getRun = vi.spyOn(storage, 'getRun');
    const getRunsByIds = vi.spyOn(storage, 'getRunsByIds');
    const items = await listReviews(storage, { tenantId: 't-many' }, { status: 'pending' });
    expect(items).toHaveLength(25);
    expect(getRunsByIds).toHaveBeenCalledTimes(1);
    expect(getRun.mock.calls.filter(([id]) => String(id).startsWith('run-inbox-')).length).toBe(0);
    await storage.close();
  });

  it('ADR 0778 D8 — canDecide adds NO per-row read: 25 ACL gates, one batched run read, zero getRun', async () => {
    const storage = openSqliteStorage(':memory:');
    initHostExtPersistence(storage);
    for (let i = 0; i < 25; i++) {
      const id = await seed(storage, 't-acl');
      const it_ = (await storage.getInterrupt(id))!;
      await storage.resolveInterrupt(id, {}, new Date().toISOString());
      await storage.insertInterrupt({ ...it_, interruptId: `${id}-acl`, token: `${it_.token}-acl`, kind: 'approval', data: { prompt: 'ok?', approverRefs: ['user:alice'] } });
    }
    const getRun = vi.spyOn(storage, 'getRun');
    const getRunsByIds = vi.spyOn(storage, 'getRunsByIds');
    const items = await listReviews(storage, { tenantId: 't-acl', decider: { holdsRespond: true, reviewerRef: 'user:alice' } }, { status: 'pending' });
    expect(items).toHaveLength(25);
    expect(items.every((r) => r.canDecide === true)).toBe(true);
    expect(getRunsByIds).toHaveBeenCalledTimes(1);
    expect(getRun.mock.calls.filter(([id]) => String(id).startsWith('run-inbox-')).length).toBe(0);
    const other = await listReviews(storage, { tenantId: 't-acl', decider: { holdsRespond: true, reviewerRef: 'user:mallory' } }, { status: 'pending' });
    expect(other.every((r) => r.canDecide === false)).toBe(true);
    await storage.close();
  });

  it('ADR 0778 D3 — a gate on a TERMINAL run is neither returned by the store nor listed', async () => {
    const storage = openSqliteStorage(':memory:');
    initHostExtPersistence(storage);
    const live = await seed(storage, 't-term');
    const dead = await seed(storage, 't-term');
    await storage.updateRun(dead.replace('int-', 'run-'), { status: 'cancelled' });
    const failed = await seed(storage, 't-term');
    await storage.updateRun(failed.replace('int-', 'run-'), { status: 'failed' });
    expect((await storage.listOpenInterruptsForTenant!('t-term', 500)).map((i) => i.interruptId)).toEqual([live]);
    const items = await listReviews(storage, { tenantId: 't-term' }, { status: 'pending' });
    expect(items.map((r) => r.interruptId)).toEqual([live]);
    // Fallback leg: the global scan does NOT exclude terminal runs, so only the
    // listReviews check keeps the cancelled/failed gates out.
    const fallback = withoutTenantScan(storage);
    const scanned = (await fallback.listOpenInterruptsAll(500)).map((i) => i.interruptId);
    expect(scanned, 'fixture: the global scan must hand back the terminal gates').toEqual(expect.arrayContaining([dead, failed]));
    const viaFallback = await listReviews(fallback, { tenantId: 't-term' }, { status: 'pending' });
    expect(viaFallback.map((r) => r.interruptId), 'a terminal run\'s gate was listed via the fallback').toEqual([live]);
    await storage.close();
  });
});
