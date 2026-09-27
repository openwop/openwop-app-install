/**
 * Storage adapter parity — SQLite vs real Postgres (via testcontainers).
 *
 * Companion to `storage-adapter-parity.test.ts`, which exercises pg-mem.
 * That file documents 8 SQL patterns pg-mem can't model:
 *   - JSONB array param auto-stringification (webhook `events`)
 *   - `WITH ... INSERT ... RETURNING` CTE atomicity (event sequence)
 *   - `INSERT ... ON CONFLICT DO NOTHING RETURNING` ordering (idempotency claim)
 *   - cascading DELETE coverage (`deleteAllTenantData`)
 *
 * This file targets the same Postgres adapter at a REAL Postgres instance
 * via `@testcontainers/postgresql` so those 8 patterns get exercised
 * end-to-end. Pairs with `PG_MEM_INCOMPAT` in the sibling file: every
 * test here MUST cover a pattern listed there.
 *
 * Docker requirement: testcontainers needs a running Docker daemon.
 * The entire suite soft-skips when Docker isn't reachable, so dev
 * machines without Docker keep `npm test` green while CI (with Docker)
 * exercises the full coverage.
 *
 * Boot cost: pulling postgres:16-alpine on first run is ~80 MB / 30s.
 * Subsequent runs hit the local image cache.
 *
 * @see test/storage-adapter-parity.test.ts (companion; pg-mem coverage)
 * @see src/storage/postgres/index.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { IdempotentClaim } from '../src/host/idempotentResponse.js';
import type { RunRecord, InterruptRecord, WebhookSubscriptionRecord } from '../src/types.js';
import { workspaceEtag } from '../src/host/workspaceStore.js';

// Skip the entire file when Docker isn't reachable. testcontainers does
// its own probe at container-start time, so we replicate the check at
// suite collection time to avoid a 30s timeout when Docker is absent.
function isDockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try {
    // Best-effort probe — only an active daemon returns true; ENOENT,
    // ECONNREFUSED and ETIMEDOUT all resolve to false.
    //
    // SYNCHRONOUS AND MODULE-SCOPE ON PURPOSE. This used to be `async` and was
    // awaited inside `beforeAll`, while `skipNoDocker` was a module-level
    // `const` computed from the initial `false`. Module scope evaluates during
    // COLLECTION and `beforeAll` runs after it, so `skipNoDocker` was
    // unconditionally `true` and every test in this file skipped — including
    // on machines with Docker running. The file reported green for the entire
    // time it was covering nothing. `execSync` is already synchronous, so the
    // `async` bought nothing and cost all of the coverage.
    execSync('docker info > /dev/null 2>&1', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let container: StartedPostgreSqlContainer | null = null;
let storage: Storage | null = null;
/** Resolved at COLLECTION time so `it.skipIf` below sees the real answer. */
const dockerAvailable = isDockerReachable();

const baseTime = '2026-05-18T10:00:00.000Z';

/** ADR 0549 P1 — a lease comfortably longer than any test's critical section. */
const LEASE_MS = 60_000;

/**
 * The claim token, or a loud failure.
 *
 * Deliberately NOT `claim.outcome === 'claimed' ? claim.claimToken : 'some
 * placeholder'`: a placeholder token makes `completeIdempotentResponse`
 * silently no-op (that is what the compare-and-set is FOR), so the test would
 * fail somewhere else, or not at all. Fail at the line that is actually wrong.
 */
function tokenOf(claim: IdempotentClaim): string {
  if (claim.outcome !== 'claimed') throw new Error(`expected a claim, got ${claim.outcome}`);
  return claim.claimToken;
}


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

beforeAll(async () => {
  if (!dockerAvailable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[parity-testcontainers] Docker not reachable — skipping real-Postgres parity tests. '
        + 'Set OPENWOP_SKIP_TESTCONTAINERS=1 to suppress this notice in CI environments that intentionally exclude Docker.',
    );
    return;
  }
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  storage = await openPostgresStorage(container.getConnectionUri());
}, 120_000); // 2-minute timeout for first-run image pull

afterAll(async () => {
  if (storage) {
    try {
      await storage.close();
    } catch {
      // ignore
    }
  }
  if (container) {
    try {
      await container.stop();
    } catch {
      // ignore
    }
  }
}, 60_000);

const skipNoDocker = !dockerAvailable;

// Each test below covers one of the 8 patterns in PG_MEM_INCOMPAT.
// Tagged via the docstring so a future contributor can cross-reference.

describe('Postgres parity (real DB): ADR 0551 P1 dispatch outbox — FOR UPDATE SKIP LOCKED', () => {
  it.skipIf(skipNoDocker)('insertRun commits the run and its dispatch intent together', async () => {
    const s = storage!;
    const run = mkRun('pg-outbox-atomic');
    await s.insertRun(run, { dispatchOutbox: { nextAttemptAt: 1_000 } });
    expect((await s.getRun(run.runId))?.runId).toBe(run.runId);
    expect(await s.getDispatchOutbox(run.runId)).toMatchObject({
      runId: run.runId, tenantId: run.tenantId, workflowId: run.workflowId,
      status: 'pending', attempts: 0, nextAttemptAt: 1_000,
    });
  });

  it.skipIf(skipNoDocker)('a failed intent write rolls the run back (real BEGIN/COMMIT)', async () => {
    const s = storage!;
    const run = mkRun('pg-outbox-rollback');
    await s.insertRun(run, { dispatchOutbox: { nextAttemptAt: 1_000 } });
    expect(await s.deleteRun(run.runId)).toBe(true);
    // The intent row survives `deleteRun`, so re-inserting collides on its PK.
    await expect(s.insertRun(run, { dispatchOutbox: { nextAttemptAt: 1_000 } })).rejects.toThrow();
    expect(await s.getRun(run.runId)).toBeNull();
  });

  it.skipIf(skipNoDocker)('claim leases a due row and hides it from the next claimer', async () => {
    // This is the pattern pg-mem refuses outright (it rejects the SKIP LOCKED
    // AST), so the sibling file skips it and this is its only coverage.
    const s = storage!;
    const run = mkRun('pg-outbox-claim');
    await s.insertRun(run, { dispatchOutbox: { nextAttemptAt: 1_000 } });

    expect((await s.claimDispatchOutbox('w1', 999, LEASE_MS, 10)).map((r) => r.runId)).not.toContain(run.runId);
    const claimed = await s.claimDispatchOutbox('w1', 1_000, LEASE_MS, 10);
    expect(claimed.map((r) => r.runId)).toContain(run.runId);
    expect(claimed.find((r) => r.runId === run.runId)?.claimedBy).toBe('w1');
    expect((await s.claimDispatchOutbox('w2', 1_001, LEASE_MS, 10)).map((r) => r.runId)).not.toContain(run.runId);
    // Re-deliverable once the lease lapses — the duplicate-delivery case.
    expect((await s.claimDispatchOutbox('w2', 1_000 + LEASE_MS + 1, LEASE_MS, 10)).map((r) => r.runId)).toContain(run.runId);
  });

  it.skipIf(skipNoDocker)('reschedule increments attempts; dead is never re-delivered; complete deletes', async () => {
    const s = storage!;
    const run = mkRun('pg-outbox-lifecycle');
    await s.insertRun(run, { dispatchOutbox: { nextAttemptAt: 1_000 } });

    await s.rescheduleDispatchOutbox(run.runId, 5_000, false, 'try again');
    expect(await s.getDispatchOutbox(run.runId)).toMatchObject({
      status: 'pending', attempts: 1, nextAttemptAt: 5_000, claimedBy: null, claimExpiresAt: null, lastError: 'try again',
    });

    await s.rescheduleDispatchOutbox(run.runId, 9_000, true, 'gave up');
    expect((await s.getDispatchOutbox(run.runId))?.status).toBe('dead');
    expect((await s.claimDispatchOutbox('w3', 10_000_000, LEASE_MS, 10)).map((r) => r.runId)).not.toContain(run.runId);

    await s.completeDispatchOutbox(run.runId);
    expect(await s.getDispatchOutbox(run.runId)).toBeNull();
    await s.completeDispatchOutbox(run.runId); // idempotent
  });
});

describe('Postgres parity (real DB): events monotonic sequence — CTE-RETURNING atomicity', () => {
  it.skipIf(skipNoDocker)('appendEvent assigns +1 per call (postgres CTE)', async () => {
    const s = storage!;
    const run = mkRun(`pg-event-seq`);
    await s.insertRun(run);
    const e1 = await s.appendEvent({ runId: run.runId, type: 'run.started', payload: {}, timestamp: baseTime, eventId: 'pg-e1' });
    const e2 = await s.appendEvent({ runId: run.runId, type: 'node.started', payload: {}, timestamp: baseTime, eventId: 'pg-e2' });
    const e3 = await s.appendEvent({ runId: run.runId, type: 'run.completed', payload: {}, timestamp: baseTime, eventId: 'pg-e3' });
    expect(e2.sequence - e1.sequence).toBe(1);
    expect(e3.sequence - e2.sequence).toBe(1);
  });

  it.skipIf(skipNoDocker)('listEvents returns sequence-ordered events', async () => {
    const s = storage!;
    const run = mkRun(`pg-event-list`);
    await s.insertRun(run);
    await s.appendEvent({ runId: run.runId, type: 'run.started', payload: {}, timestamp: baseTime, eventId: 'pg-el1' });
    await s.appendEvent({ runId: run.runId, type: 'run.completed', payload: {}, timestamp: baseTime, eventId: 'pg-el2' });
    const events = await s.listEvents(run.runId);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe('run.started');
    expect(events[1]?.type).toBe('run.completed');
  });

  it.skipIf(skipNoDocker)('findFirstEventByPayload finds the first matching event (ADR 0754)', async () => {
    const s = storage!;
    const run = mkRun(`pg-event-find`);
    await s.insertRun(run);
    await s.appendEvent({ runId: run.runId, type: 'artifact.created', payload: { artifactId: 'a-1' }, timestamp: baseTime, eventId: 'pg-ef1' });
    await s.appendEvent({ runId: run.runId, type: 'node.completed', payload: { artifactId: 'a-2' }, timestamp: baseTime, eventId: 'pg-ef2' });
    await s.appendEvent({ runId: run.runId, type: 'artifact.created', payload: { artifactId: 'a-2', n: 3 }, timestamp: baseTime, eventId: 'pg-ef3' });
    expect((await s.findFirstEventByPayload(run.runId, 'artifact.created', 'artifactId', 'a-2'))?.payload).toEqual({ artifactId: 'a-2', n: 3 });
    expect(await s.findFirstEventByPayload(run.runId, 'artifact.created', 'artifactId', 'nope')).toBeNull();
  });

  it.skipIf(skipNoDocker)('getMaxSequence increases monotonically per append', async () => {
    const s = storage!;
    const run = mkRun(`pg-event-max`);
    await s.insertRun(run);
    const m0 = await s.getMaxSequence(run.runId);
    await s.appendEvent({ runId: run.runId, type: 'run.started', payload: {}, timestamp: baseTime, eventId: 'pg-em1' });
    const m1 = await s.getMaxSequence(run.runId);
    expect(m1).toBeGreaterThan(m0);
    await s.appendEvent({ runId: run.runId, type: 'node.started', payload: {}, timestamp: baseTime, eventId: 'pg-em2' });
    const m2 = await s.getMaxSequence(run.runId);
    expect(m2 - m1).toBe(1);
  });
});

describe('Postgres parity (real DB): idempotency — INSERT-ON-CONFLICT-RETURNING', () => {
  it.skipIf(skipNoDocker)('first call claims; second returns existing', async () => {
    const s = storage!;
    const key = `pg-idem-${Math.random().toString(36).slice(2)}`;
    const first = await s.claimOnce(key, baseTime);
    expect(first.claimed).toBe(true);
    const second = await s.claimOnce(key, baseTime);
    expect(second.claimed).toBe(false);
    expect(second.existing).not.toBeNull();
  });

  it.skipIf(skipNoDocker)('putOnce upgrades the pending placeholder', async () => {
    const s = storage!;
    const key = `pg-idem-upgrade-${Math.random().toString(36).slice(2)}`;
    await s.claimOnce(key, baseTime);
    await s.putOnce({
      key,
      responseBody: '{"runId":"pg-r"}',
      responseStatus: 201,
      createdAt: baseTime,
    });
    const second = await s.claimOnce(key, baseTime);
    expect(second.existing?.responseStatus).toBe(201);
  });
});

/**
 * ADR 0549 P0 — the HTTP ledger against a REAL Postgres.
 *
 * This is the only place the Postgres claim path is honestly exercised.
 * `test/storage-postgres.test.ts` runs on pg-mem, which does not faithfully
 * implement `ON CONFLICT DO NOTHING ... RETURNING` (it returns the proposed
 * row whether or not the conflict fired), and the production adapter decides
 * claimed-vs-existing precisely on that rowCount. A green pg-mem run therefore
 * proves the DDL applies, not that the claim is atomic.
 */
describe('Postgres parity (real DB): ADR 0549 idempotency ledger — tenant isolation', () => {
  const ENDPOINT = 'POST:/v1/runs';
  const digest = 'd'.repeat(64);

  it.skipIf(skipNoDocker)('the same key in two tenants yields two independent claims', async () => {
    const s = storage!;
    const key = `pg-ledger-${Math.random().toString(36).slice(2)}`;
    const a = await s.claimIdempotentResponse({
      tenantId: 'tenant-a', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    const b = await s.claimIdempotentResponse({
      tenantId: 'tenant-b', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    expect(a.outcome).toBe('claimed');
    expect(b.outcome).toBe('claimed');
  });

  it.skipIf(skipNoDocker)("tenant B never receives tenant A's completed response", async () => {
    const s = storage!;
    const key = `pg-victim-${Math.random().toString(36).slice(2)}`;
    const __claim0 = await s.claimIdempotentResponse({
      tenantId: 'victim', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    await s.completeIdempotentResponse({
      claimToken: tokenOf(__claim0),
      tenantId: 'victim', endpoint: ENDPOINT, key, responseStatus: 201,
      responseBody: '{"runId":"pg-VICTIM-SECRET"}', runId: 'pg-VICTIM-SECRET', updatedAt: baseTime,
    });
    const attacker = await s.claimIdempotentResponse({
      tenantId: 'attacker', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    expect(attacker.outcome).toBe('claimed');
    expect(JSON.stringify(attacker)).not.toContain('pg-VICTIM-SECRET');
  });

  it.skipIf(skipNoDocker)('replay, mismatch and in-flight are distinguished', async () => {
    const s = storage!;
    const key = `pg-states-${Math.random().toString(36).slice(2)}`;
    const other = 'e'.repeat(64);

    const first = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    expect(first.outcome).toBe('claimed');

    // Still pending ⇒ in-flight, not replay.
    const concurrent = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    expect(concurrent.outcome).toBe('in-flight');

    // Divergent digest beats state ⇒ mismatch even while pending.
    const divergent = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: other, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    expect(divergent.outcome).toBe('mismatch');

    // The commit must use FIRST's token — it is the caller that actually holds
    // the claim. (`divergent` was a mismatch and holds nothing; committing with
    // its token silently no-ops, which is precisely what the CAS is for.)
    if (first.outcome !== 'claimed') throw new Error('expected claimed');
    const committed = await s.completeIdempotentResponse({
      claimToken: first.claimToken,
      tenantId: 't', endpoint: ENDPOINT, key, responseStatus: 201,
      responseBody: '{"runId":"pg-r2"}', updatedAt: baseTime,
    });
    expect(committed).toBe(true);
    const replay = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    expect(replay).toEqual({ outcome: 'replay', responseStatus: 201, responseBody: '{"runId":"pg-r2"}' });
  });

  it.skipIf(skipNoDocker)('exactly one of N concurrent claims wins', async () => {
    // The property pg-mem cannot demonstrate. Real Postgres resolves the
    // composite-key conflict; only the winning INSERT returns a row.
    const s = storage!;
    const key = `pg-race-${Math.random().toString(36).slice(2)}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        s.claimIdempotentResponse({
          tenantId: 'race', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
          leaseMs: LEASE_MS,
        }),
      ),
    );
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'in-flight')).toHaveLength(7);
  });

  it.skipIf(skipNoDocker)('complete never overwrites an already-completed winner', async () => {
    const s = storage!;
    const key = `pg-nooverwrite-${Math.random().toString(36).slice(2)}`;
    const __claim2 = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    await s.completeIdempotentResponse({
      claimToken: tokenOf(__claim2),
      tenantId: 't', endpoint: ENDPOINT, key, responseStatus: 201,
      responseBody: '{"runId":"winner"}', updatedAt: baseTime,
    });
    await s.completeIdempotentResponse({
      claimToken: tokenOf(__claim2),
      tenantId: 't', endpoint: ENDPOINT, key, responseStatus: 500,
      responseBody: '{"runId":"loser"}', updatedAt: baseTime,
    });
    const replay = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime,
      leaseMs: LEASE_MS,
    });
    expect(replay).toMatchObject({ outcome: 'replay', responseBody: '{"runId":"winner"}' });
  });
});

/**
 * The array-into-JSONB class, probed beyond the one confirmed site.
 *
 * node-postgres marshals a JS ARRAY parameter as a Postgres array literal
 * (`{a,b}`), which a JSONB column rejects — while a JS OBJECT is JSON-stringified
 * and works. So every JSONB column that can receive an array is a candidate,
 * and `webhooks.events` was merely the one with a (never-executed) test.
 *
 * These probe the remaining `unknown`-typed JSONB columns with ARRAY values
 * instead of the object values the existing fixtures use. Written to FAIL if
 * the defect is present, rather than asserting a fix that may not be needed.
 */
describe('Postgres parity (real DB): array-into-JSONB, the wider class', () => {
  it.skipIf(skipNoDocker)('interrupts.data accepts an ARRAY payload', async () => {
    const s = storage!;
    const run = mkRun('pg-int-array');
    await s.insertRun(run);
    const rec = mkInterrupt(run.runId, 'n1');
    await s.insertInterrupt({ ...rec, data: ['choice-a', 'choice-b'] });
    const back = await s.getInterrupt(rec.interruptId);
    expect(back?.data).toEqual(['choice-a', 'choice-b']);
  });

  it.skipIf(skipNoDocker)('runs.inputs accepts an ARRAY — it is caller-supplied', async () => {
    // `RunRecord.inputs` is typed `unknown` and arrives verbatim from the
    // `POST /v1/runs` request body, so an array is an ordinary client input on
    // the product's primary endpoint.
    const s = storage!;
    const run = mkRun('pg-run-array-inputs', { inputs: ['a', 'b', 'c'] });
    await s.insertRun(run);
    const back = await s.getRun(run.runId);
    expect(back?.inputs).toEqual(['a', 'b', 'c']);
  });

  it.skipIf(skipNoDocker)('events.payload accepts an ARRAY', async () => {
    const s = storage!;
    const run = mkRun('pg-event-array');
    await s.insertRun(run);
    await s.appendEvent({
      runId: run.runId, type: 'node.completed', payload: [1, 2, 3],
      timestamp: baseTime, eventId: 'pg-arr-1',
    });
    const events = await s.listEvents(run.runId);
    expect(events[0]?.payload).toEqual([1, 2, 3]);
  });

  it.skipIf(skipNoDocker)('interrupts.resolvedValue accepts an ARRAY — also caller-supplied', async () => {
    // Arrives from the resume request body.
    const s = storage!;
    const run = mkRun('pg-resolve-array');
    await s.insertRun(run);
    const rec = mkInterrupt(run.runId, 'n-resolve');
    await s.insertInterrupt(rec);
    await s.resolveInterrupt(rec.interruptId, ['picked-a', 'picked-b'], baseTime);
    const back = await s.getInterrupt(rec.interruptId);
    expect(back?.resolvedValue).toEqual(['picked-a', 'picked-b']);
  });

  it.skipIf(skipNoDocker)('invocation_log.result accepts an ARRAY', async () => {
    const s = storage!;
    const key = { runId: 'pg-inv-array', nodeId: 'n1', attempt: 1, invocationId: 'p1' };
    await s.putInvocation(key, ['tool-a', 'tool-b']);
    const back = await s.getInvocation(key);
    expect(back).toEqual(['tool-a', 'tool-b']);
  });
});

describe('Postgres parity (real DB): webhooks — JSONB array marshalling', () => {
  it.skipIf(skipNoDocker)('insertWebhook → getWebhook round-trips with JSONB events array', async () => {
    const s = storage!;
    const wh = mkWebhook(`pg-1`);
    await s.insertWebhook(wh);
    const got = await s.getWebhook(wh.subscriptionId);
    expect(got?.url).toBe(wh.url);
    expect(got?.events).toEqual(wh.events);
  });

  it.skipIf(skipNoDocker)('deleteWebhook removes the row', async () => {
    const s = storage!;
    const wh = mkWebhook(`pg-delete`);
    await s.insertWebhook(wh);
    await s.deleteWebhook(wh.subscriptionId);
    expect(await s.getWebhook(wh.subscriptionId)).toBeNull();
  });

  // RFC 0201 / ADR 0747 — JSONB `signature_algorithms` + the one-statement rotation.
  it.skipIf(skipNoDocker)('rotateWebhookSecret shifts current → previous and signatureAlgorithms round-trips', async () => {
    const s = storage!;
    const wh = { ...mkWebhook('pg-rot'), secret: 's1', signatureAlgorithms: ['v1', 'standard-webhooks-1'] };
    await s.insertWebhook(wh);
    await s.rotateWebhookSecret(wh.subscriptionId, { secret: 's2', rotatedAt: 10, previousSecretExpiresAt: 70 });
    await s.rotateWebhookSecret(wh.subscriptionId, { secret: 's3', rotatedAt: 20, previousSecretExpiresAt: 80 });
    const got = await s.getWebhook(wh.subscriptionId);
    expect(got?.signatureAlgorithms).toEqual(['v1', 'standard-webhooks-1']);
    expect([got?.secret, got?.previousSecret, got?.rotatedAt, got?.previousSecretExpiresAt]).toEqual(['s3', 's2', 20, 80]);
  });
});

describe('Postgres parity (real DB): tenant cascade DELETE', () => {
  it.skipIf(skipNoDocker)('deleteAllTenantData cascades runs + events + interrupts + secrets', async () => {
    const s = storage!;
    const T = `pg-del-tenant-${Math.random().toString(36).slice(2)}`;
    const r1 = mkRun(`pg-del-1`, { tenantId: T });
    const r2 = mkRun(`pg-del-2`, { tenantId: T });
    await s.insertRun(r1);
    await s.insertRun(r2);
    await s.appendEvent({ runId: r1.runId, type: 'run.started', payload: {}, timestamp: baseTime, eventId: `pg-del-ev-1` });
    await s.insertInterrupt(mkInterrupt(r1.runId, `pg-del-n1`));
    await s.upsertTenantSecret(T, 'pg-del-ref', '{"v":"x"}', baseTime);

    const counts = await s.deleteAllTenantData(T);
    expect(counts.runs).toBeGreaterThanOrEqual(2);
    expect(counts.events).toBeGreaterThanOrEqual(1);
    expect(counts.interrupts).toBeGreaterThanOrEqual(1);
    expect(counts.secrets).toBeGreaterThanOrEqual(1);

    expect(await s.getRun(r1.runId)).toBeNull();
    expect(await s.getRun(r2.runId)).toBeNull();
    expect(await s.getTenantSecret(T, 'pg-del-ref')).toBeNull();
  });
});

/**
 * ADR 0549 P1 — lease/reclaim/CAS against a REAL Postgres.
 *
 * The reclaim is a conditional UPDATE with a compare-and-set predicate, and
 * pg-mem cannot be trusted for conditional-write races (same reason as the
 * claim itself), so this is the only honest coverage of it.
 */
describe('Postgres parity (real DB): ADR 0549 P1 lease, reclaim and CAS', () => {
  const ENDPOINT = 'POST:/v1/runs';
  const digest = 'f'.repeat(64);
  const t0 = '2026-05-18T10:00:00.000Z';
  const afterLease = '2026-05-18T10:05:00.000Z';

  it.skipIf(skipNoDocker)('an expired claim is reclaimed with a new token; a live one is not', async () => {
    const s = storage!;
    const key = `pg-lease-${Math.random().toString(36).slice(2)}`;
    const first = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    if (first.outcome !== 'claimed') throw new Error('expected claimed');

    // Still inside the lease ⇒ in-flight.
    const live = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    expect(live.outcome).toBe('in-flight');

    const reclaim = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: afterLease, leaseMs: 60_000,
    });
    expect(reclaim.outcome).toBe('claimed');
    if (reclaim.outcome !== 'claimed') throw new Error('unreachable');
    expect(reclaim.claimToken).not.toBe(first.claimToken);
  });

  it.skipIf(skipNoDocker)('exactly one of N concurrent RECLAIMERS wins', async () => {
    // The CAS predicate under real concurrency — the property pg-mem cannot show.
    const s = storage!;
    const key = `pg-reclaim-race-${Math.random().toString(36).slice(2)}`;
    await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        s.claimIdempotentResponse({
          tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: afterLease, leaseMs: 60_000,
        }),
      ),
    );
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'in-flight')).toHaveLength(7);
  });

  it.skipIf(skipNoDocker)('a reclaimed holder cannot overwrite the winner', async () => {
    const s = storage!;
    const key = `pg-cas-${Math.random().toString(36).slice(2)}`;
    const first = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    if (first.outcome !== 'claimed') throw new Error('expected claimed');
    const second = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: afterLease, leaseMs: 60_000,
    });
    if (second.outcome !== 'claimed') throw new Error('expected reclaim');

    expect(await s.completeIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, responseStatus: 201,
      responseBody: '{"runId":"pg-winner"}', updatedAt: afterLease, claimToken: second.claimToken,
    })).toBe(true);
    expect(await s.completeIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, responseStatus: 201,
      responseBody: '{"runId":"pg-STALE"}', updatedAt: afterLease, claimToken: first.claimToken,
    })).toBe(false);

    const replay = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: afterLease, leaseMs: 60_000,
    });
    expect(replay).toMatchObject({ outcome: 'replay', responseBody: '{"runId":"pg-winner"}' });
  });

  it.skipIf(skipNoDocker)('release frees the key; release after complete is a no-op', async () => {
    const s = storage!;
    const key = `pg-release-${Math.random().toString(36).slice(2)}`;
    const c = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    if (c.outcome !== 'claimed') throw new Error('expected claimed');
    await s.releaseIdempotentResponse({ tenantId: 't', endpoint: ENDPOINT, key, claimToken: c.claimToken });
    const retry = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    expect(retry.outcome).toBe('claimed');
    if (retry.outcome !== 'claimed') throw new Error('unreachable');

    await s.completeIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, responseStatus: 201,
      responseBody: '{"runId":"pg-kept"}', updatedAt: t0, claimToken: retry.claimToken,
    });
    await s.releaseIdempotentResponse({ tenantId: 't', endpoint: ENDPOINT, key, claimToken: retry.claimToken });
    const after = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    expect(after).toMatchObject({ outcome: 'replay', responseBody: '{"runId":"pg-kept"}' });
  });
});

/**
 * ADR 0549 H56 — the atomic admission seam, against a REAL Postgres.
 *
 * The seam was verified on SQLite (`idempotent-run-admission.test.ts`), and PG
 * is the PRODUCTION adapter — an atomicity guarantee verified on one adapter
 * and assumed on the other is exactly the shape where "verified by inspection"
 * bites. PG's implementation is a different mechanism (`BEGIN`/`COMMIT` over a
 * dedicated connection, versus SQLite's `db.transaction`), so nothing about the
 * SQLite result transfers.
 *
 * These run in `ci:full`'s live lane under `OPENWOP_STORAGE_PARITY_LIVE=1`,
 * which is what H59 (#3335) added — before it, this file ran in NO lane at all.
 */
describe('Postgres parity (real DB): ADR 0549 H56 atomic admission', () => {
  const ENDPOINT = 'POST /v1/runs';

  it.skipIf(skipNoDocker)('the run row and the completed ledger row commit together', async () => {
    const s = storage!;
    const key = `pg-admit-${Date.now()}`;
    const digest = 'digest-admit';
    const claim = await s.claimIdempotentResponse({
      tenantId: 'default', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime, leaseMs: 60_000,
    });
    expect(claim.outcome).toBe('claimed');
    if (claim.outcome !== 'claimed') throw new Error('unreachable');

    const run = mkRun('pg-admit-run');
    await s.insertRun(run, {
      idempotencyCommit: {
        tenantId: 'default', endpoint: ENDPOINT, key,
        responseStatus: 201, responseBody: JSON.stringify({ runId: run.runId }),
        updatedAt: baseTime, claimToken: claim.claimToken,
      },
    });

    // Both, from the DB rather than from the return value.
    expect(await s.getRun(run.runId)).not.toBeNull();
    const replay = await s.claimIdempotentResponse({
      tenantId: 'default', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: baseTime, leaseMs: 60_000,
    });
    expect(replay.outcome, 'the ledger must already be completed, so a retry replays').toBe('replay');
  });

  it.skipIf(skipNoDocker)('a ledger commit the CAS rejects ROLLS BACK the run row — both or neither', async () => {
    const s = storage!;
    const key = `pg-admit-cas-${Date.now()}`;
    const claim = await s.claimIdempotentResponse({
      tenantId: 'default', endpoint: ENDPOINT, key, requestDigest: 'd', createdAt: baseTime, leaseMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error('unreachable');

    // A STALE token: the CAS must not match, so the whole insert must unwind.
    // This is the property that makes the window closed rather than narrowed —
    // without the rollback a rejected ledger commit would still leave a run row.
    const run = mkRun('pg-admit-rollback');
    await expect(s.insertRun(run, {
      idempotencyCommit: {
        tenantId: 'default', endpoint: ENDPOINT, key,
        responseStatus: 201, responseBody: '{}', updatedAt: baseTime,
        claimToken: 'not-the-token-that-was-issued',
      },
    })).rejects.toThrow();

    expect(await s.getRun(run.runId), 'the run row must NOT survive a rejected ledger commit').toBeNull();
  });
});

/**
 * ADR 0551 P0 — the durable workspace, against a REAL Postgres.
 *
 * Added H59 (2026-08-18). The P0 gate row promised "two-instance CAS ... in
 * SQLite/Postgres"; what existed was a sequential If-Match test on SQLite and
 * NOTHING on Postgres. `storage-postgres.test.ts` stubs `putWorkspaceFile` with
 * a `throw new Error('not exercised')` under pg-mem, and its comment claimed
 * this file covered the race — it did not: `grep -c workspace` here was 0.
 *
 * These legs use the PRODUCTION `workspaceEtag`, so a version/content mismatch
 * in the stored etag is detectable rather than a matter of opinion.
 */
describe('Postgres parity (real DB): ADR 0551 P0 workspace CAS', () => {
  const WS = 'ws-parity';

  it.skipIf(skipNoDocker)('If-Match CAS: exactly one of two concurrent writers wins', async () => {
    const s = storage!;
    const path = 'cas/concurrent.txt';
    const seed = await s.putWorkspaceFile({
      tenantId: 'default', workspaceId: WS, path, content: 'seed',
      contentType: 'text/plain', etagFor: workspaceEtag, updatedAt: baseTime,
    });
    expect(seed.ok).toBe(true);
    if (!seed.ok) throw new Error('unreachable');

    // Both writers present the SAME etag — the losing one must be refused, not
    // merged. This is the property the module-Map version could not provide
    // across instances, and it is why the CAS moved into the adapter.
    const [a, b] = await Promise.all([
      s.putWorkspaceFile({
        tenantId: 'default', workspaceId: WS, path, content: 'writer-A',
        contentType: 'text/plain', etagFor: workspaceEtag, ifMatch: seed.row.etag, updatedAt: baseTime,
      }),
      s.putWorkspaceFile({
        tenantId: 'default', workspaceId: WS, path, content: 'writer-B',
        contentType: 'text/plain', etagFor: workspaceEtag, ifMatch: seed.row.etag, updatedAt: baseTime,
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    // And the survivor is internally consistent: the stored etag is derived
    // from the stored version AND the stored content.
    const stored = await s.getWorkspaceFile('default', WS, path);
    expect(stored).not.toBeNull();
    expect(stored!.version).toBe(2);
    expect(stored!.etag).toBe(workspaceEtag(stored!.version, stored!.content));
  });

  it.skipIf(skipNoDocker)('no-If-Match: racing create-or-replace cannot mis-stamp the etag', async () => {
    const s = storage!;
    const path = 'cas/no-if-match.txt';

    // The defect this pins (fixed in the same change): the no-If-Match path was
    // an upsert RETURNING version followed by a SEPARATE `UPDATE ... SET etag`.
    // Interleaved, the slower writer stamped an etag for ITS version over a row
    // that had already moved on — leaving (version N, content X) carrying
    // etag(N-1, content Y). Both writers legitimately win here; what must hold
    // is that the row's etag matches the row's own version and content.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        s.putWorkspaceFile({
          tenantId: 'default', workspaceId: WS, path, content: `content-${i}`,
          contentType: 'text/plain', etagFor: workspaceEtag, updatedAt: baseTime,
        }),
      ),
    );

    const stored = await s.getWorkspaceFile('default', WS, path);
    expect(stored).not.toBeNull();
    expect(stored!.version).toBe(6);
    expect(stored!.etag).toBe(workspaceEtag(stored!.version, stored!.content));
  });

  it.skipIf(skipNoDocker)('a stale If-Match is refused with the CURRENT version', async () => {
    const s = storage!;
    const path = 'cas/stale.txt';
    const first = await s.putWorkspaceFile({
      tenantId: 'default', workspaceId: WS, path, content: 'v1',
      contentType: 'text/plain', etagFor: workspaceEtag, updatedAt: baseTime,
    });
    if (!first.ok) throw new Error('unreachable');
    await s.putWorkspaceFile({
      tenantId: 'default', workspaceId: WS, path, content: 'v2',
      contentType: 'text/plain', etagFor: workspaceEtag, ifMatch: first.row.etag, updatedAt: baseTime,
    });

    const stale = await s.putWorkspaceFile({
      tenantId: 'default', workspaceId: WS, path, content: 'v3-from-stale',
      contentType: 'text/plain', etagFor: workspaceEtag, ifMatch: first.row.etag, updatedAt: baseTime,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.currentVersion).toBe(2);
  });

  it.skipIf(skipNoDocker)('WCT-1: the tenant is part of the key, not a filter applied later', async () => {
    const s = storage!;
    const path = 'cas/tenant.txt';
    await s.putWorkspaceFile({
      tenantId: 'default', workspaceId: WS, path, content: 'tenant-default',
      contentType: 'text/plain', etagFor: workspaceEtag, updatedAt: baseTime,
    });
    await s.putWorkspaceFile({
      tenantId: 'other', workspaceId: WS, path, content: 'tenant-other',
      contentType: 'text/plain', etagFor: workspaceEtag, updatedAt: baseTime,
    });
    const mine = await s.getWorkspaceFile('default', WS, path);
    const theirs = await s.getWorkspaceFile('other', WS, path);
    expect(mine!.content).toBe('tenant-default');
    expect(theirs!.content).toBe('tenant-other');
    // Same path, same workspace id, different tenants — two rows, each at v1.
    expect(mine!.version).toBe(1);
    expect(theirs!.version).toBe(1);
  });
});

describe('Postgres parity (real DB): ADR 0740 run execution claim — the conditional UPDATE', () => {
  // The claim's predicate is written TWICE — once per adapter — and the gate runs
  // only the sqlite one (`OPENWOP_SKIP_TESTCONTAINERS=1`). Production is Postgres.
  // So this is the same row-by-row table as `test/adr0740-run-execution-claim.test.ts`,
  // against a real server, including the one property sqlite cannot show: two
  // CONCURRENT contenders on separate pool connections, exactly one winner.
  const FAR = (): number => Date.now() + 600_000;

  it.skipIf(skipNoDocker)('first claim wins; a second is HELD — even with the SAME owner string — and does not move the owner', async () => {
    const s = storage!;
    const run = mkRun('pg-claim-first');
    await s.insertRun(run);
    expect(await s.claimRunExecution(run.runId, 'exec-a', Date.now(), FAR())).toBe('claimed');
    expect(await s.claimRunExecution(run.runId, 'exec-b', Date.now(), FAR())).toBe('held');
    expect(await s.claimRunExecution(run.runId, 'exec-a', Date.now(), FAR())).toBe('held');
    expect((await s.getRun(run.runId))?.dispatchOwner).toBe('exec-a');
  });

  it.skipIf(skipNoDocker)('an EXPIRED lease is claimable (crash recovery)', async () => {
    const s = storage!;
    const run = mkRun('pg-claim-expired');
    await s.insertRun(run);
    await s.updateRun(run.runId, { status: 'running' });
    await s.setRunDispatchLease(run.runId, 'dead-instance', Date.now() - 1);
    expect(await s.claimRunExecution(run.runId, 'exec-new', Date.now(), FAR())).toBe('claimed');
    expect((await s.getRun(run.runId))?.dispatchOwner).toBe('exec-new');
  });

  it.skipIf(skipNoDocker)('a SUSPENDED run is claimable under another owner\'s LIVE lease; a FINAL run is not-runnable; an absent run is missing', async () => {
    const s = storage!;
    for (const status of ['paused', 'waiting-approval', 'waiting-input', 'waiting-external'] as const) {
      const run = mkRun(`pg-claim-susp-${status}`);
      await s.insertRun(run);
      await s.updateRun(run.runId, { status });
      await s.setRunDispatchLease(run.runId, 'instance-that-suspended-it', FAR());
      expect(await s.claimRunExecution(run.runId, 'resumer', Date.now(), FAR()), status).toBe('claimed');
    }
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const run = mkRun(`pg-claim-final-${status}`);
      await s.insertRun(run);
      await s.updateRun(run.runId, { status });
      expect(await s.claimRunExecution(run.runId, 'exec', Date.now(), FAR()), status).toBe('not-runnable');
    }
    expect(await s.claimRunExecution('pg-claim-never-inserted', 'exec', Date.now(), FAR())).toBe('missing');
  });

  it.skipIf(skipNoDocker)('TWENTY concurrent contenders on real pool connections: exactly ONE is claimed', async () => {
    const s = storage!;
    const run = mkRun('pg-claim-race');
    await s.insertRun(run);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => s.claimRunExecution(run.runId, `contender-${i}`, Date.now(), FAR())),
    );
    expect(results.filter((r) => r === 'claimed'), JSON.stringify(results)).toHaveLength(1);
    expect(results.filter((r) => r === 'held')).toHaveLength(19);
    const winner = results.findIndex((r) => r === 'claimed');
    expect((await s.getRun(run.runId))?.dispatchOwner, 'the recorded owner is not the contender that was told it won').toBe(`contender-${winner}`);
  });
});
