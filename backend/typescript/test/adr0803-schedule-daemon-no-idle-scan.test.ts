/**
 * ADR 0803 — the schedule daemon does not list every job on every tick.
 *
 * MEASURED 2026-10-02 (EVID-5): a full scan of every tenant's jobs ran every
 * 30 s on every live instance. The daemon now reads a one-row "job set changed"
 * token per tick and re-lists only when the token moved, a job is due, or the
 * cached list is older than DAEMON_LIST_MAX_STALE_MS. Firing stays fenced by
 * claimDueSlot, so these tests also pin that a change is never missed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  DAEMON_LIST_MAX_STALE_MS, __daemonFullListCount, deleteJob, getJob, registerJob, resetScheduling, setJobEnabled,
} from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};
const T0 = Date.parse('2026-06-02T10:15:00Z');
const SLOT = Date.parse('2026-06-02T11:00:00Z'); // hourly → first fire
const MIN = 60_000;

let storage: Storage;
let deps: StartRunDeps;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await resetScheduling();
  deps = { storage, hostSuite };
});
afterEach(() => { __resetHostExtPersistence(); });

const runsFor = async (jobId: string) => (await storage.listRuns({ limit: 100 }))
  .filter((r) => ((r.metadata as Record<string, unknown>)?.schedule as Record<string, unknown> | undefined)?.jobId === jobId);
/** Full lists made by the passes inside `fn`. */
async function listsDuring(fn: () => Promise<unknown>): Promise<number> {
  const before = __daemonFullListCount();
  await fn();
  return __daemonFullListCount() - before;
}

describe('ADR 0803 — no full scan while nothing changed and nothing is due', () => {
  it('idle ticks reuse the list: one scan, then none for every 30 s tick until the job is due', async () => {
    await registerJob({ jobId: 'j1', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0);
    expect(await listsDuring(() => processDueSchedules(deps, T0))).toBe(1);
    // Six more ticks, 30 s apart, all before the 11:00 slot and inside the backstop.
    const idle = await listsDuring(async () => { for (let i = 1; i <= 6; i += 1) await processDueSchedules(deps, T0 + i * 30_000); });
    expect(idle).toBe(0);
  });

  it('a job created after the list is seen on the next tick (the token moved)', async () => {
    await processDueSchedules(deps, T0); // cache an EMPTY job set
    await registerJob({ jobId: 'late', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0);
    expect(await listsDuring(() => processDueSchedules(deps, T0 + 30_000))).toBe(1);
    expect(await processDueSchedules(deps, SLOT)).toBe(1);
    expect(await runsFor('late')).toHaveLength(1);
  });

  it('a due time re-lists by itself and fires; a disable or delete after the list is honoured', async () => {
    await registerJob({ jobId: 'on', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0);
    await registerJob({ jobId: 'off', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0);
    await registerJob({ jobId: 'gone', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0);
    await processDueSchedules(deps, T0);
    await setJobEnabled('off', false);
    await deleteJob('gone');
    expect(await processDueSchedules(deps, SLOT)).toBe(1);
    expect(await runsFor('on')).toHaveLength(1);
    expect(await runsFor('off')).toHaveLength(0);
    expect(await runsFor('gone')).toHaveLength(0);
    expect((await getJob('on'))?.nextFireAt).toBeGreaterThan(SLOT);
  });

  it('a due time ALONE re-lists and fires — no write in between, well inside the backstop', async () => {
    await registerJob({ jobId: 'due', tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0);
    // Last list two minutes before the slot: the token cannot have moved since,
    // and the backstop is five minutes away, so only the due time can force it.
    await processDueSchedules(deps, SLOT - 2 * MIN);
    expect(await listsDuring(() => processDueSchedules(deps, SLOT - MIN))).toBe(0);
    let fired = 0;
    expect(await listsDuring(async () => { fired = await processDueSchedules(deps, SLOT); })).toBe(1);
    expect(fired).toBe(1);
  });

  it('the backstop re-lists a list that is too old even when nothing moved', async () => {
    await registerJob({ jobId: 'daily', tenantId: 't1', cronExpr: '0 9 * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0); // next fire tomorrow
    await processDueSchedules(deps, T0);
    expect(await listsDuring(() => processDueSchedules(deps, T0 + DAEMON_LIST_MAX_STALE_MS - MIN))).toBe(0);
    expect(await listsDuring(() => processDueSchedules(deps, T0 + DAEMON_LIST_MAX_STALE_MS))).toBe(1);
  });

  it('a row written BEHIND the store (raw kv, no token) is picked up by the backstop, never lost', async () => {
    const r = await registerJob({ jobId: 'raw', tenantId: 't1', cronExpr: '0 9 * * *', workflowId: 'wf-1', timezone: 'UTC' }, T0);
    if (!r.ok) throw new Error('setup');
    await processDueSchedules(deps, T0); // caches nextFireAt = tomorrow 09:00
    // Something bypasses the store and makes the job due NOW.
    await storage.kvSet('hostext:scheduler:job:raw', JSON.stringify({ ...r.job, nextFireAt: T0 + MIN }));
    expect(await processDueSchedules(deps, T0 + 2 * MIN)).toBe(0); // invisible until…
    expect(await processDueSchedules(deps, T0 + DAEMON_LIST_MAX_STALE_MS)).toBe(1); // …the backstop
    expect(await runsFor('raw')).toHaveLength(1);
  });
});
