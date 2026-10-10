/**
 * ADR 0787 D1/D2 — fire once, fenced in DATA; every job mutator a CAS.
 *
 * Every witness here is a FORCED interleaving, not a `Promise.all` race: a
 * `Promise.all` over the memory store runs each chain to completion in turn and
 * proves nothing (the row-9 lesson). The storage proxy below parks a chosen call
 * AFTER it has read (or before it claims), the test changes the world, then
 * releases it — the exact shape of a pass that stalled, or a daemon write that
 * read before a user's edit landed.
 *
 *   - a pass that listed a slot, stalled past the claim prune, then woke fires
 *     NOTHING (the slot already fired; the row is the fence) — `SCTWF-3`
 *   - a disable / delete / DSAR erasure landing between the list and the fire
 *     fires nothing — `SCTWF-1`
 *   - a lost fence swap on a HARMLESS concurrent write still fires the slot
 *     (the /architect Blocker on the draft: skipping stranded it)
 *   - the daemon's bookkeeping cannot re-create a deleted job, write `enabled`
 *     back over a disable, or restore the owner over an erasure — `SCTWF-2`
 *   - a metadata edit racing the advance cannot rewind `nextFireAt` — `SCTWF-2`
 *   - the same (tenant, job, slot) re-fired after a blind rewind collapses to
 *     ONE run (deterministic run id) — `SCTWF-3`
 *   - a run that started is never labelled `dispatch-error` when its
 *     bookkeeping write loses to contention
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  registerJob,
  setJobEnabled,
  updateJob,
  deleteJob,
  getJob,
  recordJobRun,
  eraseSubjectSchedules,
  resetScheduling,
} from '../src/host/schedulingService.js';
import { processDueSchedules, scheduledRunId } from '../src/host/scheduleDaemon.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

const T0 = Date.parse('2026-06-02T10:15:00Z');
const SLOT = Date.parse('2026-06-02T11:00:00Z');
const JOB_KEY = (id: string) => `hostext:scheduler:job:${id}`;

/** A one-shot latch: `wait()` parks until `open()`. */
function latch() {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { wait: () => p, open };
}

/**
 * The real memory storage, with three arming points:
 *  - `parkNextClaim`: the next `claimOnce` for a schedule slot signals `reached`
 *    and parks until released (a pass that listed, then stalled before claiming);
 *  - `parkNextJobRead(id)`: the next `kvGet` of that job reads the row NOW, then
 *    parks before returning it (a daemon write that read before an edit landed);
 *  - `failJobCas = n`: the next `n` compare-and-swaps on a job row lose (exactly
 *    one mutator's bounded retries), after which they succeed again — so a
 *    FOLLOW-UP write (the thing a regression would add) is not masked.
 */
function instrument(base: Storage) {
  const ctl = {
    claim: null as null | { reached: ReturnType<typeof latch>; release: ReturnType<typeof latch> },
    read: null as null | { key: string; reached: ReturnType<typeof latch>; release: ReturnType<typeof latch> },
    failJobCas: 0,
    onInsertRun: null as null | (() => void),
  };
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;
      if (prop === 'claimOnce') {
        return async (key: string, at: string) => {
          const armed = ctl.claim;
          if (armed && key.startsWith('schedule-fire:')) {
            ctl.claim = null;
            armed.reached.open();
            await armed.release.wait();
          }
          return (orig as Storage['claimOnce']).call(target, key, at);
        };
      }
      if (prop === 'kvGet') {
        return async (key: string) => {
          const value = await (orig as Storage['kvGet']).call(target, key);
          const armed = ctl.read;
          if (armed && armed.key === key) {
            ctl.read = null;
            armed.reached.open();
            await armed.release.wait();
          }
          return value;
        };
      }
      if (prop === 'kvCompareAndSwap') {
        return async (key: string, expected: string | null, next: string) => {
          if (ctl.failJobCas > 0 && key.startsWith('hostext:scheduler:job:')) {
            ctl.failJobCas--;
            return { swapped: false, actual: await target.kvGet(key) };
          }
          return (orig as Storage['kvCompareAndSwap']).call(target, key, expected, next);
        };
      }
      if (prop === 'insertRun') {
        return async (...args: unknown[]) => {
          const res = await (orig as (...a: unknown[]) => Promise<void>).apply(target, args);
          ctl.onInsertRun?.();
          return res;
        };
      }
      return orig.bind(target);
    },
  });
  return {
    storage: proxy as Storage,
    parkNextClaim() {
      const armed = { reached: latch(), release: latch() };
      ctl.claim = armed;
      return armed;
    },
    parkNextJobRead(jobId: string) {
      const armed = { key: JOB_KEY(jobId), reached: latch(), release: latch() };
      ctl.read = armed;
      return armed;
    },
    set failJobCas(n: number) { ctl.failJobCas = n; },
    set onInsertRun(fn: null | (() => void)) { ctl.onInsertRun = fn; },
  };
}

let base: Storage;
let io: ReturnType<typeof instrument>;
let deps: StartRunDeps;

beforeEach(async () => {
  base = await openStorage('memory://');
  io = instrument(base);
  initHostExtPersistence(io.storage);
  await resetScheduling();
  deps = { storage: io.storage, hostSuite };
});
afterEach(() => {
  __resetHostExtPersistence();
});

async function runsFor(jobId: string) {
  const runs = await base.listRuns({ limit: 100 });
  return runs.filter((r) => ((r.metadata as Record<string, unknown>)?.schedule as Record<string, unknown> | undefined)?.jobId === jobId);
}

async function hourly(jobId: string, extra: Partial<Parameters<typeof registerJob>[0]> = {}) {
  const r = await registerJob({ jobId, tenantId: 't1', cronExpr: '0 * * * *', workflowId: 'wf-1', timezone: 'UTC', ...extra }, T0);
  expect(r.ok).toBe(true);
}

describe('ADR 0787 D1 — the fence is the row', () => {
  it('a pass that listed the slot, stalled past the claim prune, then woke fires NOTHING', async () => {
    await hourly('j-stale');
    // Pass A lists the due slot, then parks before claiming it (a stalled
    // instance — WHD-28's superseded revision).
    const parked = io.parkNextClaim();
    const passA = processDueSchedules(deps, SLOT + 30_000);
    await parked.reached.wait();
    // Pass B (a healthy instance) fires the slot normally…
    expect(await processDueSchedules({ storage: base, hostSuite }, SLOT + 31_000)).toBe(1);
    // …and the claim is pruned, as it is 10 minutes later.
    await base.pruneOnceByPrefix('schedule-fire:', new Date(Date.now() + 86_400_000).toISOString());
    // Pass A wakes: its claim now SUCCEEDS (the table forgot) — only the row stops it.
    parked.release.open();
    expect(await passA).toBe(0);
    expect(await runsFor('j-stale')).toHaveLength(1);
  });

  for (const [what, act] of [
    ['disabled', () => setJobEnabled('j-mid', false)],
    ['deleted', () => deleteJob('j-mid')],
    ['DSAR-erased', () => eraseSubjectSchedules('t1', 'user:alice')],
  ] as const) {
    it(`a job ${what} between the list and the fire does not fire`, async () => {
      await hourly('j-mid', { metadata: { actingUserId: 'user:alice' } });
      const parked = io.parkNextClaim();
      const pass = processDueSchedules(deps, SLOT + 30_000);
      await parked.reached.wait();
      await act();
      parked.release.open();
      expect(await pass).toBe(0);
      expect(await runsFor('j-mid')).toHaveLength(0);
    });
  }

  it('a lost fence swap on a HARMLESS concurrent write still fires the slot on time', async () => {
    await hourly('j-harmless');
    // The fence reads the row, parks; a label edit lands; the fence's swap loses.
    const read = io.parkNextJobRead('j-harmless');
    const armClaim = io.parkNextClaim();
    const pass = processDueSchedules(deps, SLOT + 30_000);
    await armClaim.reached.wait();
    armClaim.release.open();
    await read.reached.wait();
    await updateJob('j-harmless', { metadata: { label: 'renamed' } });
    read.release.open();
    expect(await pass).toBe(1);
    const runs = await runsFor('j-harmless');
    expect(runs).toHaveLength(1);
    const job = await getJob('j-harmless');
    expect(job?.metadata).toEqual({ label: 'renamed' });
    expect(job?.nextFireAt).toBeGreaterThan(SLOT);
  });

  it('a slot re-fired after a blind rewind collapses to ONE run (deterministic run id)', async () => {
    await hourly('j-rewind');
    expect(await processDueSchedules(deps, SLOT + 30_000)).toBe(1);
    // A pre-0787 revision's blind put writes the old slot back; the claim is pruned.
    const row = JSON.parse((await base.kvGet(JOB_KEY('j-rewind')))!) as Record<string, unknown>;
    await base.kvSet(JOB_KEY('j-rewind'), JSON.stringify({ ...row, nextFireAt: SLOT }));
    await base.pruneOnceByPrefix('schedule-fire:', new Date(Date.now() + 86_400_000).toISOString());
    // The fence passes (the row says the slot is due) — the run id is what holds.
    await processDueSchedules(deps, SLOT + 90_000);
    const runs = await runsFor('j-rewind');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe(scheduledRunId('t1', 'j-rewind', SLOT));
  });

  it('the run id is tenant-keyed: the same job id and slot in another tenant is a different run', () => {
    expect(scheduledRunId('t1', 'j', SLOT)).not.toBe(scheduledRunId('t2', 'j', SLOT));
  });
});

describe('ADR 0787 D2 — every job mutator is a compare-and-swap', () => {
  it("the daemon's bookkeeping cannot re-create a job the user deleted", async () => {
    await hourly('j-del');
    const read = io.parkNextJobRead('j-del');
    const write = recordJobRun('j-del', 'run-x', SLOT);
    await read.reached.wait();
    await deleteJob('j-del');
    read.release.open();
    await write;
    expect(await getJob('j-del')).toBeNull();
  });

  it("the daemon's bookkeeping cannot write enabled:true back over a disable", async () => {
    await hourly('j-dis');
    const read = io.parkNextJobRead('j-dis');
    const write = recordJobRun('j-dis', 'run-x', SLOT);
    await read.reached.wait();
    await setJobEnabled('j-dis', false);
    read.release.open();
    await write;
    const job = await getJob('j-dis');
    expect(job?.enabled).toBe(false);
    expect(job?.lastRunId).toBe('run-x');
  });

  it("the daemon's bookkeeping cannot restore the owner over a DSAR scrub", async () => {
    await hourly('j-erase', { ownerUserId: 'user:alice', metadata: { actingUserId: 'user:alice' } });
    const read = io.parkNextJobRead('j-erase');
    const write = recordJobRun('j-erase', 'run-x', SLOT);
    await read.reached.wait();
    await eraseSubjectSchedules('t1', 'user:alice');
    read.release.open();
    await write;
    const job = await getJob('j-erase');
    expect(job?.enabled).toBe(false);
    expect(job?.ownerUserId).not.toBe('user:alice');
    expect(job?.metadata?.actingUserId).not.toBe('user:alice');
  });

  it('a metadata edit racing the advance cannot rewind nextFireAt', async () => {
    await hourly('j-rewind-edit');
    const read = io.parkNextJobRead('j-rewind-edit');
    const edit = updateJob('j-rewind-edit', { metadata: { label: 'x' } });
    await read.reached.wait();
    // The daemon fires and advances while the edit holds its stale read.
    expect(await processDueSchedules(deps, SLOT + 30_000)).toBe(1);
    read.release.open();
    await edit;
    const job = await getJob('j-rewind-edit');
    expect(job?.metadata).toEqual({ label: 'x' });
    expect(job?.nextFireAt, 'the slot that just fired must not be written back').toBeGreaterThan(SLOT);
  });

  it('a run that started is never labelled dispatch-error when its bookkeeping loses to contention', async () => {
    await hourly('j-contend');
    // Exactly recordJobRun's five attempts lose; anything written after that lands.
    io.onInsertRun = () => { io.failJobCas = 5; };
    expect(await processDueSchedules(deps, SLOT + 30_000)).toBe(1);
    io.onInsertRun = null;
    expect(await runsFor('j-contend')).toHaveLength(1);
    expect((await getJob('j-contend'))?.lastSkipReason).not.toBe('dispatch-error');
  });

  it('SCTCD-4: re-saving an UNCHANGED cadence does not move a due slot past the fence', async () => {
    await hourly('j-resave');
    // The slot is due (the daemon has not reached it yet); a label edit that
    // re-sends the same cron must not recompute nextFireAt past it.
    await updateJob('j-resave', { cronExpr: '0 * * * *', timezone: 'UTC', metadata: { label: 'x' } });
    expect((await getJob('j-resave'))?.nextFireAt).toBe(SLOT);
    expect(await processDueSchedules(deps, SLOT + 30_000)).toBe(1);
  });
});
