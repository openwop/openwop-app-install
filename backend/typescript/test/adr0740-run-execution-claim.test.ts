/**
 * ADR 0740 — the run EXECUTION CLAIM (`WHD-12`).
 *
 * One accepted run can be DELIVERED to `executeRun` twice (the `setImmediate`
 * dispatch hint racing a `dispatch_outbox` redelivery, or two instances). Before
 * this ADR both executed: MEASURED as one HTTP effect arriving twice and two
 * `run.completed` events on one run. The end-to-end witness is the RFC 0158
 * `duplicate-delivery` row in `test/rfc0158-durability-seam.test.ts`.
 *
 * THIS file is the other half: the fence must not break anything that
 * legitimately calls `executeRun` more than once on a run, or on a run that
 * already carries someone's lease. Each `it` below is one of the hazards the
 * design audit named, and each is sabotage-proved (see the ADR).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeRun, RESUME_CLAIM_WAIT_MS } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { getInstanceId } from '../src/host/instanceId.js';
import { sweepOrphanedRuns, type RunSweeperDeps } from '../src/host/runDispatchSweeper.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0740-')) });

/** How many times the counted node's BODY ran, per run — the real-effect oracle. */
const bodyRuns = new Map<string, number>();
let releaseSlow: () => void = () => {};

beforeAll(() => {
  const registry = getNodeRegistry();
  registry.register({
    typeId: 'test.adr0740.counted',
    version: '1.0.0',
    async execute(ctx) {
      bodyRuns.set(ctx.runId, (bodyRuns.get(ctx.runId) ?? 0) + 1);
      // Yield, so a concurrent second delivery has every chance to get in.
      await new Promise((r) => setTimeout(r, 40));
      return { status: 'success', outputs: { output: null } };
    },
  });
  registry.register({
    typeId: 'test.adr0740.slow',
    version: '1.0.0',
    async execute(ctx) {
      bodyRuns.set(ctx.runId, (bodyRuns.get(ctx.runId) ?? 0) + 1);
      await new Promise<void>((resolve) => { releaseSlow = resolve; });
      return { status: 'success', outputs: { output: null } };
    },
  });
});

const def = (typeId: string): WorkflowDefinition => ({
  workflowId: `wf-${typeId}`,
  nodes: [{ nodeId: 'n', typeId, config: {}, inputs: {} }],
  edges: [],
});

let seq = 0;
async function seedRun(patch: Partial<RunRecord> = {}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run = {
    runId: `run-adr0740-${++seq}`, workflowId: 'wf', tenantId: 'demo', status: 'pending',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now, ...patch,
  } as RunRecord;
  await storage.insertRun(run);
  return run;
}
const count = async (runId: string, type: string): Promise<number> =>
  (await storage.listEvents(runId)).filter((e) => e.type === type).length;
const FAR = (): number => Date.now() + 600_000;

describe('ADR 0740 — Storage.claimRunExecution (the predicate, row by row)', () => {
  it('first claim wins; a second contender on a live lease is HELD, and does not move the owner', async () => {
    const run = await seedRun();
    expect(await storage.claimRunExecution(run.runId, 'exec-a', Date.now(), FAR())).toBe('claimed');
    expect(await storage.claimRunExecution(run.runId, 'exec-b', Date.now(), FAR())).toBe('held');
    expect((await storage.getRun(run.runId))?.dispatchOwner, 'a refused claim must not overwrite the holder').toBe('exec-a');
  });

  it('the SAME owner string is also held — an instance id is not a licence to re-enter', async () => {
    // This is the measured WHD-12 case: both deliveries are on ONE instance, so an
    // `OR dispatch_owner = @owner` arm would wave the duplicate straight through.
    const run = await seedRun();
    expect(await storage.claimRunExecution(run.runId, 'same-instance', Date.now(), FAR())).toBe('claimed');
    expect(await storage.claimRunExecution(run.runId, 'same-instance', Date.now(), FAR())).toBe('held');
  });

  it('an EXPIRED lease is claimable — crash recovery must keep working', async () => {
    const run = await seedRun({ status: 'running' });
    await storage.setRunDispatchLease(run.runId, 'dead-instance', Date.now() - 1);
    expect(await storage.claimRunExecution(run.runId, 'exec-new', Date.now(), FAR())).toBe('claimed');
    expect((await storage.getRun(run.runId))?.dispatchOwner).toBe('exec-new');
  });

  it.each(['paused', 'waiting-approval', 'waiting-input', 'waiting-external'] as const)(
    'a SUSPENDED run (%s) is claimable even under another owner\'s LIVE lease — the prior execution returned',
    async (status) => {
      const run = await seedRun({ status });
      await storage.setRunDispatchLease(run.runId, 'instance-that-suspended-it', FAR());
      expect(await storage.claimRunExecution(run.runId, 'resuming-instance', Date.now(), FAR())).toBe('claimed');
    },
  );

  it.each(['completed', 'failed', 'cancelled'] as const)('a FINAL run (%s) is not-runnable, even with no owner and no lease', async (status) => {
    const run = await seedRun({ status });
    expect(await storage.claimRunExecution(run.runId, 'exec', Date.now(), FAR())).toBe('not-runnable');
  });

  it('a run that does not exist is `missing`, not `held`', async () => {
    expect(await storage.claimRunExecution('run-adr0740-never-inserted', 'exec', Date.now(), FAR())).toBe('missing');
  });
});

describe('ADR 0740 — executeRun under duplicate delivery', () => {
  it('two concurrent deliveries: ONE executes, the other is refused having written NOTHING', async () => {
    const run = await seedRun();
    const [a, b] = await Promise.all([
      executeRun(storage, run, def('test.adr0740.counted'), {}),
      executeRun(storage, run, def('test.adr0740.counted'), {}),
    ]);
    expect([a.duplicateDelivery === true, b.duplicateDelivery === true].sort(), 'exactly one delivery must be refused').toEqual([false, true]);
    expect(bodyRuns.get(run.runId), 'the node body — the effect — ran more than once').toBe(1);
    expect(await count(run.runId, 'run.started')).toBe(1);
    expect(await count(run.runId, 'run.completed')).toBe(1);
    expect((await storage.getRun(run.runId))?.status).toBe('completed');
  });

  it('a delivery that arrives AFTER the run finished re-executes nothing', async () => {
    const run = await seedRun();
    await executeRun(storage, run, def('test.adr0740.counted'), {});
    const late = await executeRun(storage, run, def('test.adr0740.counted'), {});
    expect(late.duplicateDelivery).toBe(true);
    expect(late.status, 'the refusal reports the run\'s RECORDED status').toBe('completed');
    expect(bodyRuns.get(run.runId)).toBe(1);
    expect(await count(run.runId, 'run.completed')).toBe(1);
  });

  it('HAZARD: the orphan lane\'s own re-dispatch is NOT refused (executionPreclaimed)', async () => {
    // `claimOrphanedRuns` stamps THIS instance as owner with a live lease, then
    // hands the run to `executeRun`. To the claim that is exactly a duplicate.
    const run = await seedRun({ status: 'running' });
    await storage.setRunDispatchLease(run.runId, getInstanceId(), FAR());
    const refused = await executeRun(storage, run, def('test.adr0740.counted'), {});
    expect(refused.duplicateDelivery, 'positive control: without the hand-off flag this IS refused').toBe(true);
    const recovered = await executeRun(storage, run, def('test.adr0740.counted'), { executionPreclaimed: true });
    expect(recovered.duplicateDelivery).toBeUndefined();
    expect(bodyRuns.get(run.runId), 'recovery never executed the run').toBe(1);
  });

  it('HAZARD: a legitimate RESUME under a stale live lease executes', async () => {
    const run = await seedRun({ status: 'waiting-approval' });
    await storage.setRunDispatchLease(run.runId, 'instance-that-suspended-it', FAR());
    const resumed = await executeRun(storage, run, def('test.adr0740.counted'), { resumeFromNodeIndex: 0 });
    expect(resumed.duplicateDelivery).toBeUndefined();
    expect(bodyRuns.get(run.runId)).toBe(1);
  });

  it('HAZARD: a RESUME that finds the run momentarily HELD waits for the holder, then runs — it is a successor, not a duplicate', async () => {
    const run = await seedRun({ status: 'running' });
    await storage.setRunDispatchLease(run.runId, 'the-execution-it-succeeds', FAR());
    // The holder "returns" (suspends) 600 ms from now.
    setTimeout(() => { void storage.updateRun(run.runId, { status: 'waiting-approval' }); }, 600);
    const t0 = Date.now();
    const resumed = await executeRun(storage, run, def('test.adr0740.counted'), { resumeFromNodeIndex: 0 });
    expect(resumed.duplicateDelivery, 'a resume must never be dropped as a duplicate').toBeUndefined();
    expect(Date.now() - t0, 'it did not wait for the holder').toBeGreaterThanOrEqual(500);
    expect(Date.now() - t0, 'it waited the whole window instead of noticing the holder return').toBeLessThan(RESUME_CLAIM_WAIT_MS);
    expect(bodyRuns.get(run.runId)).toBe(1);
  });

  it('HAZARD: fails OPEN — a Storage without the primitive, or one that throws, still executes', async () => {
    const run1 = await seedRun();
    const withoutPrimitive = new Proxy(storage, { get: (t, k, r) => (k === 'claimRunExecution' ? undefined : Reflect.get(t, k, r)) });
    const r1 = await executeRun(withoutPrimitive, run1, def('test.adr0740.counted'), {});
    expect(r1.duplicateDelivery).toBeUndefined();
    expect(bodyRuns.get(run1.runId)).toBe(1);

    const run2 = await seedRun();
    const throwing = new Proxy(storage, { get: (t, k, r) => (k === 'claimRunExecution' ? async () => { throw new Error('storage blip'); } : Reflect.get(t, k, r)) });
    const r2 = await executeRun(throwing, run2, def('test.adr0740.counted'), {});
    expect(r2.duplicateDelivery).toBeUndefined();
    expect(bodyRuns.get(run2.runId)).toBe(1);
  });

  it('HAZARD: a run never inserted (the shape 24 test files use) executes', async () => {
    const now = new Date().toISOString();
    const ghost = { runId: `run-adr0740-ghost-${++seq}`, workflowId: 'wf', tenantId: 'demo', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now } as RunRecord;
    const r = await executeRun(storage, ghost, def('test.adr0740.counted'), {});
    expect(r.duplicateDelivery).toBeUndefined();
    expect(bodyRuns.get(ghost.runId)).toBe(1);
  });

  it('the winner\'s heartbeat still owns the lease it claimed (ADR 0585 P0b renewal is unaffected)', async () => {
    const run = await seedRun();
    const p = executeRun(storage, run, def('test.adr0740.slow'), {});
    await new Promise((r) => setTimeout(r, 120));
    expect((await storage.getRun(run.runId))?.dispatchOwner).toBe(getInstanceId());
    expect(await storage.renewRunDispatchLeaseIfOwner(run.runId, getInstanceId(), FAR()), 'the claim stamped an owner the heartbeat cannot renew as').toBe(true);
    releaseSlow();
    expect((await p).status).toBe('completed');
  });
});

describe('ADR 0740 — crash recovery still RUNS the run it reclaims (the orphan lane, end to end)', () => {
  it('sweepOrphanedRuns reclaims an expired-lease run AND its re-dispatch executes — the sweeper hands its claim off', async () => {
    // No test asserted this before: `eng1-orphan-reclaim` checks the claim and the
    // decision, not that the re-dispatched run EXECUTES. So when the execution
    // claim landed, deleting `executionPreclaimed: true` from the sweeper reddened
    // NOTHING — while making recovery refuse its own re-dispatch forever (the
    // sweeper stamps a live lease, which is what a duplicate looks like). This is
    // the mechanism RFC 0158 `kill-during-execution` exercises; it took 726.8 s
    // under a real SIGKILL, so it needs a unit-speed guard.
    const now = Date.now();
    const oldIso = new Date(now - 10 * 60_000).toISOString(); // past the orphan grace window
    const orphan = await seedRun({ status: 'running', createdAt: oldIso, updatedAt: oldIso });
    await storage.setRunDispatchLease(orphan.runId, 'instance-that-was-sigkilled', now - 1_000);

    const hostSuite = createHostAdapterSuite({ storage });
    const deps: RunSweeperDeps = {
      storage,
      hostSuite: {
        ...hostSuite,
        workflowCatalog: { ...hostSuite.workflowCatalog, getWorkflow: async () => ({ workflowId: 'wf', definition: def('test.adr0740.counted') }) },
      },
    };
    expect(await sweepOrphanedRuns(deps, 'this-instance-sweeper', now)).toBe(1);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await storage.getRun(orphan.runId))?.status !== 'completed') {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(bodyRuns.get(orphan.runId), 'the reclaimed run never executed — recovery refused its own re-dispatch').toBe(1);
    expect((await storage.getRun(orphan.runId))?.status).toBe('completed');
  });
});
