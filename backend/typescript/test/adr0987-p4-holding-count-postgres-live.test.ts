/**
 * ADR 0987 D6 / P4 — the Operations holding count on real Postgres.
 *
 * `countAdmissionHolding` counts runs with an admission key in a holding state,
 * stopping at its limit. The SQLite half is in `adr0987-p4-admission-summary.test.ts`;
 * this is the Postgres statement, which production runs. The database may be shared
 * with other live tests, so the assertions are on the CHANGE this file makes.
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set, else a `postgres:15-alpine`
 * testcontainer when Docker is reachable, else skips with a notice.
 * Live-infra: skipped in `npm run ci` (OPENWOP_SKIP_TESTCONTAINERS=1).
 *
 * The count is global (no tenant filter), so another live writer adding keyed
 * pending/running runs between the two reads would move it: an honest ceiling,
 * since only a tenant-scoped count (a product change) could close it. Every run
 * this file inserts is deleted in `afterAll`, so the shared database does not grow.
 *
 * Sabotage notes (each run red against local Postgres 15, 2026-10-31; w83 again):
 *  - remove `admission_key IS NOT NULL` → red (the unkeyed run counts);
 *  - drop the LIMIT → red ("stops at its limit");
 *  - count `waiting-approval` as holding → red (w83).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();

let storage: Storage | null = null;
let stopContainer: (() => Promise<unknown>) | null = null;

beforeAll(async () => {
  if (!available) {
    console.warn('[adr0987-p4-holding-count-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
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
}, 180_000);

/** Every run this file inserts, removed in `afterAll`. */
const inserted: string[] = [];

afterAll(async () => {
  if (storage) {
    for (const id of inserted) await storage.deleteRun(id);
    await storage.close().catch(() => {});
  }
  if (stopContainer) await stopContainer().catch(() => {});
}, 60_000);

const s = (): Storage => storage!;
const tenantId = `adr0987-p4-${randomUUID().slice(0, 8)}`;
const run = (status: RunRecord['status']): RunRecord => {
  const now = new Date().toISOString();
  const runId = randomUUID();
  inserted.push(runId);
  return { runId, workflowId: 'adr0987.p4', tenantId, status, inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
};

describe.skipIf(!available)('ADR 0987 D6 — the holding count on Postgres', () => {
  it('counts keyed pending/running runs only', async () => {
    const before = await s().countAdmissionHolding(100_000);
    await s().insertRun(run('running'), { admission: { key: `p4-${randomUUID()}`, cap: 5 } });
    await s().insertRun(run('pending'), { admission: { key: `p4-${randomUUID()}`, cap: 5 } });
    await s().insertRun(run('running'));
    await s().insertRun(run('waiting-approval'), { admission: { key: `p4-${randomUUID()}`, cap: 5 } });
    expect(await s().countAdmissionHolding(100_000)).toBe(before + 2);
  });

  it('stops at its limit', async () => {
    await s().insertRun(run('running'), { admission: { key: `p4-${randomUUID()}`, cap: 5 } });
    await s().insertRun(run('running'), { admission: { key: `p4-${randomUUID()}`, cap: 5 } });
    expect(await s().countAdmissionHolding(1)).toBe(1);
  });
});
