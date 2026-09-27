/**
 * ADR 0551 P1 — the durable dispatch outbox.
 *
 * The gap this closes: accepted work was handed off with
 * `setImmediate(executeRun)`, which is process memory. Between `insertRun` and
 * that callback there was nothing durable saying anyone intended to start the
 * run, so a Cloud Run instance recycled in that window left an accepted run
 * `pending` with only the orphan sweeper's 2-minute grace scan to find it.
 *
 * The two tests the ADR names as the P1 exit criterion (:183) are
 * `kill-after-201 …` and `duplicate delivery …` below. The rest pin the
 * properties those two depend on:
 *
 *   - the run row and the intent row commit ATOMICALLY (neither can exist alone
 *     at the moment of the write);
 *   - the intent is retired only on OBSERVED evidence that the run started;
 *   - the wakeup hint and the durable worker cannot both dispatch one run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { sweepDispatchOutbox } from '../src/host/runDispatchSweeper.js';
import { insertRunWithStartContext, DISPATCH_OUTBOX_HINT_GRACE_MS } from '../src/host/runInsert.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { __resetRunStartContributors } from '../src/host/runStartContext.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import Database from 'better-sqlite3';
import { applyMigrations, LATEST_SCHEMA_VERSION } from '../src/storage/sqlite/schema.js';
import { legacyDbAtVersion } from './_legacyDbFixture.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `core.noop` is dispatched for real below, so the node registry has to be
// populated — otherwise every run terminates `workflow_not_found` and the
// "it started" assertions would be measuring a broken executor.
ensureNodesRegistered();
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-outbox-')) });

const NOW = 1_700_000_000_000;
const nowIso = new Date(NOW).toISOString();

function makeRun(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    workflowId: 'wf-1',
    tenantId: 't1',
    status: 'pending',
    inputs: null,
    metadata: {},
    configurable: {},
    createdAt: nowIso,
    updatedAt: nowIso,
    ...over,
  };
}

/** A host suite whose catalog resolves `wf-1` to a trivial one-node workflow. */
function stubHostSuite(getWorkflow?: () => Promise<{ workflowId: string; definition: unknown } | null>): HostAdapterSuite {
  return {
    workflowCatalog: {
      getWorkflow: getWorkflow ?? (async () => ({
        workflowId: 'wf-1',
        // One trivial node, not an empty graph: a node-less workflow FAILS, and a
        // failed run would satisfy any "it started" assertion phrased as
        // "no longer pending" without the dispatch having worked.
        definition: { workflowId: 'wf-1', nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [] },
      })),
    },
    providerPolicyResolver: undefined,
  } as unknown as HostAdapterSuite;
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
    .map((r) => r.name)
    .sort();
}

/** Let queued `setImmediate` work (the dispatch handoff) drain. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('ADR 0551 P1 — dispatch outbox: the intent is written with the run', () => {
  let storage: Storage;
  beforeEach(async () => {
    storage = await openStorage('memory://');
    setEventLogBackend(storage);
    setSuspendBackend(storage);
    __resetRunStartContributors();
  });
  afterEach(() => vi.restoreAllMocks());

  it('enqueues an intent only when the caller declares accepted work', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'declared' }), { enqueueDispatch: true });
    await insertRunWithStartContext(storage, makeRun({ runId: 'undeclared' }));

    const row = await storage.getDispatchOutbox('declared');
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ runId: 'declared', tenantId: 't1', workflowId: 'wf-1', status: 'pending', attempts: 0 });
    // No lease until a worker claims it.
    expect(row?.claimedBy).toBeNull();

    // A run insert that made no start promise gets no intent — the outbox is
    // not a log of every run, it is a queue of undischarged promises.
    expect(await storage.getDispatchOutbox('undeclared')).toBeNull();
  });

  it('leaves the wakeup hint a real window before the worker may claim', async () => {
    const insertedAt = Date.now();
    await insertRunWithStartContext(storage, makeRun({ runId: 'early' }), { enqueueDispatch: true });

    // Probed with a WALL-CLOCK offset, not with the row's own `nextAttemptAt`.
    // Deriving the probe from the value under test makes the assertion true for
    // any grace including zero — the first draft of this test did exactly that
    // and stayed green when the constant was sabotaged to 0.
    expect(await storage.claimDispatchOutbox('w1', insertedAt + 1_000, 60_000, 10)).toEqual([]);

    // The floor itself, so the window cannot be quietly shrunk to something too
    // short to cover a slow `executeRun` reaching its first status write.
    expect(DISPATCH_OUTBOX_HINT_GRACE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('becomes claimable once the window has passed', async () => {
    const insertedAt = Date.now();
    await insertRunWithStartContext(storage, makeRun({ runId: 'early' }), { enqueueDispatch: true });

    const claimed = await storage.claimDispatchOutbox('w1', insertedAt + DISPATCH_OUTBOX_HINT_GRACE_MS + 1_000, 60_000, 10);
    expect(claimed.map((r) => r.runId)).toEqual(['early']);
    expect(claimed[0]!.claimedBy).toBe('w1');
  });

  it('a claimed row is invisible to a second claimer until its lease expires', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'leased' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('leased'))!.nextAttemptAt;

    expect((await storage.claimDispatchOutbox('w1', due, 60_000, 10)).map((r) => r.runId)).toEqual(['leased']);
    expect(await storage.claimDispatchOutbox('w2', due + 1, 60_000, 10)).toEqual([]);
    // Once the first worker's lease lapses the row is re-deliverable — this is
    // the mechanism that makes duplicate delivery a real, testable case rather
    // than a hypothetical one.
    expect((await storage.claimDispatchOutbox('w2', due + 60_001, 60_000, 10)).map((r) => r.runId)).toEqual(['leased']);
  });

  it('is swept by the tenant-delete cascade (it carries tenant_id for exactly this reason)', async () => {
    // Both adapters derive the cascade by INTROSPECTING which tables have a
    // `tenant_id` column (ADR 0284), never from a hand-kept list. So the column
    // on this table is not decoration — it is what enrols the queue in erasure.
    // Asserted rather than assumed: a table added without it would leave live
    // dispatch intents behind after a tenant was deleted.
    await insertRunWithStartContext(storage, makeRun({ runId: 'erased', tenantId: 'doomed' }), { enqueueDispatch: true });
    expect(await storage.getDispatchOutbox('erased')).not.toBeNull();

    await storage.deleteAllTenantData('doomed');
    expect(await storage.getDispatchOutbox('erased')).toBeNull();
  });

  it('rolls the run insert back when the intent cannot be written (one atomic operation)', async () => {
    // Arrange the one state where the intent write fails: an intent whose run
    // row is gone. `deleteRun` removes the run and its event/interrupt rows,
    // deliberately not the outbox row (a run-less intent is self-healing — see
    // the "discharges an intent whose run no longer exists" test below).
    await insertRunWithStartContext(storage, makeRun({ runId: 'atomic' }), { enqueueDispatch: true });
    expect(await storage.deleteRun('atomic')).toBe(true);
    expect(await storage.getDispatchOutbox('atomic')).not.toBeNull();

    // Re-inserting the run now collides on the outbox primary key.
    await expect(
      insertRunWithStartContext(storage, makeRun({ runId: 'atomic' }), { enqueueDispatch: true }),
    ).rejects.toThrow();

    // THE ASSERTION: the run row must not survive a failed intent write. If
    // these were two statements instead of one transaction, the run would be
    // sitting here accepted with an intent that was never recorded — exactly
    // the state the outbox exists to make impossible.
    expect(await storage.getRun('atomic')).toBeNull();
  });
});

describe('ADR 0551 P1 — dispatch outbox worker', () => {
  let storage: Storage;
  beforeEach(async () => {
    storage = await openStorage('memory://');
    setEventLogBackend(storage);
    setSuspendBackend(storage);
    __resetRunStartContributors();
  });
  afterEach(() => vi.restoreAllMocks());

  it('kill-after-201: a run whose process died before the wakeup hint still starts', async () => {
    // The kill is modelled by what a kill actually leaves behind: the run and
    // its intent are durable (the 201 was honest), and NOTHING ran. No
    // `dispatchRunInBackground` call is made here on purpose.
    await insertRunWithStartContext(storage, makeRun({ runId: 'stranded' }), { enqueueDispatch: true });
    expect((await storage.getRun('stranded'))!.status).toBe('pending');

    const due = (await storage.getDispatchOutbox('stranded'))!.nextAttemptAt;
    // A DIFFERENT worker id: this is the surviving instance, not the dead one.
    const dispatched = await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'instance-b', due);
    expect(dispatched).toBe(1);

    await flush();
    // Eventual start, proven at the durable layer rather than by a spy.
    //
    // Asserted as `completed` + a `run.started` event, NOT as "no longer
    // pending": the fail-closed tail marks a run that could not start `failed`,
    // so `!== 'pending'` is satisfied by the dispatch BREAKING. An earlier draft
    // of this test passed for exactly that reason while `executeRun` was
    // throwing on every call.
    expect((await storage.getRun('stranded'))!.status).toBe('completed');
    expect(
      (await storage.listEvents('stranded', { limit: 100 })).filter((e) => e.type === 'run.started'),
    ).toHaveLength(1);
  });

  it('duplicate delivery of one intent yields exactly one logical execution', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'dup' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('dup'))!.nextAttemptAt;
    const deps = { storage, hostSuite: stubHostSuite() };

    expect(await sweepDispatchOutbox(deps, 'instance-a', due)).toBe(1);
    await flush();

    // Second delivery: the first holder's lease has lapsed, so the row is
    // re-claimable and IS re-claimed. It must not start the run again.
    const second = await sweepDispatchOutbox(deps, 'instance-b', due + 60_001);
    expect(second).toBe(0);

    await flush();
    // One logical execution, counted at the event log: `run.started` is
    // appended once per `executeRun` entry, so two dispatches would show two.
    const started = (await storage.listEvents('dup', { limit: 100 })).filter((e) => e.type === 'run.started');
    expect(started).toHaveLength(1);
    // And the intent is now discharged, so there is no third delivery.
    expect(await storage.getDispatchOutbox('dup')).toBeNull();
  });

  it('never re-dispatches a run that already left pending, even with no live lease', async () => {
    // Isolates the STATUS fence. The duplicate-delivery test above is also
    // covered by the live-dispatch-lease fence, so removing the status check
    // left it green — two fences guarding one path means neither is proven.
    // Here the lease is explicitly cleared, so the status check is the only
    // thing standing between a re-delivery and a second execution.
    await insertRunWithStartContext(storage, makeRun({ runId: 'terminal' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('terminal'))!.nextAttemptAt;
    const deps = { storage, hostSuite: stubHostSuite() };

    await sweepDispatchOutbox(deps, 'instance-a', due);
    await flush();
    expect((await storage.getRun('terminal'))!.status).toBe('completed');
    await storage.setRunDispatchLease('terminal', null, null);

    expect(await sweepDispatchOutbox(deps, 'instance-b', due + 60_001)).toBe(0);
    await flush();
    expect((await storage.listEvents('terminal', { limit: 100 })).filter((e) => e.type === 'run.started')).toHaveLength(1);
    expect(await storage.getDispatchOutbox('terminal')).toBeNull();
  });

  it('keeps the intent pending until it can SEE the run start, then retires it', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'observed' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('observed'))!.nextAttemptAt;
    const deps = { storage, hostSuite: stubHostSuite() };

    await sweepDispatchOutbox(deps, 'instance-a', due);
    // Still pending immediately after the handoff: the worker has dispatched
    // but has no evidence yet. If it retired the row here, a crash between the
    // handoff and `executeRun` would lose the intent silently.
    expect((await storage.getDispatchOutbox('observed'))?.status).toBe('pending');

    await flush();
    await sweepDispatchOutbox(deps, 'instance-a', due + 60_001);
    expect(await storage.getDispatchOutbox('observed')).toBeNull();
  });

  it('stops re-dispatching a run that never leaves pending, instead of looping', async () => {
    // The degraded path this bounds. `executeRun` records a start durably in TWO
    // places — the `running` status write and the dispatch lease — and the
    // worker treats either as evidence. So the loop needs BOTH to fail, which is
    // what this proxy models. (Neutering only `updateRun` does NOT reproduce it:
    // the lease still lands, the live-lease fence fires, and the row is retired
    // after one dispatch. That was this test's first draft, and it was measuring
    // nothing.)
    //
    // With both gone the run is permanently `pending` and unowned, so every
    // delivery dispatches again. Before the attempt count that repeated until
    // the orphan lane's one-hour abandon ceiling — `attempts` existed but was
    // never consumed on the dispatch path.
    const stuck: Storage = new Proxy(storage, {
      get(target, prop, recv) {
        if (prop === 'updateRun') return async () => { /* the status write never lands */ };
        if (prop === 'setRunDispatchLease') return async () => { /* nor the lease */ };
        // ADR 0740 — the dispatch-time lease now lands through the execution claim,
        // so "the lease never lands" has to neuter that too. `missing` makes
        // `executeRun` proceed unfenced into the no-op stamp above, which is the
        // permanently-pending-and-unowned run this test exists to model.
        if (prop === 'claimRunExecution') return async () => 'missing' as const;
        return Reflect.get(target, prop, recv);
      },
    });
    await insertRunWithStartContext(stuck, makeRun({ runId: 'looping' }), { enqueueDispatch: true });
    const deps = { storage: stuck, hostSuite: stubHostSuite() };
    let at = (await storage.getDispatchOutbox('looping'))!.nextAttemptAt;

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await sweepDispatchOutbox(deps, 'w1', at)).toBe(1);
      await flush();
      const row = await storage.getDispatchOutbox('looping');
      expect(row?.attempts).toBe(attempt);
      expect(row?.status).toBe(attempt >= 5 ? 'dead' : 'pending');
      at = row!.nextAttemptAt;
    }
    // Dead: no further delivery, however far the clock advances.
    expect(await sweepDispatchOutbox(deps, 'w1', at + 86_400_000)).toBe(0);
    expect((await storage.getRun('looping'))!.status).toBe('pending');
  });

  it('refuses to dispatch a pending run that an instance already holds a live lease on', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'held' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('held'))!.nextAttemptAt;
    // An instance is between `run.started` and the status write.
    await storage.setRunDispatchLease('held', 'instance-a', due + 600_000);

    expect(await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'instance-b', due)).toBe(0);
    await flush();
    expect((await storage.listEvents('held', { limit: 100 })).filter((e) => e.type === 'run.started')).toHaveLength(0);
    // The intent is discharged: an owner exists, and the orphan lane covers it
    // from here if that owner dies.
    expect(await storage.getDispatchOutbox('held')).toBeNull();
  });

  it('discharges an intent whose run no longer exists', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'gone' }), { enqueueDispatch: true });
    const due = (await storage.getDispatchOutbox('gone'))!.nextAttemptAt;
    await storage.deleteRun('gone');

    expect(await sweepDispatchOutbox({ storage, hostSuite: stubHostSuite() }, 'w1', due)).toBe(0);
    expect(await storage.getDispatchOutbox('gone')).toBeNull();
  });

  it('retries, then marks dead, an intent whose workflow cannot be resolved', async () => {
    await insertRunWithStartContext(storage, makeRun({ runId: 'unresolvable' }), { enqueueDispatch: true });
    const deps = { storage, hostSuite: stubHostSuite(async () => null) };
    let at = (await storage.getDispatchOutbox('unresolvable'))!.nextAttemptAt;

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await sweepDispatchOutbox(deps, 'w1', at)).toBe(0);
      const row = await storage.getDispatchOutbox('unresolvable');
      expect(row?.attempts).toBe(attempt);
      expect(row?.lastError).toContain('workflow not found');
      // Dead on the 5th attempt (OUTBOX_MAX_ATTEMPTS) — not deleted, so the
      // undischarged intent stays visible to an operator.
      expect(row?.status).toBe(attempt >= 5 ? 'dead' : 'pending');
      at = row!.nextAttemptAt;
    }
    // A dead row is never delivered again, however long you wait.
    expect(await storage.claimDispatchOutbox('w1', at + 86_400_000, 60_000, 10)).toEqual([]);
  });
});

describe('ADR 0551 P1 — forward migration onto a real pre-outbox database', () => {
  it('creates dispatch_outbox on a deployment pinned before mig 40', () => {
    // A REAL fully-migrated schema rewound to v39 with the new table removed —
    // never a hand-rolled `CREATE TABLE runs (…)`, which models a database that
    // has never existed and broke three times in a row (see `_legacyDbFixture`).
    const db = legacyDbAtVersion(39, { dropTables: ['dispatch_outbox'] });
    expect(tableExists(db, 'dispatch_outbox')).toBe(false);

    applyMigrations(db);

    expect(tableExists(db, 'dispatch_outbox')).toBe(true);
    expect(columns(db, 'dispatch_outbox')).toEqual([
      'attempts', 'claim_expires_at', 'claimed_by', 'created_at', 'last_error',
      'next_attempt_at', 'run_id', 'status', 'tenant_id', 'updated_at', 'workflow_id',
    ]);
    // The due-scan index the claim query depends on. Without it the claim is a
    // full table scan on every tick of every instance.
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_outbox'`).all() as { name: string }[])
      .map((r) => r.name);
    expect(indexes).toContain('idx_dispatch_outbox_due');
    // `status` is constrained, not free text: an unknown state must be a write
    // error rather than a row nobody can interpret.
    expect(() => db.prepare(
      `INSERT INTO dispatch_outbox (run_id, tenant_id, workflow_id, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ('r','t','w','dispatched',0,0,'now','now')`,
    ).run()).toThrow();
    db.close();
  });

  it('the migration is at the head of the map (it will actually run)', () => {
    // The `recipient_role` class of drift: a migration defined past
    // LATEST_SCHEMA_VERSION is never executed. LATEST is derived, so this
    // asserts the outbox landed at the head rather than in a gap.
    // 41 = idx_audit_resource_ts (the RCL F2 subject pushdown, PR #3409).
    //
    // v2 charter P4-D: bumped to 45 (`webhooks.protocol_major`, the subscriber's
    // contract major — a delivery is an emission with no header to negotiate from).
    // v2 charter P4-C: bumped to 44 (`runs.event_log_schema_version`, the era key).
    // ADR 0618: bumped to 43 (`invocation_claim`, the Layer-2 atomic claim).
    // ADR 0591: bumped to 42 (`effect_escape_ledger`). Re-pinning the literal
    // keeps the assertion honest for the OUTBOX — what it must prove is that
    // migration 41 is reachable, i.e. at or below the head, not that 41 IS the
    // head forever. Asserting `>= 41` instead would go permanently green and
    // stop detecting the `recipient_role` drift class this test exists for
    // (a migration defined PAST the head never runs), so the literal stays and
    // moves with each new migration.
    // RFC 0187 webhook wire-id durability: migration 46 persists the exact
    // tenant-bound subscription id emitted by retries after restart.
    // ADR 0747 (RFC 0201): bumped to 47 (`webhooks.signature_algorithms` + the
    // rotation columns).
    // ADR 0752 P2 (RFC 0215 §A.3): bumped to 48 (`webhook_deliveries.tenant_id`).
    expect(LATEST_SCHEMA_VERSION).toBe(48);
  });
});
