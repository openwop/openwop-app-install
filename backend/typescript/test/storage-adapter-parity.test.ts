/**
 * Storage adapter parity — SQLite vs Postgres (via pg-mem).
 *
 * The workflow-engine ships two storage backends:
 *   - sqlite (better-sqlite3) — `src/storage/sqlite/index.ts`
 *     The default for local dev + the single-process tier of app.openwop.dev.
 *   - postgres (pg) — `src/storage/postgres/index.ts`
 *     The Cloud SQL target for the multi-process / signed-in tier.
 *
 * Both implement the same `Storage` interface in `src/storage/storage.ts`.
 * This file runs the same operations against both and asserts identical
 * observable behavior, guarding the contract:
 *
 *   "the executor + routes don't care about the backing store"
 *
 * Coverage:
 *   - runs lifecycle (insert → get → update → list)
 *   - events atomic append + sequence ordering
 *   - interrupts insert → tokenized lookup → resolve
 *   - idempotency claim (insert-or-return-existing)
 *   - audit append (write-only)
 *   - secrets upsert → get → delete → list
 *   - tenant-scoped secrets isolation
 *   - tenant hard delete cascade
 *   - tenant reassign (anon → user migration)
 *
 * Postgres backend is exercised via `pg-mem` (in-memory Postgres
 * implementation, dev dependency). No live Postgres required.
 *
 * Sequence assertions use deltas, not absolute values: both backends
 * implement strict monotonicity per-runId, but the starting offset
 * (`0` vs `1`) is impl-defined. The contract is "+1 per append," not
 * "starts at 0."
 *
 * @see src/storage/storage.ts
 * @see src/storage/sqlite/index.ts
 * @see src/storage/postgres/index.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Inject pg-mem as the `pg` module BEFORE any import of the storage
// adapter resolves the real `pg`. `vi.hoisted` lets us create the
// pg-mem singleton at the top of the hoisted block so the factory can
// reference it without TDZ error.
const { pgMemAdapters } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { newDb } = require('pg-mem') as typeof import('pg-mem');
  const db = newDb();
  return { pgMemAdapters: db.adapters.createPg() };
});
vi.mock('pg', () => ({ default: pgMemAdapters, ...pgMemAdapters }));

import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord, InterruptRecord, WebhookSubscriptionRecord } from '../src/types.js';

const baseTime = '2026-05-18T10:00:00.000Z';

function mkRun(suffix: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: `run-${suffix}`,
    workflowId: `wf.${suffix}`,
    tenantId: 'tenant-a',
    status: 'pending',
    inputs: { hello: suffix },
    metadata: {},
    configurable: {},
    createdAt: baseTime,
    updatedAt: baseTime,
    ...overrides,
  };
}

function mkInterrupt(runId: string, nodeId: string): InterruptRecord {
  return {
    interruptId: `int-${runId}-${nodeId}`,
    runId,
    nodeId,
    kind: 'approval',
    token: `tok-${runId}-${nodeId}`,
    data: { prompt: 'go?' },
    createdAt: baseTime,
  };
}

function mkWebhook(id: string): WebhookSubscriptionRecord {
  return {
    subscriptionId: `sub-${id}`,
    tenantId: 'default',
    url: `https://example.test/webhook/${id}`,
    events: ['run.completed', 'run.failed'],
    secret: 'whsec_test',
    createdAt: baseTime,
  };
}

// Vitest collects tests synchronously at parse time, so `it.each` MUST
// receive a static array. We use a backend-name list and look up the
// live Storage via the map populated in beforeAll.
const backendNames = ['sqlite', 'postgres'] as const;
type BackendName = (typeof backendNames)[number];
const storages = new Map<BackendName, Storage>();

beforeAll(async () => {
  storages.set('sqlite', await openSqliteStorage(':memory:'));
  storages.set('postgres', await openPostgresStorage('postgres://test/test'));
});

afterAll(async () => {
  for (const s of storages.values()) {
    try {
      await s.close();
    } catch {
      // close errors aren't load-bearing here.
    }
  }
});

function S(name: BackendName): Storage {
  const s = storages.get(name);
  if (!s) throw new Error(`storage for ${name} not initialized`);
  return s;
}

/** pg-mem incompatibility filter. Some Postgres-adapter SQL patterns
 *  rely on real-Postgres behavior pg-mem doesn't fully model (JSONB
 *  array param auto-stringification; `WITH ... INSERT ... RETURNING`
 *  CTE atomicity; `INSERT ... ON CONFLICT DO NOTHING RETURNING`
 *  ordering; cascading DELETE coverage). Running against a real
 *  Postgres (via testcontainers or live Cloud SQL) would exercise
 *  these — the parity harness is set up for that future drop-in.
 *
 *  Affected tests are listed here so the harness still surfaces the
 *  remaining 30 (15 sqlite + 15 postgres) and documents the gap. */
const PG_MEM_INCOMPAT = new Set<string>([
  'appendEvent assigns +1 per call (impl-defined offset)',
  'listEvents returns sequence-ordered events',
  'getMaxSequence increases monotonically per append',
  // ADR 0754 — needs appendEvent (above); real Postgres runs it in the
  // testcontainers parity file.
  'findFirstEventByPayload finds the first matching event',
  'first call claims; second returns existing',
  'putOnce upgrades the pending placeholder',
  'insertWebhook → getWebhook round-trips',
  'deleteWebhook removes the row',
  // WHD-16 — a data-modifying CTE (`WITH … DELETE … DELETE`), which pg-mem
  // rejects; the statement was run against a REAL Postgres 16 when it landed.
  'deleteWebhook drops pending deliveries',
  'deleteAllTenantData cascades runs + events + interrupts + secrets',
  // ADR 0551 P1 — the outbox claim uses `FOR UPDATE SKIP LOCKED`, which pg-mem
  // rejects outright (it refuses ASTs it would silently ignore). The claim is
  // covered against a REAL Postgres in the testcontainers parity file; the
  // sqlite half runs here.
  'dispatch outbox claim \u2192 reschedule \u2192 complete',
]);
function skipPgMem(name: BackendName, testName: string): boolean {
  return name === 'postgres' && PG_MEM_INCOMPAT.has(testName);
}

// Track which PG_MEM_INCOMPAT entries were consumed by at least one
// `trackedSkipPgMem(...)` call. After the suite collection finishes, the
// guard test below verifies every key was matched — guarding against
// silent breakage when a test is renamed and the skip stops applying.
const _pgMemIncompatHits = new Set<string>();
const _origSkipPgMem = skipPgMem;
function trackedSkipPgMem(name: BackendName, testName: string): boolean {
  if (PG_MEM_INCOMPAT.has(testName)) _pgMemIncompatHits.add(testName);
  return _origSkipPgMem(name, testName);
}

describe('Storage parity: runs lifecycle', () => {
  it.each(backendNames)('%s: insertRun → getRun returns identical record', async (name) => {
    const s = S(name);
    const run = mkRun(`parity-1-${name}`);
    await s.insertRun(run);
    const got = await s.getRun(run.runId);
    expect(got).not.toBeNull();
    expect(got?.runId).toBe(run.runId);
    expect(got?.workflowId).toBe(run.workflowId);
    expect(got?.tenantId).toBe(run.tenantId);
    expect(got?.status).toBe('pending');
    expect(got?.inputs).toEqual({ hello: `parity-1-${name}` });
  });

  it.each(backendNames)('%s: updateRun patches fields atomically', async (name) => {
    const s = S(name);
    const run = mkRun(`parity-update-${name}`);
    await s.insertRun(run);
    await s.updateRun(run.runId, { status: 'running', currentNodeId: 'node-2' });
    const got = await s.getRun(run.runId);
    expect(got?.status).toBe('running');
    expect(got?.currentNodeId).toBe('node-2');
    expect(got?.workflowId).toBe(run.workflowId);
  });

  it.each(backendNames)('%s: getRun returns null for unknown id', async (name) => {
    const got = await S(name).getRun('run-does-not-exist');
    expect(got).toBeNull();
  });

  // ADR 0551 P1 — the dispatch outbox has to behave identically on both
  // adapters, because the durability guarantee is stated per deployment and
  // Postgres is the one production actually runs. The claim path in particular
  // is written twice (one sqlite write transaction vs `FOR UPDATE SKIP
  // LOCKED`), which is exactly the shape that drifts unnoticed.
  it.each(backendNames)('%s: insertRun with a dispatch intent writes both rows', async (name) => {
    const s = S(name);
    const run = mkRun(`parity-outbox-${name}`);
    await s.insertRun(run, { dispatchOutbox: { nextAttemptAt: 1_000 } });

    expect((await s.getRun(run.runId))?.runId).toBe(run.runId);
    expect(await s.getDispatchOutbox(run.runId)).toMatchObject({
      runId: run.runId,
      tenantId: run.tenantId,
      workflowId: run.workflowId,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 1_000,
      claimedBy: null,
      claimExpiresAt: null,
    });
  });

  it.each(backendNames)('%s: insertRun without a dispatch intent writes no outbox row', async (name) => {
    const s = S(name);
    const run = mkRun(`parity-no-outbox-${name}`);
    await s.insertRun(run);
    expect(await s.getDispatchOutbox(run.runId)).toBeNull();
  });

  it.each(backendNames)('%s: dispatch outbox claim → reschedule → complete', async (name) => {
    if (trackedSkipPgMem(name, 'dispatch outbox claim → reschedule → complete')) return;
    const s = S(name);
    const run = mkRun(`parity-outbox-claim-${name}`);
    await s.insertRun(run, { dispatchOutbox: { nextAttemptAt: 1_000 } });

    // Not due yet.
    expect(await s.claimDispatchOutbox('w1', 999, 60_000, 10)).toEqual([]);
    // Due → claimed, with a lease.
    const claimed = await s.claimDispatchOutbox('w1', 1_000, 60_000, 10);
    expect(claimed.map((r) => r.runId)).toContain(run.runId);
    expect((await s.getDispatchOutbox(run.runId))?.claimExpiresAt).toBe(61_000);
    // Leased → invisible to the next claimer.
    expect((await s.claimDispatchOutbox('w2', 1_001, 60_000, 10)).map((r) => r.runId)).not.toContain(run.runId);

    await s.rescheduleDispatchOutbox(run.runId, 5_000, false, 'try again');
    expect(await s.getDispatchOutbox(run.runId)).toMatchObject({
      status: 'pending', attempts: 1, nextAttemptAt: 5_000, claimedBy: null, claimExpiresAt: null, lastError: 'try again',
    });

    await s.rescheduleDispatchOutbox(run.runId, 9_000, true, 'gave up');
    expect((await s.getDispatchOutbox(run.runId))?.status).toBe('dead');
    // A dead row is never claimed again, however far the clock advances.
    expect((await s.claimDispatchOutbox('w3', 10_000_000, 60_000, 10)).map((r) => r.runId)).not.toContain(run.runId);

    await s.completeDispatchOutbox(run.runId);
    expect(await s.getDispatchOutbox(run.runId)).toBeNull();
    // Idempotent — a duplicate delivery must not fail on the second retire.
    await s.completeDispatchOutbox(run.runId);
  });

  it.each(backendNames)('%s: listRuns filters by tenantId', async (name) => {
    const s = S(name);
    await s.insertRun(mkRun(`list-a-1-${name}`, { tenantId: `list-tenant-a-${name}` }));
    await s.insertRun(mkRun(`list-a-2-${name}`, { tenantId: `list-tenant-a-${name}` }));
    await s.insertRun(mkRun(`list-b-1-${name}`, { tenantId: `list-tenant-b-${name}` }));
    const aRuns = await s.listRuns({ tenantId: `list-tenant-a-${name}` });
    const bRuns = await s.listRuns({ tenantId: `list-tenant-b-${name}` });
    expect(aRuns.length).toBe(2);
    expect(bRuns.length).toBe(1);
    expect(aRuns.every((r) => r.tenantId === `list-tenant-a-${name}`)).toBe(true);
  });

  // ADR 0287 correction — retention must retire a run's ARTIFACT rows
  // (hostext:runartifact:<runId>:<nodeId>) with the run: the original cascade
  // deleted only the three exact-key write-throughs, stranding every artifact
  // forever (48k orphans-in-waiting found in prod 2026-07-15). Another run's
  // artifacts and non-artifact kv must survive.
  it.each(backendNames)('%s: pruneTerminalRuns retires the run\'s artifact kv rows only', async (name) => {
    const s = S(name);
    const old = mkRun(`art-old-${name}`, { status: 'completed', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z' });
    const kept = mkRun(`art-kept-${name}`, { status: 'running' });
    await s.insertRun(old);
    await s.insertRun(kept);
    await s.kvSet(`hostext:runartifact:${old.runId}:node-a`, '{"a":1}');
    await s.kvSet(`hostext:runartifact:${old.runId}:node-b`, '{"b":2}');
    await s.kvSet(`hostext:runartifact:${kept.runId}:node-a`, '{"keep":true}');
    await s.kvSet(`hostext:runartifactother:${old.runId}`, '{"not-an-artifact-collection":true}');
    const res = await s.pruneTerminalRuns('2021-01-01T00:00:00.000Z', 10);
    // The ARTIFACT cascade (per-run LIKE deletes — the new behavior under test)
    // is asserted on BOTH backends below. The run-row + `= ANY(...)` child
    // deletes are asserted on sqlite only: pg-mem does not implement
    // `DELETE … WHERE x = ANY($1)` (silent no-op), so real-Postgres coverage
    // for those lives in the live-container retention test (ci:full).
    expect(res.childRows).toBeGreaterThanOrEqual(2);
    if (name === 'sqlite') {
      expect(res.runs).toBe(1);
      expect(await s.getRun(old.runId)).toBeNull();
    }
    expect(await s.kvGet(`hostext:runartifact:${old.runId}:node-a`)).toBeNull();
    expect(await s.kvGet(`hostext:runartifact:${old.runId}:node-b`)).toBeNull();
    expect(await s.kvGet(`hostext:runartifact:${kept.runId}:node-a`)).not.toBeNull();
    expect(await s.kvGet(`hostext:runartifactother:${old.runId}`)).not.toBeNull();
  });

  // listRunsByParent replaced the O(tenant) listRuns+filter child scan in the
  // run snapshot + cancel cascade (the 2026-07-14 statement-timeout incident) —
  // it must return exactly the children of the given parent, nothing else.
  it.each(backendNames)('%s: listRunsByParent returns only that parent\'s children', async (name) => {
    const s = S(name);
    const parent = mkRun(`byparent-parent-${name}`);
    await s.insertRun(parent);
    await s.insertRun(mkRun(`byparent-child-1-${name}`, { parentRunId: parent.runId }));
    await s.insertRun(mkRun(`byparent-child-2-${name}`, { parentRunId: parent.runId }));
    await s.insertRun(mkRun(`byparent-other-${name}`, { parentRunId: `byparent-not-this-${name}` }));
    await s.insertRun(mkRun(`byparent-orphan-${name}`));
    const children = await s.listRunsByParent(parent.runId);
    expect(children.map((r) => r.runId).sort()).toEqual([
      `run-byparent-child-1-${name}`,
      `run-byparent-child-2-${name}`,
    ]);
    expect(await s.listRunsByParent(`byparent-no-children-${name}`)).toEqual([]);
  });
});

describe('Storage parity: events monotonic sequence', () => {
  it.each(backendNames)('%s: appendEvent assigns +1 per call (impl-defined offset)', async (name) => {
    if (trackedSkipPgMem(name, 'appendEvent assigns +1 per call (impl-defined offset)')) return;
    const s = S(name);
    const run = mkRun(`event-seq-${name}`);
    await s.insertRun(run);
    const e1 = await s.appendEvent({ runId: run.runId, type: 'run.started', payload: {}, timestamp: baseTime, eventId: 'e1' });
    const e2 = await s.appendEvent({ runId: run.runId, type: 'node.started', payload: { nodeId: 'n1' }, timestamp: baseTime, eventId: 'e2' });
    const e3 = await s.appendEvent({ runId: run.runId, type: 'run.completed', payload: {}, timestamp: baseTime, eventId: 'e3' });
    // Both backends: strict monotonicity per-runId, +1 per append.
    // Offset (0 vs 1) is impl-defined.
    expect(e2.sequence - e1.sequence).toBe(1);
    expect(e3.sequence - e2.sequence).toBe(1);
    expect(e1.sequence).toBeGreaterThanOrEqual(0);
  });

  it.each(backendNames)('%s: listEvents returns sequence-ordered events', async (name) => {
    if (trackedSkipPgMem(name, 'listEvents returns sequence-ordered events')) return;
    const s = S(name);
    const run = mkRun(`event-list-${name}`);
    await s.insertRun(run);
    await s.appendEvent({ runId: run.runId, type: 'run.started', payload: {}, timestamp: baseTime, eventId: 'el1' });
    await s.appendEvent({ runId: run.runId, type: 'run.completed', payload: {}, timestamp: baseTime, eventId: 'el2' });
    const events = await s.listEvents(run.runId);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe('run.started');
    expect(events[1]?.type).toBe('run.completed');
    expect(events[0]?.sequence ?? Number.MAX_SAFE_INTEGER).toBeLessThan(events[1]?.sequence ?? -1);
  });

  it.each(backendNames)('%s: findFirstEventByPayload finds the first matching event', async (name) => {
    if (trackedSkipPgMem(name, 'findFirstEventByPayload finds the first matching event')) return;
    const s = S(name);
    const run = mkRun(`event-find-${name}`);
    await s.insertRun(run);
    await s.appendEvent({ runId: run.runId, type: 'artifact.created', payload: { artifactId: 'a-1', n: 1 }, timestamp: baseTime, eventId: 'ef1' });
    await s.appendEvent({ runId: run.runId, type: 'node.completed', payload: { artifactId: 'a-2' }, timestamp: baseTime, eventId: 'ef2' });
    await s.appendEvent({ runId: run.runId, type: 'artifact.created', payload: { artifactId: 'a-2', n: 3 }, timestamp: baseTime, eventId: 'ef3' });
    await s.appendEvent({ runId: run.runId, type: 'artifact.created', payload: { artifactId: 'a-2', n: 4 }, timestamp: baseTime, eventId: 'ef4' });
    // The first of the right TYPE, not the first mention of the value.
    expect((await s.findFirstEventByPayload(run.runId, 'artifact.created', 'artifactId', 'a-2'))?.payload).toEqual({ artifactId: 'a-2', n: 3 });
    expect(await s.findFirstEventByPayload(run.runId, 'artifact.created', 'artifactId', 'nope')).toBeNull();
    expect(await s.findFirstEventByPayload('no-such-run', 'artifact.created', 'artifactId', 'a-1')).toBeNull();
    await expect(s.findFirstEventByPayload(run.runId, 'artifact.created', "x') OR 1=1 --", 'a-1')).rejects.toThrow(/invalid payload key/);
  });

  it.each(backendNames)('%s: getMaxSequence increases monotonically per append', async (name) => {
    if (trackedSkipPgMem(name, 'getMaxSequence increases monotonically per append')) return;
    const s = S(name);
    const run = mkRun(`event-max-${name}`);
    await s.insertRun(run);
    const initialMax = await s.getMaxSequence(run.runId);
    await s.appendEvent({ runId: run.runId, type: 'run.started', payload: {}, timestamp: baseTime, eventId: 'em1' });
    const afterFirst = await s.getMaxSequence(run.runId);
    expect(afterFirst).toBeGreaterThan(initialMax);
    await s.appendEvent({ runId: run.runId, type: 'node.started', payload: {}, timestamp: baseTime, eventId: 'em2' });
    const afterSecond = await s.getMaxSequence(run.runId);
    expect(afterSecond - afterFirst).toBe(1);
  });
});

describe('Storage parity: interrupts', () => {
  it.each(backendNames)('%s: insertInterrupt → getInterruptByToken round-trips', async (name) => {
    const s = S(name);
    const run = mkRun(`int-${name}`);
    await s.insertRun(run);
    const int = mkInterrupt(run.runId, 'n1');
    await s.insertInterrupt(int);
    const got = await s.getInterruptByToken(int.token);
    expect(got).not.toBeNull();
    expect(got?.interruptId).toBe(int.interruptId);
    expect(got?.runId).toBe(run.runId);
    expect(got?.kind).toBe('approval');
  });

  it.each(backendNames)('%s: resolveInterrupt updates resolvedAt + resolvedValue', async (name) => {
    const s = S(name);
    const run = mkRun(`int-resolve-${name}`);
    await s.insertRun(run);
    const int = mkInterrupt(run.runId, 'n2');
    await s.insertInterrupt(int);
    await s.resolveInterrupt(int.interruptId, { decision: 'approve' }, baseTime);
    const got = await s.getInterrupt(int.interruptId);
    expect(got?.resolvedAt).toBe(baseTime);
    expect((got?.resolvedValue as Record<string, unknown> | undefined)?.decision).toBe('approve');
  });

  it.each(backendNames)('%s: listOpenInterrupts excludes resolved', async (name) => {
    const s = S(name);
    const run = mkRun(`int-open-${name}`);
    await s.insertRun(run);
    const i1 = mkInterrupt(run.runId, `open-1-${name}`);
    const i2 = mkInterrupt(run.runId, `open-2-${name}`);
    await s.insertInterrupt(i1);
    await s.insertInterrupt(i2);
    await s.resolveInterrupt(i1.interruptId, { ok: true }, baseTime);
    const open = await s.listOpenInterrupts(run.runId);
    const ids = open.map((i) => i.interruptId);
    expect(ids).toContain(i2.interruptId);
    expect(ids).not.toContain(i1.interruptId);
  });
});

describe('Storage parity: idempotency claim', () => {
  it.each(backendNames)('%s: first call claims; second returns existing', async (name) => {
    if (trackedSkipPgMem(name, 'first call claims; second returns existing')) return;
    const s = S(name);
    const key = `idem-${name}-${Math.random().toString(36).slice(2)}`;
    const first = await s.claimOnce(key, baseTime);
    expect(first.claimed).toBe(true);
    expect(first.existing).toBeNull();
    const second = await s.claimOnce(key, baseTime);
    expect(second.claimed).toBe(false);
    expect(second.existing).not.toBeNull();
  });

  it.each(backendNames)('%s: putOnce upgrades the pending placeholder', async (name) => {
    if (trackedSkipPgMem(name, 'putOnce upgrades the pending placeholder')) return;
    const s = S(name);
    const key = `idem-upgrade-${name}-${Math.random().toString(36).slice(2)}`;
    await s.claimOnce(key, baseTime);
    await s.putOnce({
      key,
      responseBody: '{"runId":"r-upgrade"}',
      responseStatus: 201,
      createdAt: baseTime,
    });
    const second = await s.claimOnce(key, baseTime);
    expect(second.existing?.responseBody).toBe('{"runId":"r-upgrade"}');
    expect(second.existing?.responseStatus).toBe(201);
  });
});

describe('Storage parity: webhooks', () => {
  it.each(backendNames)('%s: insertWebhook → getWebhook round-trips', async (name) => {
    if (trackedSkipPgMem(name, 'insertWebhook → getWebhook round-trips')) return;
    const s = S(name);
    const wh = mkWebhook(`${name}-1`);
    await s.insertWebhook(wh);
    const got = await s.getWebhook(wh.subscriptionId);
    expect(got?.url).toBe(wh.url);
    expect(got?.events).toEqual(wh.events);
  });

  it.each(backendNames)('%s: deleteWebhook removes the row', async (name) => {
    if (trackedSkipPgMem(name, 'deleteWebhook removes the row')) return;
    const s = S(name);
    const wh = mkWebhook(`${name}-delete`);
    await s.insertWebhook(wh);
    await s.deleteWebhook(wh.subscriptionId);
    expect(await s.getWebhook(wh.subscriptionId)).toBeNull();
  });

  // WHD-16 — unregistering STOPS delivery. Pending rows of a deleted
  // subscription kept POSTing to the withdrawn URL and starved live
  // subscriptions (MEASURED in production: 1,600 failed attempts to one dead
  // receiver in 20 min, after its subscriptions were deleted).
  it.each(backendNames)('%s: deleteWebhook drops that subscription’s PENDING deliveries only', async (name) => {
    if (trackedSkipPgMem(name, 'deleteWebhook drops pending deliveries')) return;
    const s = S(name);
    const gone = mkWebhook(`${name}-gone`);
    const kept = mkWebhook(`${name}-kept`);
    await s.insertWebhook(gone);
    await s.insertWebhook(kept);
    const t = 1_700_000_000_000;
    const row = (id: string, sub: string, status: 'pending' | 'delivered' | 'dead') => ({
      deliveryId: `${name}-${id}`, subscriptionId: sub, url: 'https://x.test/hook', secret: 's', eventType: 'run.completed',
      payload: '{}', status, attempts: 1, maxAttempts: 5, nextAttemptAt: t, createdAt: t, updatedAt: t,
    });
    await s.enqueueWebhookDelivery(row('p1', gone.subscriptionId, 'pending'));
    await s.enqueueWebhookDelivery(row('p2', gone.subscriptionId, 'pending'));
    await s.enqueueWebhookDelivery(row('dead', gone.subscriptionId, 'dead'));
    await s.enqueueWebhookDelivery(row('other', kept.subscriptionId, 'pending'));

    await s.deleteWebhook(gone.subscriptionId);

    const claimed = await s.claimDueWebhookDeliveries(`w-${name}`, t + 1, 60_000, 50);
    const mine = claimed.filter((c) => c.deliveryId.startsWith(`${name}-`)).map((c) => c.deliveryId);
    expect(mine, 'only the surviving subscription’s pending row is still deliverable').toEqual([`${name}-other`]);
    // History survives: the dead row is not a pending delivery, so it stays.
    expect(await s.pruneWebhookDeliveries(t + 1)).toBeGreaterThanOrEqual(1);
  });

  // RFC 0201 §E.20 / ADR 0747 — rotation is ONE statement, so a second rotation
  // inside an overlap retires the OLDEST secret; and the opt-in list survives
  // the round trip (absent stays absent — §B.8).
  it.each(backendNames)('%s: rotateWebhookSecret shifts current → previous in one statement', async (name) => {
    if (trackedSkipPgMem(name, 'rotateWebhookSecret shifts current → previous')) return;
    const s = S(name);
    const plain = mkWebhook(`${name}-plain`);
    await s.insertWebhook(plain);
    expect((await s.getWebhook(plain.subscriptionId))?.signatureAlgorithms).toBeUndefined();
    const wh = { ...mkWebhook(`${name}-rot`), secret: 's1', signatureAlgorithms: ['v1', 'standard-webhooks-1'] };
    await s.insertWebhook(wh);
    expect(await s.rotateWebhookSecret(wh.subscriptionId, { secret: 's2', rotatedAt: 10, previousSecretExpiresAt: 70 })).toBe(true);
    expect(await s.rotateWebhookSecret(wh.subscriptionId, { secret: 's3', rotatedAt: 20, previousSecretExpiresAt: 80 })).toBe(true);
    const got = await s.getWebhook(wh.subscriptionId);
    expect(got?.signatureAlgorithms).toEqual(['v1', 'standard-webhooks-1']);
    expect([got?.secret, got?.previousSecret, got?.rotatedAt, got?.previousSecretExpiresAt]).toEqual(['s3', 's2', 20, 80]);
    expect(await s.rotateWebhookSecret(`${name}-missing`, { secret: 'x', rotatedAt: 1, previousSecretExpiresAt: 2 })).toBe(false);
  });

  // `/grade-data` 2026-09-26 WHROT-1 — a retired previous secret leaves the row
  // once its overlap ends; an in-overlap one (and the rotation history) stays.
  it.each(backendNames)('%s: retireExpiredWebhookSecrets clears only lapsed previous secrets', async (name) => {
    if (trackedSkipPgMem(name, 'retireExpiredWebhookSecrets clears lapsed previous secrets')) return;
    const s = S(name);
    const lapsed = { ...mkWebhook(`${name}-lapsed`), secret: 'a1', signatureAlgorithms: ['v1', 'standard-webhooks-1'] };
    const live = { ...mkWebhook(`${name}-live`), secret: 'b1', signatureAlgorithms: ['v1', 'standard-webhooks-1'] };
    await s.insertWebhook(lapsed);
    await s.insertWebhook(live);
    await s.rotateWebhookSecret(lapsed.subscriptionId, { secret: 'a2', rotatedAt: 10, previousSecretExpiresAt: 50 });
    await s.rotateWebhookSecret(live.subscriptionId, { secret: 'b2', rotatedAt: 10, previousSecretExpiresAt: 500 });
    expect(await s.retireExpiredWebhookSecrets(100)).toBeGreaterThanOrEqual(1);
    const a = await s.getWebhook(lapsed.subscriptionId);
    expect([a?.secret, a?.previousSecret, a?.rotatedAt, a?.previousSecretExpiresAt]).toEqual(['a2', undefined, 10, 50]);
    expect((await s.getWebhook(live.subscriptionId))?.previousSecret).toBe('b1');
  });

  // WHROT-2 — a delivered row keeps no copy of the secret it was enqueued with.
  it.each(backendNames)('%s: markWebhookDeliveryDelivered blanks the enqueue-time secret copy', async (name) => {
    if (trackedSkipPgMem(name, 'markWebhookDeliveryDelivered blanks the secret copy')) return;
    const s = S(name);
    const t = 1_700_000_000_000;
    const deliveryId = `${name}-blank`;
    await s.enqueueWebhookDelivery({
      deliveryId, subscriptionId: `${name}-blank-sub`, url: 'https://x.test/hook', secret: 'sealed-copy', eventType: 'run.completed',
      payload: '{}', status: 'pending', attempts: 0, maxAttempts: 5, nextAttemptAt: t, createdAt: t, updatedAt: t,
    });
    await s.markWebhookDeliveryDelivered(deliveryId, t + 1);
    const got = (await s.listWebhookDeliveries({ limit: 500 })).find((d) => d.deliveryId === deliveryId);
    expect(got?.status).toBe('delivered');
    expect(got?.secret).toBe('');
    // A lapsed-lease worker's late failure must not re-arm the delivered row.
    await s.rescheduleWebhookDelivery(deliveryId, t + 2, t + 3, false, 'late failure');
    const after = (await s.listWebhookDeliveries({ limit: 500 })).find((d) => d.deliveryId === deliveryId);
    expect(after?.status).toBe('delivered');
  });

  // WHROT-3 — a row reaching `dead` drops its copy too (a manual retry signs from
  // the subscription), and the backfill reaches terminal rows written before
  // either transition blanked. `pending` rows keep theirs (pre-0747 rollback).
  it.each(backendNames)('%s: dead transition + backfill blank terminal secret copies, pending keeps its copy', async (name) => {
    if (trackedSkipPgMem(name, 'dead transition + backfill blank terminal secret copies')) return;
    const s = S(name);
    const t = 1_700_000_000_000;
    const row = (id: string, status: 'pending' | 'delivered' | 'dead') => ({
      deliveryId: `${name}-w3-${id}`, subscriptionId: `${name}-w3-sub`, url: 'https://x.test/hook', secret: 'sealed-copy', eventType: 'run.completed',
      payload: '{}', status, attempts: 0, maxAttempts: 5, nextAttemptAt: t, createdAt: t, updatedAt: t,
    });
    for (const [id, st] of [['dying', 'pending'], ['old-dead', 'dead'], ['old-done', 'delivered'], ['live', 'pending']] as const) {
      await s.enqueueWebhookDelivery(row(id, st));
    }
    await s.rescheduleWebhookDelivery(`${name}-w3-dying`, t + 1, t + 2, true, 'gave up');
    let drained = 0;
    for (let n = await s.blankTerminalDeliverySecrets(1); n > 0; n = await s.blankTerminalDeliverySecrets(1)) drained += n;
    expect(drained).toBeGreaterThanOrEqual(2);
    const byId = new Map((await s.listWebhookDeliveries({ limit: 500 })).map((d) => [d.deliveryId, d]));
    expect(byId.get(`${name}-w3-dying`)?.status).toBe('dead');
    expect([`${name}-w3-dying`, `${name}-w3-old-dead`, `${name}-w3-old-done`].map((id) => byId.get(id)?.secret)).toEqual(['', '', '']);
    expect(byId.get(`${name}-w3-live`)?.secret).toBe('sealed-copy');
  });
});

describe('Storage parity: BYOK secrets', () => {
  it.each(backendNames)('%s: upsert → get → list → delete cycle', async (name) => {
    const s = S(name);
    const ref = `byok-${name}-${Math.random().toString(36).slice(2)}`;
    await s.upsertEncryptedSecret(ref, '{"encrypted":"opaque"}', baseTime);
    expect(await s.getEncryptedSecret(ref)).toBe('{"encrypted":"opaque"}');
    const refs = await s.listSecretRefs();
    expect(refs).toContain(ref);
    await s.deleteSecret(ref);
    expect(await s.getEncryptedSecret(ref)).toBeNull();
  });

  it.each(backendNames)('%s: tenant-scoped secrets isolate across tenants', async (name) => {
    const s = S(name);
    const ref = `tenant-byok-${name}-${Math.random().toString(36).slice(2)}`;
    await s.upsertTenantSecret(`iso-a-${name}`, ref, '{"v":"A"}', baseTime);
    await s.upsertTenantSecret(`iso-b-${name}`, ref, '{"v":"B"}', baseTime);
    expect(await s.getTenantSecret(`iso-a-${name}`, ref)).toBe('{"v":"A"}');
    expect(await s.getTenantSecret(`iso-b-${name}`, ref)).toBe('{"v":"B"}');
  });
});

describe('Storage parity: audit append', () => {
  it.each(backendNames)('%s: appendAudit is write-only (no throw)', async (name) => {
    await expect(
      S(name).appendAudit({
        timestamp: baseTime,
        principalId: 'pid-1',
        action: 'run.create',
        resource: 'run:r-audit',
        outcome: 'success',
        payload: { workflowId: 'wf.audit' },
      }),
    ).resolves.not.toThrow();
  });
});

describe('Storage parity: tenant hard delete cascade', () => {
  it.each(backendNames)('%s: deleteAllTenantData cascades runs + events + interrupts + secrets', async (name) => {
    if (trackedSkipPgMem(name, 'deleteAllTenantData cascades runs + events + interrupts + secrets')) return;
    const s = S(name);
    const T = `del-tenant-${name}-${Math.random().toString(36).slice(2)}`;
    const r1 = mkRun(`del-1-${name}`, { tenantId: T });
    const r2 = mkRun(`del-2-${name}`, { tenantId: T });
    await s.insertRun(r1);
    await s.insertRun(r2);
    await s.appendEvent({ runId: r1.runId, type: 'run.started', payload: {}, timestamp: baseTime, eventId: `del-ev-${name}-1` });
    await s.insertInterrupt(mkInterrupt(r1.runId, `del-n1-${name}`));
    await s.upsertTenantSecret(T, 'del-ref', '{"v":"x"}', baseTime);

    const counts = await s.deleteAllTenantData(T);
    expect(counts.runs).toBeGreaterThanOrEqual(2);
    expect(counts.events).toBeGreaterThanOrEqual(1);
    expect(counts.interrupts).toBeGreaterThanOrEqual(1);
    expect(counts.secrets).toBeGreaterThanOrEqual(1);

    expect(await s.getRun(r1.runId)).toBeNull();
    expect(await s.getRun(r2.runId)).toBeNull();
    expect(await s.getTenantSecret(T, 'del-ref')).toBeNull();
  });
});

describe('Storage parity: tenant reassign (anon → user migration)', () => {
  it.each(backendNames)('%s: reassignTenant moves runs without losing data', async (name) => {
    const s = S(name);
    const fromT = `anon-${name}-${Math.random().toString(36).slice(2)}`;
    const toT = `user-${name}-${Math.random().toString(36).slice(2)}`;
    await s.insertRun(mkRun(`reassign-1-${name}`, { tenantId: fromT }));
    await s.insertRun(mkRun(`reassign-2-${name}`, { tenantId: fromT }));
    const counts = await s.reassignTenant(fromT, toT);
    expect(counts.runs).toBe(2);
    expect((await s.listRuns({ tenantId: fromT })).length).toBe(0);
    expect((await s.listRuns({ tenantId: toT })).length).toBe(2);
  });

  // ADR 0003 Phase 4c: reassignTenant must move EVERY tenant-scoped column store
  // (not just runs+workflows), else an anon→user signup strands notifications +
  // push subscriptions in the dead anon tenant.
  it.each(backendNames)('%s: reassignTenant also moves notifications + push subscriptions', async (name) => {
    const s = S(name);
    const now = new Date().toISOString();
    const fromT = `anon-${name}-${Math.random().toString(36).slice(2)}`;
    const toT = `user-${name}-${Math.random().toString(36).slice(2)}`;

    await s.insertNotification({ notificationId: `n-${name}`, tenantId: fromT, type: 'system', priority: 'normal', status: 'unread', title: 't', message: 'm', createdAt: now });
    await s.insertPushSubscription({ subscriptionId: `ps-${name}`, tenantId: fromT, endpoint: `https://push.example/${name}`, p256dhKey: 'k', authKey: 'a', createdAt: now });

    const counts = await s.reassignTenant(fromT, toT);
    expect(counts.notifications).toBe(1);
    expect(counts.pushSubscriptions).toBe(1);

    // Source tenant fully drained; destination has them all.
    expect((await s.listNotifications({ tenantId: fromT })).length).toBe(0);
    expect((await s.listNotifications({ tenantId: toT })).length).toBe(1);
    expect((await s.listPushSubscriptions(fromT)).length).toBe(0);
    expect((await s.listPushSubscriptions(toT)).length).toBe(1);
  });

  // ADR 0003 Phase 4c: reassignTenant must ALSO re-key host-ext content rows
  // (CRM/kanban/KB… in host_ext_kv) by their JSON tenantId/orgId — but MUST NOT
  // touch the access-control scaffolding (personal-workspace org + deterministic
  // owner member) whose ROW KEY encodes the tenant (the destination re-seeds it).
  it.each(backendNames)('%s: reassignTenant re-keys host-ext content (tenantId+orgId) but skips access scaffolding', async (name) => {
    const s = S(name);
    const fromT = `anon-${name}-${Math.random().toString(36).slice(2)}`;
    const toT = `user-${name}-${Math.random().toString(36).slice(2)}`;

    // Content: a kanban board scoped to the personal workspace (orgId == tenant).
    await s.kvSet(`hostext:kanban:board:b-${name}`, JSON.stringify({ boardId: `b-${name}`, tenantId: fromT, orgId: fromT, title: 'My board' }));
    // Content with NO orgId (only tenantId) — must still move.
    await s.kvSet(`hostext:roster:r-${name}`, JSON.stringify({ rosterId: `r-${name}`, tenantId: fromT, name: 'Agent' }));
    // Content scoped to a DIFFERENT org (a shared workspace) — orgId must be left alone.
    await s.kvSet(`hostext:kanban:board:shared-${name}`, JSON.stringify({ boardId: `shared-${name}`, tenantId: fromT, orgId: `ws-other-${name}`, title: 'Shared' }));
    // Access-control scaffolding — EXCLUDED (key encodes the tenant).
    await s.kvSet(`hostext:access-orgs:${fromT}`, JSON.stringify({ orgId: fromT, tenantId: fromT, name: 'Personal workspace' }));
    await s.kvSet(`hostext:access-members:mbr-${name}`, JSON.stringify({ memberId: `mbr-${name}`, tenantId: fromT, orgId: fromT, subject: `session:${name}`, roles: ['owner'] }));

    const counts = await s.reassignTenant(fromT, toT);
    expect(counts.hostExt).toBe(3); // board + roster + shared-board (all carry tenantId === from)

    const board = JSON.parse((await s.kvGet(`hostext:kanban:board:b-${name}`))!) as { tenantId: string; orgId: string };
    expect(board.tenantId).toBe(toT);
    expect(board.orgId).toBe(toT); // orgId == tenant → re-keyed

    const roster = JSON.parse((await s.kvGet(`hostext:roster:r-${name}`))!) as { tenantId: string };
    expect(roster.tenantId).toBe(toT);

    const shared = JSON.parse((await s.kvGet(`hostext:kanban:board:shared-${name}`))!) as { tenantId: string; orgId: string };
    expect(shared.tenantId).toBe(toT); // tenant moves
    expect(shared.orgId).toBe(`ws-other-${name}`); // foreign org left untouched

    // Scaffolding untouched — the destination re-seeds its own canonical workspace.
    const org = JSON.parse((await s.kvGet(`hostext:access-orgs:${fromT}`))!) as { tenantId: string };
    expect(org.tenantId).toBe(fromT);
    const member = JSON.parse((await s.kvGet(`hostext:access-members:mbr-${name}`))!) as { tenantId: string };
    expect(member.tenantId).toBe(fromT);
  });

  // ADR 0003 Phase 4c: introspection genuinely broadened coverage — a chat_session
  // (a table the OLD explicit reassign did NOT touch) now migrates, proving the
  // schema-introspected table set closed the silent-strand gap.
  it.each(backendNames)('%s: reassignTenant covers tables beyond the old hardcoded set (chat_sessions)', async (name) => {
    const s = S(name);
    const now = new Date().toISOString();
    const fromT = `anon-chat-${name}-${Math.random().toString(36).slice(2)}`;
    const toT = `user-chat-${name}-${Math.random().toString(36).slice(2)}`;
    await s.createChatSession({ sessionId: `cs-${name}`, tenantId: fromT, title: 'Anon chat', createdAt: now, updatedAt: now, messageCount: 0 });

    const counts = await s.reassignTenant(fromT, toT);
    expect(counts.tables.chat_sessions).toBe(1);
    expect((await s.listChatSessions(fromT)).length).toBe(0);
    expect((await s.listChatSessions(toT)).length).toBe(1);
  });

  // ADR 0003 Phase 4c: the whole re-key is ONE transaction → idempotent. A second
  // run finds nothing under the source and is a clean no-op (signup/bind retries).
  it.each(backendNames)('%s: reassignTenant is idempotent on re-run', async (name) => {
    const s = S(name);
    const fromT = `anon-idem-${name}-${Math.random().toString(36).slice(2)}`;
    const toT = `user-idem-${name}-${Math.random().toString(36).slice(2)}`;
    await s.insertRun(mkRun(`idem-${name}`, { tenantId: fromT }));
    await s.kvSet(`hostext:kanban:board:idem-${name}`, JSON.stringify({ boardId: `idem-${name}`, tenantId: fromT }));

    const first = await s.reassignTenant(fromT, toT);
    expect(first.runs).toBe(1);
    expect(first.hostExt).toBe(1);

    const second = await s.reassignTenant(fromT, toT);
    expect(second.runs).toBe(0);
    expect(second.hostExt).toBe(0);
    // Destination still has exactly the migrated data (not duplicated).
    expect((await s.listRuns({ tenantId: toT })).length).toBe(1);
  });
});

describe('Storage parity: PG_MEM_INCOMPAT skip-set integrity guard', () => {
  // Guard against silent breakage: if a test in PG_MEM_INCOMPAT gets
  // renamed without updating the set, the postgres half stops being
  // skipped and the failure surfaces noisily. This guard runs LAST
  // (vitest preserves file-order); by then every other test has been
  // collected + (for the affected ones) called `trackedSkipPgMem`.
  it('every PG_MEM_INCOMPAT key matches at least one collected test', () => {
    const orphaned: string[] = [];
    for (const key of PG_MEM_INCOMPAT) {
      if (!_pgMemIncompatHits.has(key)) orphaned.push(key);
    }
    expect(
      orphaned,
      `PG_MEM_INCOMPAT keys with no matching test (likely renamed): ${orphaned.join(', ')}`,
    ).toEqual([]);
  });
});

  // Grade-pass DEL-1 — deleteRun (the API delete + workforce teardown path)
  // must cascade exactly like retention: envelope correlations, the agent
  // activity row, and the run's ARTIFACT kv rows all retire with the run;
  // another run's artifacts survive.
  it.each(backendNames)('%s: deleteRun retires artifact kv rows with the run', async (name) => {
    const s = S(name);
    const doomed = mkRun(`del-doomed-${name}`, { status: 'completed' });
    const kept = mkRun(`del-kept-${name}`);
    await s.insertRun(doomed);
    await s.insertRun(kept);
    await s.kvSet(`hostext:runartifact:${doomed.runId}:node-a`, '{"a":1}');
    await s.kvSet(`hostext:runartifact:${kept.runId}:node-a`, '{"keep":true}');
    expect(await s.deleteRun(doomed.runId)).toBe(true);
    expect(await s.getRun(doomed.runId)).toBeNull();
    expect(await s.kvGet(`hostext:runartifact:${doomed.runId}:node-a`)).toBeNull();
    expect(await s.kvGet(`hostext:runartifact:${kept.runId}:node-a`)).not.toBeNull();
  });
