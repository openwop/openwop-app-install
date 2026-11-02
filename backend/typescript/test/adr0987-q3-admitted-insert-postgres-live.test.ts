/**
 * ADR 0987 Q3 — the admitted run insert on REAL Postgres.
 *
 * Q3 trimmed the section between the partition-3 admission lock and COMMIT to
 * ONE statement: the holding count, the run insert (stamping `admission_key`)
 * and the dispatch-outbox row, as data-modifying CTEs. The idempotency commit
 * moved before the lock. pg-mem does not run this path, so these pins need a
 * real server:
 *   - an admitted run carries `admission_key`, and its outbox row carries the
 *     same ISO stamps the separate insert writes (the outbox columns are TEXT,
 *     `runs.created_at` is TIMESTAMPTZ);
 *   - a refusal at the cap throws `AdmissionRefusedError` with the count it
 *     read and writes neither a run row nor an outbox row;
 *   - 20 concurrent creators on one key with cap 5 admit exactly 5;
 *   - a refused admission rolls back the idempotency commit that ran before it,
 *     and a rejected commit refuses before any run row exists.
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set, else a `postgres:15-alpine`
 * testcontainer when Docker is reachable, else skips with a notice.
 * Live-infra: skipped in `npm run ci` (OPENWOP_SKIP_TESTCONTAINERS=1).
 * Sabotage, each witnessed red: the count CTE's `<` turned into `<=` (3 legs);
 * the outbox CTE reading the run's TIMESTAMPTZ `created_at` (3 legs);
 * `admission_key` dropped from the admitted insert (4 legs); and the lock folded
 * into the counting statement, so the count reads a snapshot taken before the
 * lock was granted: the concurrency leg admitted 13–14 of 20 against cap 5, in
 * 3 of 3 runs. That last one is why the lock stays its own statement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AdmissionRefusedError, IdempotentCommitRejectedError, type Storage } from '../src/storage/storage.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();

let storage: Storage | null = null;
let client: pg.Client | null = null;
let stopContainer: (() => Promise<unknown>) | null = null;

beforeAll(async () => {
  if (!available) {
    console.warn('[adr0987-q3-admitted-insert-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  let dsn = externalDsn ?? '';
  if (!externalDsn) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  storage = await openPostgresStorage(dsn);
  client = new pg.Client({ connectionString: dsn });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  if (storage) await storage.close().catch(() => {});
  if (stopContainer) await stopContainer().catch(() => {});
}, 60_000);

const s = (): Storage => storage!;
const db = (): pg.Client => client!;
const tenantId = `adr0987-q3-${randomUUID().slice(0, 8)}`;
const run = (status: 'running' | 'pending' = 'running') => {
  const now = new Date().toISOString();
  return { runId: randomUUID(), workflowId: 'adr0987.q3', tenantId, status, inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
};
const holding = async (key: string): Promise<number> =>
  Number((await db().query(`SELECT count(*)::int AS n FROM runs WHERE admission_key = $1 AND status IN ('pending','running')`, [key])).rows[0].n);

describe.skipIf(!available)('ADR 0987 Q3 — one statement after the admission lock', () => {
  it('an admitted run carries admission_key, and its outbox row carries the ISO stamps', async () => {
    const key = `q3-${randomUUID()}`;
    const r = run('pending');
    await s().insertRun(r, { admission: { key, cap: 5 }, dispatchOutbox: { nextAttemptAt: 1234 } });
    const row = (await db().query(`SELECT admission_key, status FROM runs WHERE run_id = $1`, [r.runId])).rows[0];
    expect(row).toEqual({ admission_key: key, status: 'pending' });
    const ob = (await db().query(`SELECT tenant_id, workflow_id, status, attempts, next_attempt_at, created_at, updated_at FROM dispatch_outbox WHERE run_id = $1`, [r.runId])).rows[0];
    expect(ob).toEqual({ tenant_id: tenantId, workflow_id: 'adr0987.q3', status: 'pending', attempts: 0, next_attempt_at: '1234', created_at: r.createdAt, updated_at: r.createdAt });
  });

  it('a refusal at the cap reports the count it read and writes no run row and no outbox row', async () => {
    const key = `q3-${randomUUID()}`;
    for (let i = 0; i < 2; i += 1) await s().insertRun(run(), { admission: { key, cap: 2 } });
    const r = run('pending');
    const err = await s().insertRun(r, { admission: { key, cap: 2 }, dispatchOutbox: { nextAttemptAt: 1 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdmissionRefusedError);
    expect((err as Error).message).toContain('holds 2 of 2');
    expect((await db().query(`SELECT 1 FROM runs WHERE run_id = $1`, [r.runId])).rowCount).toBe(0);
    expect((await db().query(`SELECT 1 FROM dispatch_outbox WHERE run_id = $1`, [r.runId])).rowCount).toBe(0);
    expect(await holding(key)).toBe(2);
  });

  it('20 concurrent creators on one key with cap 5 admit exactly 5', async () => {
    const key = `q3-${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => s().insertRun(run(), { admission: { key, cap: 5 }, dispatchOutbox: { nextAttemptAt: 1 } })));
    const refused = results.filter((x) => x.status === 'rejected');
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(5);
    expect(refused.every((x) => (x as PromiseRejectedResult).reason instanceof AdmissionRefusedError)).toBe(true);
    expect(await holding(key)).toBe(5);
  });

  it('a refused admission rolls back the idempotency commit; a rejected commit refuses with no run row', async () => {
    const key = `q3-${randomUUID()}`;
    await s().insertRun(run(), { admission: { key, cap: 1 } });
    const idemKey = `q3-idem-${randomUUID()}`;
    const claim = await s().claimIdempotentResponse({ tenantId, endpoint: 'POST /runs', key: idemKey, requestDigest: 'd', createdAt: new Date().toISOString(), leaseMs: 60_000 });
    expect(claim.outcome).toBe('claimed');
    const token = (claim as { claimToken: string }).claimToken;
    const commit = (claimToken: string) => ({ tenantId, endpoint: 'POST /runs', key: idemKey, claimToken, responseStatus: 202, responseBody: '{}', updatedAt: new Date().toISOString() });

    const refused = run();
    await expect(s().insertRun(refused, { admission: { key, cap: 1 }, idempotencyCommit: commit(token) })).rejects.toBeInstanceOf(AdmissionRefusedError);
    const state = (await db().query(`SELECT state FROM idempotent_response WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, idemKey])).rows[0];
    expect(state.state).not.toBe('completed');

    const rejected = run();
    await expect(s().insertRun(rejected, { admission: { key: `q3-${randomUUID()}`, cap: 5 }, idempotencyCommit: commit('not-the-token') })).rejects.toBeInstanceOf(IdempotentCommitRejectedError);
    expect((await db().query(`SELECT 1 FROM runs WHERE run_id = $1`, [rejected.runId])).rowCount).toBe(0);
  });
});
