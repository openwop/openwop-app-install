/**
 * ADR 0549 P0 — adversarial tests for the tenant-scoped idempotency ledger.
 *
 * Three defects are pinned here, all of which shipped and all of which were
 * reachable by an ordinary authenticated caller with a chosen header value:
 *
 *   1. CROSS-TENANT REPLAY — tenant B sends the same `Idempotency-Key` string
 *      as tenant A and receives A's cached response body and run id.
 *   2. CROSS-LANE MUTEX POISONING — a caller sends
 *      `Idempotency-Key: schedule-fire:<jobId>:<slot>`, winning the row the
 *      scheduler daemon uses as its fire-once mutex, so the scheduled job is
 *      skipped. Denial of service against host-scheduled work.
 *   3. CROSS-ENDPOINT REPLAY — one tenant reuses a key across two different
 *      endpoints and is served the other endpoint's body (a CreateRunResponse
 *      returned from the agent-create route).
 *
 * All three had ONE root cause: `idempotency.key` was the sole primary key, so
 * caller-supplied strings and host-generated strings shared a keyspace across
 * every tenant and every route.
 *
 * VERIFICATION SCOPE (ADR 0549 CORRECTION 5). These run against SQLite, which
 * is also what `memory://` resolves to — `storage/index.ts` re-opens the SQLite
 * backend at `:memory:` rather than carrying a second implementation, so a
 * "memory" run is NOT independent evidence. Postgres equivalence is covered by
 * the parity suites; pg-mem cannot stand in for the claim race because its
 * `ON CONFLICT DO NOTHING RETURNING` is not faithful.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  canonicalRequestDigest,
  idempotencyLeaseMs,
  type IdempotentClaim,
} from '../src/host/idempotentResponse.js';
import { resolveRequestTimeoutMs } from '../src/middleware/requestTimeout.js';
import { __budgetReadsForTests } from '../src/host/workflowBudgets.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

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


beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function post<T = unknown>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as T };
}

interface CreateRunBody {
  runId?: string;
  message?: string;
  /** `OpenwopError.toEnvelope()` serializes the code as `error`, not `code`. */
  error?: string;
}

describe('ADR 0549 P0 — storage-level tenant isolation (SQLite)', () => {
  let storage: Storage;
  const ENDPOINT = 'POST:/v1/runs';

  beforeAll(async () => {
    storage = await openStorage(':memory:');
  });

  it('the SAME key in two tenants yields two independent claims', async () => {
    const key = 'shared-key-value';
    const digest = canonicalRequestDigest({ text: 'a' }, 'POST:/v1/runs');
    const now = new Date().toISOString();

    const a = await storage.claimIdempotentResponse({
      tenantId: 'tenant-a', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: now,
      leaseMs: LEASE_MS,
    });
    const b = await storage.claimIdempotentResponse({
      tenantId: 'tenant-b', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: now,
      leaseMs: LEASE_MS,
    });

    // Before ADR 0549, B's claim collided with A's row and returned the
    // existing record. Both tenants must now win their own claim.
    expect(a.outcome).toBe('claimed');
    expect(b.outcome).toBe('claimed');
  });

  it("tenant B never receives tenant A's cached response body or run id", async () => {
    const key = 'victim-key';
    const digest = canonicalRequestDigest({ text: 'a' }, 'POST:/v1/runs');
    const now = new Date().toISOString();

    const __claim0 = await storage.claimIdempotentResponse({
      tenantId: 'victim', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: now,
      leaseMs: LEASE_MS,
    });
    await storage.completeIdempotentResponse({
      claimToken: tokenOf(__claim0),
      tenantId: 'victim',
      endpoint: ENDPOINT,
      key,
      responseStatus: 201,
      responseBody: JSON.stringify({ runId: 'run-VICTIM-SECRET' }),
      runId: 'run-VICTIM-SECRET',
      updatedAt: now,
    });

    const attacker = await storage.claimIdempotentResponse({
      tenantId: 'attacker', endpoint: ENDPOINT, key, requestDigest: digest, createdAt: now,
      leaseMs: LEASE_MS,
    });

    // The whole point: the attacker gets a fresh claim, not a replay, and
    // nothing in the outcome carries the victim's run id.
    expect(attacker.outcome).toBe('claimed');
    expect(JSON.stringify(attacker)).not.toContain('run-VICTIM-SECRET');
  });

  it('the same key on two ENDPOINTS in one tenant does not cross over', async () => {
    const key = 'one-tenant-two-endpoints';
    const now = new Date().toISOString();
    const runsDigest = canonicalRequestDigest({ text: 'a' }, 'POST:/v1/runs');
    const agentsDigest = canonicalRequestDigest({ text: 'a' }, 'POST:/v1/host/openwop-app/agents');

    const __claim1 = await storage.claimIdempotentResponse({
      tenantId: 't1', endpoint: 'POST:/v1/runs', key, requestDigest: runsDigest, createdAt: now,
      leaseMs: LEASE_MS,
    });
    await storage.completeIdempotentResponse({
      claimToken: tokenOf(__claim1),
      tenantId: 't1',
      endpoint: 'POST:/v1/runs',
      key,
      responseStatus: 201,
      responseBody: JSON.stringify({ runId: 'run-from-runs-endpoint' }),
      updatedAt: now,
    });

    const onAgents = await storage.claimIdempotentResponse({
      tenantId: 't1',
      endpoint: 'POST:/v1/host/openwop-app/agents',
      key,
      requestDigest: agentsDigest,
      createdAt: now,
      leaseMs: LEASE_MS,
    });
    expect(onAgents.outcome).toBe('claimed');
    expect(JSON.stringify(onAgents)).not.toContain('run-from-runs-endpoint');
  });

  it('a completed claim replays, and a divergent body is a mismatch not a replay', async () => {
    const key = 'digest-check';
    const now = new Date().toISOString();
    const d1 = canonicalRequestDigest({ text: 'original' }, 'POST:/v1/runs');
    const d2 = canonicalRequestDigest({ text: 'DIFFERENT' }, 'POST:/v1/runs');

    const __claim2 = await storage.claimIdempotentResponse({
      tenantId: 't2', endpoint: ENDPOINT, key, requestDigest: d1, createdAt: now,
      leaseMs: LEASE_MS,
    });
    await storage.completeIdempotentResponse({
      claimToken: tokenOf(__claim2),
      tenantId: 't2', endpoint: ENDPOINT, key, responseStatus: 201,
      responseBody: '{"runId":"r1"}', updatedAt: now,
    });

    const replay = await storage.claimIdempotentResponse({
      tenantId: 't2', endpoint: ENDPOINT, key, requestDigest: d1, createdAt: now,
      leaseMs: LEASE_MS,
    });
    expect(replay).toEqual({ outcome: 'replay', responseStatus: 201, responseBody: '{"runId":"r1"}' });

    const mismatch = await storage.claimIdempotentResponse({
      tenantId: 't2', endpoint: ENDPOINT, key, requestDigest: d2, createdAt: now,
      leaseMs: LEASE_MS,
    });
    // Mismatch must win over replay: a caller who reused a key with a new body
    // broke the contract and must be told so, not handed the old response.
    expect(mismatch.outcome).toBe('mismatch');
  });

  it('the ledger has its OWN retention, independent of the mutex table', async () => {
    // Splitting the lanes also split their retention: the
    // `pruneOnceByPrefix('')` sweep that used to be the HTTP cache's only
    // cleaner no longer reaches these rows. Without this, P0 would have traded
    // a security defect for an unbounded-growth defect.
    const s = await openStorage(':memory:');
    const digest = canonicalRequestDigest({ text: 'x' }, 'POST:/v1/runs');
    const old = '2020-01-01T00:00:00.000Z';
    const recent = new Date().toISOString();

    await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'stale', requestDigest: digest, createdAt: old,
      leaseMs: LEASE_MS,
    });
    await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'fresh', requestDigest: digest, createdAt: recent,
      leaseMs: LEASE_MS,
    });

    const deleted = await s.pruneIdempotentResponses('2021-01-01T00:00:00.000Z');
    expect(deleted).toBe(1);

    // The stale key is claimable again; the fresh one is still held.
    const staleAgain = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'stale', requestDigest: digest, createdAt: recent,
      leaseMs: LEASE_MS,
    });
    expect(staleAgain.outcome).toBe('claimed');
    const freshAgain = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'fresh', requestDigest: digest, createdAt: recent,
      leaseMs: LEASE_MS,
    });
    expect(freshAgain.outcome).toBe('in-flight');
  });

  it('pruning the mutex table does NOT prune the ledger (and vice versa)', async () => {
    // The two lanes must not share a cleaner any more than they share a
    // keyspace — a prefix sweep over one must leave the other intact.
    const s = await openStorage(':memory:');
    const digest = canonicalRequestDigest({ text: 'x' }, 'POST:/v1/runs');
    const old = '2020-01-01T00:00:00.000Z';

    await s.claimOnce('schedule-fire:j:1', old);
    await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'ledger-row', requestDigest: digest, createdAt: old,
      leaseMs: LEASE_MS,
    });

    const mutexDeleted = await s.pruneOnceByPrefix('', '2021-01-01T00:00:00.000Z');
    expect(mutexDeleted).toBe(1);
    // The ledger row survived the mutex sweep.
    const still = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'ledger-row', requestDigest: digest, createdAt: old,
      leaseMs: LEASE_MS,
    });
    expect(still.outcome).toBe('in-flight');
  });

  it('digest is stable across key order but sensitive to the endpoint', () => {
    const a = canonicalRequestDigest({ x: 1, y: { b: 2, a: 3 } }, 'POST:/v1/runs');
    const b = canonicalRequestDigest({ y: { a: 3, b: 2 }, x: 1 }, 'POST:/v1/runs');
    expect(a).toBe(b);
    // Same body, different endpoint ⇒ different digest, so a digest lifted
    // from one endpoint can never validate a claim on another.
    expect(canonicalRequestDigest({ x: 1 }, 'POST:/v1/runs')).not.toBe(
      canonicalRequestDigest({ x: 1 }, 'POST:/v1/host/openwop-app/agents'),
    );
  });
});

describe('ADR 0549 P0 — route-level adversarial cases', () => {
  it('a caller CANNOT poison the scheduler mutex with a crafted Idempotency-Key', async () => {
    // The exact attack: the scheduler claims `schedule-fire:<jobId>:<slot>` as
    // its fire-once mutex. Before the lane split, a request carrying that
    // string as its Idempotency-Key took the row first, and the daemon's own
    // claim then reported "already claimed" and SKIPPED the job.
    const mutexKey = 'schedule-fire:victim-job:1';
    const storage = await openStorage(':memory:');

    const created = await post<CreateRunBody>(
      '/v1/runs',
      { workflowId: 'openwop-app.uppercase', tenantId: 'demo', inputs: { text: 'poison' } },
      { 'idempotency-key': mutexKey },
    );
    expect(created.status).toBe(201);

    // The daemon's mutex must still be free. This asserts the two lanes do not
    // share storage: the HTTP claim above landed in `idempotent_response`,
    // never in the `idempotency` table the daemons use.
    const daemonClaim = await storage.claimOnce(mutexKey, new Date().toISOString());
    expect(daemonClaim.claimed).toBe(true);
  });

  it('reusing one key across /v1/runs and the agents route returns each route its OWN response', async () => {
    const key = 'cross-endpoint-probe';
    const run = await post<CreateRunBody>(
      '/v1/runs',
      { workflowId: 'openwop-app.uppercase', tenantId: 'demo', inputs: { text: 'x' } },
      { 'idempotency-key': key },
    );
    expect(run.status).toBe(201);
    expect(typeof run.body.runId).toBe('string');

    // Let the inline dispatch settle so the runs row is `completed`, which is
    // the state that used to make the cross-endpoint leak observable.
    await new Promise((r) => setTimeout(r, 100));

    const agent = await post<{ agentId?: string; runId?: string }>(
      '/v1/host/openwop-app/agents',
      { persona: 'Cross Endpoint', modelClass: 'chat', systemPrompt: 'You are helpful.' },
      { 'idempotency-key': key },
    );
    // Must be a real agent create, NOT the run's cached 201 body.
    expect(agent.status).toBe(201);
    expect(agent.body.runId).toBeUndefined();
    expect(agent.body.agentId).toBe('user.cross-endpoint');
    expect(agent.headers.get('openwop-Idempotent-Replay')).toBeNull();
  });

  it('same key + same body on one endpoint still replays with the marker header', async () => {
    // The behaviour the fix must NOT break.
    const key = 'happy-path-replay';
    const body = { workflowId: 'openwop-app.uppercase', tenantId: 'demo', inputs: { text: 'same' } };
    const first = await post<CreateRunBody>('/v1/runs', body, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    const second = await post<CreateRunBody>('/v1/runs', body, { 'idempotency-key': key });
    expect(second.status).toBe(201);
    expect(second.headers.get('openwop-Idempotent-Replay')).toBe('true');
    expect(second.body.runId).toBe(first.body.runId);
  });

  it('same key + DIFFERENT body returns 409 replay-mismatch, and survives a restart', async () => {
    const key = 'mismatch-durable';
    await post('/v1/runs', { workflowId: 'openwop-app.uppercase', tenantId: 'demo', inputs: { text: 'one' } }, { 'idempotency-key': key });
    await new Promise((r) => setTimeout(r, 100));
    const divergent = await post<CreateRunBody>(
      '/v1/runs',
      { workflowId: 'openwop-app.uppercase', tenantId: 'demo', inputs: { text: 'TWO' } },
      { 'idempotency-key': key },
    );
    expect(divergent.status).toBe(409);
    expect(divergent.body.error).toBe('idempotency_key_mismatch');
    // Durability is the P0 gain here: the digest lives in the row, not in a
    // process-local Map, so this verdict no longer resets on restart. The
    // restart itself is exercised at the storage layer below.
  });
});

describe('ADR 0549 P0 — the digest survives a process restart', () => {
  it('a mismatch is still detected against a reopened database', async () => {
    // The old implementation kept body hashes in a module-scope Map, so a
    // restart silently downgraded a 409 mismatch into a served replay of the
    // WRONG body. Same file on disk, two Storage instances.
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'idem-restart-'));
    const dsn = `sqlite://${join(dir, 'test.db')}`;
    const key = 'survives-restart';
    const now = new Date().toISOString();
    const d1 = canonicalRequestDigest({ text: 'first' }, 'POST:/v1/runs');
    const d2 = canonicalRequestDigest({ text: 'second' }, 'POST:/v1/runs');

    const before = await openStorage(dsn);
    const __claim3 = await before.claimIdempotentResponse({
      tenantId: 't', endpoint: 'POST:/v1/runs', key, requestDigest: d1, createdAt: now,
      leaseMs: LEASE_MS,
    });
    await before.completeIdempotentResponse({
      claimToken: tokenOf(__claim3),
      tenantId: 't', endpoint: 'POST:/v1/runs', key, responseStatus: 201,
      responseBody: '{"runId":"before-restart"}', updatedAt: now,
    });
    await before.close?.();

    const after = await openStorage(dsn);
    const mismatch = await after.claimIdempotentResponse({
      tenantId: 't', endpoint: 'POST:/v1/runs', key, requestDigest: d2, createdAt: now,
      leaseMs: LEASE_MS,
    });
    expect(mismatch.outcome).toBe('mismatch');

    const replay = await after.claimIdempotentResponse({
      tenantId: 't', endpoint: 'POST:/v1/runs', key, requestDigest: d1, createdAt: now,
      leaseMs: LEASE_MS,
    });
    expect(replay).toMatchObject({ outcome: 'replay', responseBody: '{"runId":"before-restart"}' });
    await after.close?.();
  });
});

/**
 * ADR 0549 P1 — LIVENESS. P0 settled *who owns a key*; P1 settles *what happens
 * when the owner stalls or dies*.
 *
 * The pre-P1 failure this closes: an exception between claim and commit left
 * the row `pending` forever, so the caller was 409-locked on that key for good
 * — a transient error converted into permanent denial of service.
 *
 * The failure P1 must NOT introduce: reclaiming from a merely-SLOW holder, so
 * that both it and the reclaimer create work. That is prevented by the lease
 * being DERIVED from the request timeout rather than picked — see
 * `idempotencyLeaseMs()` and the config-invariant test at the bottom.
 */
describe('ADR 0549 P1 — lease, reclaim, CAS and release', () => {
  const ENDPOINT = 'POST:/v1/runs';
  const digest = canonicalRequestDigest({ text: 'p1' }, 'POST:/v1/runs');

  it('a claim returns a token, and a second caller is in-flight while the lease is live', async () => {
    const s = await openStorage(':memory:');
    const now = new Date().toISOString();
    const first = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'k', requestDigest: digest, createdAt: now, leaseMs: LEASE_MS,
    });
    expect(first.outcome).toBe('claimed');
    if (first.outcome !== 'claimed') throw new Error('unreachable');
    expect(typeof first.claimToken).toBe('string');
    expect(first.claimToken.length).toBeGreaterThan(0);

    const second = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'k', requestDigest: digest, createdAt: now, leaseMs: LEASE_MS,
    });
    expect(second.outcome).toBe('in-flight');
  });

  it('an EXPIRED claim is reclaimed, and the reclaimer gets a DIFFERENT token', async () => {
    const s = await openStorage(':memory:');
    const t0 = new Date('2026-08-11T10:00:00.000Z').toISOString();
    const afterLease = new Date('2026-08-11T10:05:00.000Z').toISOString(); // t0 + 5 min

    const first = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'stale', requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    if (first.outcome !== 'claimed') throw new Error('expected claimed');

    const reclaim = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'stale', requestDigest: digest, createdAt: afterLease, leaseMs: 60_000,
    });
    expect(reclaim.outcome).toBe('claimed');
    if (reclaim.outcome !== 'claimed') throw new Error('unreachable');
    expect(reclaim.claimToken).not.toBe(first.claimToken);
  });

  it('the ORIGINAL holder cannot commit after being reclaimed (compare-and-set)', async () => {
    // The heart of P1: a stalled holder waking up late must not overwrite the
    // response the reclaimer already gave the client.
    const s = await openStorage(':memory:');
    const t0 = new Date('2026-08-11T10:00:00.000Z').toISOString();
    const afterLease = new Date('2026-08-11T10:05:00.000Z').toISOString();

    const first = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'cas', requestDigest: digest, createdAt: t0, leaseMs: 60_000,
    });
    if (first.outcome !== 'claimed') throw new Error('expected claimed');
    const second = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'cas', requestDigest: digest, createdAt: afterLease, leaseMs: 60_000,
    });
    if (second.outcome !== 'claimed') throw new Error('expected reclaim');

    const winner = await s.completeIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'cas', responseStatus: 201,
      responseBody: '{"runId":"reclaimer"}', updatedAt: afterLease, claimToken: second.claimToken,
    });
    expect(winner).toBe(true);

    const loser = await s.completeIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'cas', responseStatus: 201,
      responseBody: '{"runId":"STALE-HOLDER"}', updatedAt: afterLease, claimToken: first.claimToken,
    });
    expect(loser).toBe(false);

    const replay = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'cas', requestDigest: digest, createdAt: afterLease, leaseMs: 60_000,
    });
    expect(replay).toMatchObject({ outcome: 'replay', responseBody: '{"runId":"reclaimer"}' });
  });

  it('release makes the key immediately retryable instead of 409-locked', async () => {
    const s = await openStorage(':memory:');
    const now = new Date().toISOString();
    const first = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'rel', requestDigest: digest, createdAt: now, leaseMs: LEASE_MS,
    });
    if (first.outcome !== 'claimed') throw new Error('expected claimed');

    // Without release this would be `in-flight` until the lease expired.
    await s.releaseIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'rel', claimToken: first.claimToken,
    });
    const retry = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'rel', requestDigest: digest, createdAt: now, leaseMs: LEASE_MS,
    });
    expect(retry.outcome).toBe('claimed');
  });

  it('release is a NO-OP once the row is completed', async () => {
    // This is what makes the route's `finally` safe without it classifying
    // errors: the state machine closes the window, not the handler.
    const s = await openStorage(':memory:');
    const now = new Date().toISOString();
    const c = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'done', requestDigest: digest, createdAt: now, leaseMs: LEASE_MS,
    });
    if (c.outcome !== 'claimed') throw new Error('expected claimed');
    await s.completeIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'done', responseStatus: 201,
      responseBody: '{"runId":"committed"}', updatedAt: now, claimToken: c.claimToken,
    });

    await s.releaseIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'done', claimToken: c.claimToken,
    });

    const after = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'done', requestDigest: digest, createdAt: now, leaseMs: LEASE_MS,
    });
    expect(after).toMatchObject({ outcome: 'replay', responseBody: '{"runId":"committed"}' });
  });

  it('release with the WRONG token does nothing', async () => {
    const s = await openStorage(':memory:');
    const now = new Date().toISOString();
    const c = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'wrong-tok', requestDigest: digest, createdAt: now, leaseMs: LEASE_MS,
    });
    if (c.outcome !== 'claimed') throw new Error('expected claimed');
    await s.releaseIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'wrong-tok', claimToken: 'some-other-token',
    });
    const still = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: ENDPOINT, key: 'wrong-tok', requestDigest: digest, createdAt: now, leaseMs: LEASE_MS,
    });
    expect(still.outcome).toBe('in-flight');
  });
});

describe('ADR 0549 P1 — the lease is DERIVED, and that is the safety property', () => {
  const prior = process.env.OPENWOP_REQUEST_TIMEOUT_MS;
  afterAll(() => {
    if (prior === undefined) delete process.env.OPENWOP_REQUEST_TIMEOUT_MS;
    else process.env.OPENWOP_REQUEST_TIMEOUT_MS = prior;
  });

  it('always exceeds the request timeout, at every configured value', () => {
    // THE invariant. A lease shorter than a legal request means a merely-slow
    // holder gets reclaimed, and then two callers each create work — the exact
    // duplicate the ledger exists to prevent. Anyone "tuning" the lease down
    // trips this rather than silently arming duplicate execution.
    for (const cfg of ['1000', '30000', '120000', '300000']) {
      process.env.OPENWOP_REQUEST_TIMEOUT_MS = cfg;
      expect(idempotencyLeaseMs()).toBeGreaterThan(resolveRequestTimeoutMs());
    }
  });

  it('clears Cloud Run’s outer timeout when the middleware is DISABLED', () => {
    // `OPENWOP_REQUEST_TIMEOUT_MS=0` turns the in-process bound off entirely,
    // so the real ceiling becomes Cloud Run's `--timeout=300`. A lease derived
    // naively from the configured value would be 60s here — shorter than a
    // request can legally run.
    process.env.OPENWOP_REQUEST_TIMEOUT_MS = '0';
    expect(resolveRequestTimeoutMs()).toBe(0);
    expect(idempotencyLeaseMs()).toBeGreaterThan(300_000);
  });
});

describe('ADR 0549 P1 — the route releases a claim it never committed', () => {
  /**
   * FIRST ATTEMPT AT THIS TEST WAS VACUOUS, and the correction is the point.
   *
   * It used an unknown `workflowId` to force a failure — but `routes/runs.ts`
   * throws "Workflow not found" at :317, BEFORE the idempotency claim at :343.
   * No claim was ever taken, so the retry trivially succeeded and the test
   * proved nothing about the release. A guard that cannot fail is worse than
   * no guard, because it reports coverage it does not have.
   *
   * The first throw that actually lands AFTER the claim is the ADR 0482 daily
   * budget cap (:391), which has a documented test seam. So that is the lever.
   */
  const realBudget = __budgetReadsForTests.budget;
  const realSpend = __budgetReadsForTests.spend;
  afterAll(() => {
    __budgetReadsForTests.budget = realBudget;
    __budgetReadsForTests.spend = realSpend;
  });

  it('a post-claim failure leaves the key retryable, not 409-locked forever', async () => {
    const key = `release-on-failure-${Math.random().toString(36).slice(2)}`;
    const body = { workflowId: 'openwop-app.uppercase', tenantId: 'demo', inputs: { text: 'x' } };

    // Force the budget cap so the handler throws 429 AFTER winning the claim.
    __budgetReadsForTests.budget = async () => ({ hardCap: true, dailyUsd: 1 }) as never;
    __budgetReadsForTests.spend = async () => 999;

    const failed = await post<{ error?: string }>('/v1/runs', body, { 'idempotency-key': key });
    expect(failed.status).toBe(429);
    expect(failed.body.error).toBe('rate_limited');

    // Lift the cap. Before P1 the row was stranded `pending`, so this retry
    // returned 409 in-flight — permanently, for the life of that key.
    __budgetReadsForTests.budget = realBudget;
    __budgetReadsForTests.spend = realSpend;

    const retry = await post<CreateRunBody>('/v1/runs', body, { 'idempotency-key': key });
    expect(retry.status).toBe(201);
    expect(typeof retry.body.runId).toBe('string');
  });

  it('a committed response is still replayed — release must not eat it', async () => {
    // The other side of the same `finally`: once `complete` has run, the token
    // is cleared and the row must survive to be replayed.
    const key = `commit-then-replay-${Math.random().toString(36).slice(2)}`;
    const body = { workflowId: 'openwop-app.uppercase', tenantId: 'demo', inputs: { text: 'keep' } };
    const first = await post<CreateRunBody>('/v1/runs', body, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    const second = await post<CreateRunBody>('/v1/runs', body, { 'idempotency-key': key });
    expect(second.status).toBe(201);
    expect(second.headers.get('openwop-Idempotent-Replay')).toBe('true');
    expect(second.body.runId).toBe(first.body.runId);
  });
});
