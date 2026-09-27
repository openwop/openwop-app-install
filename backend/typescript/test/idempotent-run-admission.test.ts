/**
 * ADR 0549 H56 — one `Idempotency-Key` admits ONE run.
 *
 * ADR 0549 P1 shipped with a residual it stated honestly: "a holder that
 * crashes BETWEEN `insertRun` and `complete` has already created a run, so the
 * reclaimer creates a second." Measured on `origin/main` 650544333 the window
 * was two windows, and neither is narrow:
 *
 *   (a) CRASH / PAST-LEASE. The run row commits (`insertRunWithStartContext`,
 *       `runs.ts` ~L457) ~40 lines before `completeIdempotentResponse`
 *       (~L495). A holder that dies in between leaves the ledger `pending`; when
 *       the lease lapses the retry's `claimIdempotentResponse` RECLAIMS it —
 *       nothing looks for the run row that already carries this key — and the
 *       retry mints a SECOND run.
 *   (b) THROW AFTER INSERT. Any throw between insert and complete reaches the
 *       `finally`, whose `releaseIdempotentResponse` DELETES the pending row, so
 *       the very next retry wins a fresh claim and mints a SECOND run. The
 *       release comment called a failed release "strictly no worse" — false the
 *       moment the run row exists.
 *
 * Both are the duplicate the ledger exists to prevent (`idempotency.md`
 * §Concurrent duplicates: "MUST process exactly one to completion").
 *
 * THE FIX is the ADR 0551 P1 outbox shape applied to the ledger: the run row and
 * the ledger `complete` land in ONE storage transaction
 * (`InsertRunOptions.idempotencyCommit`). Either both committed or neither, so
 * there is no instant at which a run exists and the ledger does not say so.
 *
 * HOW THE TESTS EMULATE THE WINDOWS. Both cases wrap the app's OWN storage
 * object (`app.locals.storage`, the plain adapter object the router closes
 * over) so the route runs its real code against a real SQLite ledger:
 *   - (a) `insertRun` runs for real and then throws "process died", and
 *     `releaseIdempotentResponse` is stubbed to a no-op for that request — a
 *     dead process runs no `finally`. Then the clock is moved past the lease
 *     (`vi.setSystemTime`, Date only — the http server's timers stay real).
 *   - (b) `hostSuite.auditSink.record` (a genuine step between insert and
 *     complete, `runs.ts` ~L478) throws once; the `finally` runs for real.
 *
 * VERIFICATION SCOPE. SQLite (`memory://` IS the SQLite adapter — ADR 0549
 * CORRECTION 5). The Postgres half of the same transaction is asserted in
 * `storage-adapter-parity-testcontainers.test.ts` (real Postgres, Docker-gated).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { idempotencyLeaseMs } from '../src/host/idempotentResponse.js';

let app: Express;
let server: http.Server;
let BASE: string;
let storage: Storage;
let hostSuite: HostAdapterSuite;
const TOKEN = 'dev-token';
const TENANT = 'demo';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
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

afterEach(() => {
  vi.useRealTimers();
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
  error?: string;
  details?: Record<string, unknown>;
}

/** Every run row this tenant holds under `key` — the duplicate detector. */
async function runsWithKey(key: string) {
  const all = await storage.listRuns({ tenantId: TENANT, limit: 10_000 });
  return all.filter((r) => r.idempotencyKey === key);
}

const BODY = { workflowId: 'openwop-app.uppercase', tenantId: TENANT, inputs: { text: 'once' } };

/**
 * Wrap `storage.insertRun` so the NEXT call runs the real insert and then
 * throws — the run row (and whatever else the adapter commits with it) is
 * durable, and the handler unwinds as if the process had died / thrown right
 * after the write. One-shot: it restores itself.
 */
function dieRightAfterNextInsertRun(): void {
  const real = storage.insertRun.bind(storage);
  storage.insertRun = async (run, opts) => {
    storage.insertRun = real;
    await real(run, opts);
    throw new Error('simulated: process died right after the run row committed');
  };
}

/** A dead process runs no `finally`: make the next release a no-op. One-shot. */
function suppressNextRelease(): void {
  const real = storage.releaseIdempotentResponse.bind(storage);
  storage.releaseIdempotentResponse = async () => {
    storage.releaseIdempotentResponse = real;
  };
}

describe('ADR 0549 H56 — window (a): holder dies after the run row commits, before the ledger commit', () => {
  it('a same-key retry after the lease lapses REPLAYS the first run — it never mints a second', async () => {
    const key = `h56-crash-${Math.random().toString(36).slice(2)}`;

    dieRightAfterNextInsertRun();
    suppressNextRelease();
    const first = await post<CreateRunBody>('/v1/runs', BODY, { 'idempotency-key': key });
    // The client saw a failure (the process "died"), but a run row EXISTS.
    expect(first.status).toBeGreaterThanOrEqual(500);
    const afterCrash = await runsWithKey(key);
    expect(afterCrash).toHaveLength(1);
    const survivingRunId = afterCrash[0]!.runId;

    // Move the clock past the lease so the ledger row is reclaimable.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + idempotencyLeaseMs() + 5_000);

    const retry = await post<CreateRunBody>('/v1/runs', BODY, { 'idempotency-key': key });
    expect(retry.status).toBe(201);
    // THE assertion. Before H56: `retry.body.runId !== survivingRunId` and two
    // rows — the reclaim minted a second run for one key.
    expect(retry.body.runId).toBe(survivingRunId);
    expect(retry.headers.get('openwop-Idempotent-Replay')).toBe('true');
    expect(await runsWithKey(key)).toHaveLength(1);
  });
});

describe('ADR 0549 H56 — window (b): a throw between the run insert and the ledger commit', () => {
  it('the retry REPLAYS the run that was already created — the finally can no longer strand it', async () => {
    const key = `h56-throw-${Math.random().toString(36).slice(2)}`;

    // A genuine step between insert and complete: the run.create audit record.
    const realRecord = hostSuite.auditSink.record.bind(hostSuite.auditSink);
    hostSuite.auditSink.record = (() => {
      hostSuite.auditSink.record = realRecord;
      throw new Error('simulated: audit sink threw after the run row committed');
    }) as typeof realRecord;
    try {
      const first = await post<CreateRunBody>('/v1/runs', BODY, { 'idempotency-key': key });
      expect(first.status).toBeGreaterThanOrEqual(500);
    } finally {
      hostSuite.auditSink.record = realRecord;
    }
    const afterThrow = await runsWithKey(key);
    expect(afterThrow).toHaveLength(1);
    const survivingRunId = afterThrow[0]!.runId;

    // Immediately (lease still live). Before H56 the `finally` had DELETED the
    // pending row, so this claim was a fresh win and a second run was minted.
    const retry = await post<CreateRunBody>('/v1/runs', BODY, { 'idempotency-key': key });
    expect(retry.status).toBe(201);
    expect(retry.body.runId).toBe(survivingRunId);
    expect(retry.headers.get('openwop-Idempotent-Replay')).toBe('true');
    expect(await runsWithKey(key)).toHaveLength(1);
  });
});

describe('ADR 0549 H56 — the ledger commit rides INSIDE the run insert (storage contract, SQLite)', () => {
  it('insertRun with idempotencyCommit lands the run row and the completed ledger row together', async () => {
    const key = `h56-atomic-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const { canonicalRequestDigest } = await import('../src/host/idempotentResponse.js');
    const { buildRunRecord } = await import('../src/host/runDispatch.js');
    const claim = await storage.claimIdempotentResponse({
      tenantId: TENANT, endpoint: 'POST:/v1/runs', key,
      requestDigest: canonicalRequestDigest(BODY, 'POST:/v1/runs'), createdAt: now, leaseMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error(`expected claimed, got ${claim.outcome}`);
    const run = buildRunRecord({ workflowId: BODY.workflowId, tenantId: TENANT, inputs: BODY.inputs, idempotencyKey: key, now });
    await storage.insertRun(run, {
      dispatchOutbox: { nextAttemptAt: Date.now() + 10_000 },
      idempotencyCommit: {
        tenantId: TENANT, endpoint: 'POST:/v1/runs', key, claimToken: claim.claimToken,
        responseStatus: 201, responseBody: JSON.stringify({ runId: run.runId }), updatedAt: now,
      },
    });
    expect((await storage.getRun(run.runId))?.runId).toBe(run.runId);
    // The ledger row is COMPLETED in the same write — a fresh claim replays it.
    const again = await storage.claimIdempotentResponse({
      tenantId: TENANT, endpoint: 'POST:/v1/runs', key,
      requestDigest: canonicalRequestDigest(BODY, 'POST:/v1/runs'), createdAt: now, leaseMs: 60_000,
    });
    expect(again).toMatchObject({ outcome: 'replay', responseStatus: 201, responseBody: JSON.stringify({ runId: run.runId }) });
  });

  it('a ledger commit the CAS rejects ROLLS BACK the run row — both or neither', async () => {
    const key = `h56-cas-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const { canonicalRequestDigest } = await import('../src/host/idempotentResponse.js');
    const { buildRunRecord } = await import('../src/host/runDispatch.js');
    const claim = await storage.claimIdempotentResponse({
      tenantId: TENANT, endpoint: 'POST:/v1/runs', key,
      requestDigest: canonicalRequestDigest(BODY, 'POST:/v1/runs'), createdAt: now, leaseMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error(`expected claimed, got ${claim.outcome}`);
    const run = buildRunRecord({ workflowId: BODY.workflowId, tenantId: TENANT, inputs: BODY.inputs, idempotencyKey: key, now });
    // The WRONG token models a slow holder whose lease was reclaimed while it
    // worked: the reclaimer owns the key now, so this holder's run must not land.
    await expect(storage.insertRun(run, {
      dispatchOutbox: { nextAttemptAt: Date.now() + 10_000 },
      idempotencyCommit: {
        tenantId: TENANT, endpoint: 'POST:/v1/runs', key, claimToken: 'not-the-holder',
        responseStatus: 201, responseBody: '{}', updatedAt: now,
      },
    })).rejects.toMatchObject({ code: 'idempotency_commit_rejected' });
    expect(await storage.getRun(run.runId)).toBeNull();
    expect(await storage.getDispatchOutbox(run.runId)).toBeNull();
    expect(await runsWithKey(key)).toHaveLength(0);
  });
});

describe('ADR 0549 H56 — the in-flight 409 carries the code the spec names', () => {
  it('a concurrent same-key request gets 409 `idempotency_in_flight` with details.retryAfter (idempotency.md §Concurrent duplicates)', async () => {
    const key = `h56-inflight-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const { canonicalRequestDigest } = await import('../src/host/idempotentResponse.js');
    // Hold the claim from "another request" so the route's claim reports in-flight.
    const held = await storage.claimIdempotentResponse({
      tenantId: TENANT, endpoint: 'POST:/v1/runs', key,
      requestDigest: canonicalRequestDigest(BODY, 'POST:/v1/runs'), createdAt: now, leaseMs: 60_000,
    });
    expect(held.outcome).toBe('claimed');
    const res = await post<CreateRunBody>('/v1/runs', BODY, { 'idempotency-key': key });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('idempotency_in_flight');
    expect(typeof res.body.details?.retryAfter).toBe('number');
    expect(res.body.details?.retryAfter as number).toBeGreaterThan(0);
    // ADR 0744 — the timing also rides the standard header, equal to the body.
    expect(res.headers.get('retry-after')).toBe(String(res.body.details?.retryAfter));
    // No run was admitted for the in-flight key.
    expect(await runsWithKey(key)).toHaveLength(0);
  });

  it('ADR 0744 — under major 2 the in-flight 409 carries Retry-After and NO retry timing in details', async () => {
    // v2 `errors.md` §Retry timing: timing lives in `Retry-After` only; the
    // negotiator strips `details.retryAfter`, so before ADR 0744 a major-2
    // loser was told nothing about when to come back (openwop RFC 0213 §B draft:
    // MUST 409 `idempotency_in_flight`, no retry timing in `details`, SHOULD
    // `Retry-After`).
    const key = `adr0744-inflight-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const { canonicalRequestDigest } = await import('../src/host/idempotentResponse.js');
    const held = await storage.claimIdempotentResponse({
      tenantId: TENANT, endpoint: 'POST:/v1/runs', key,
      requestDigest: canonicalRequestDigest(BODY, 'POST:/v1/runs'), createdAt: now, leaseMs: 60_000,
    });
    expect(held.outcome).toBe('claimed');
    const res = await post<CreateRunBody>('/runs', BODY, { 'idempotency-key': key, 'openwop-version': '2' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('idempotency_in_flight');
    for (const k of ['retryAfter', 'retryAfterMs', 'retryAfterSeconds']) {
      expect(res.body.details?.[k], `details.${k} is forbidden under major 2`).toBeUndefined();
    }
    const retryAfter = res.headers.get('retry-after');
    expect(retryAfter, 'a major-2 in-flight 409 must say when to retry').not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(await runsWithKey(key)).toHaveLength(0);
  });

  it('same key + different body is refused 409 with the CANONICAL code', async () => {
    // The canonical spelling is `idempotency_key_mismatch` — `idempotency.md`
    // v1.5 §Layer 1 (2026-08-18) names it, and it is the only spelling present
    // in two shipped artifacts including the published SDK's `HTTP_ERROR_CODES`.
    //
    // HISTORY, because this assertion changed twice and the reasons differ.
    // This card originally REVERTED the inherited WIP's rename back to
    // `idempotency_key_replay_mismatch`, on the grounds that a wire-visible
    // rename does not belong inside an admission-atomicity change — it would be
    // read as an incidental diff line rather than as the wire decision it is.
    // That was right at the time. The rename then landed on its own as H63
    // (`92a3141e6`), so the revert has served its purpose and this branch simply
    // adopts the settled spelling.
    //
    // The gate caught the gap: the ROUTE moved to the canonical code on rebase
    // and this assertion did not, so the test still pinned the spelling its own
    // comment described as superseded.
    const key = `h56-mismatch-${Math.random().toString(36).slice(2)}`;
    const first = await post<CreateRunBody>('/v1/runs', BODY, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    const divergent = await post<CreateRunBody>('/v1/runs', { ...BODY, inputs: { text: 'DIFFERENT' } }, { 'idempotency-key': key });
    expect(divergent.status).toBe(409);
    expect(divergent.body.error).toBe('idempotency_key_mismatch');
  });
});
