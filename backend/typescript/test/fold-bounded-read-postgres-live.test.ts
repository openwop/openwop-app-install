/**
 * ADR 0003 Phase 4c (the bounded-fold correction, ce2330535) — the bounded tenant-fold
 * read on REAL Postgres 15 (production runs Cloud SQL POSTGRES_15).
 * fold-bounded-read.test.ts runs on pg-mem, which lacks `strpos` and is given a shim, so
 * this file is the evidence that the production SQL selects the same rows on the engine
 * that runs it: same seed, same equality to the old whole-table pass.
 *
 * THE DEFAULT GATE SKIPS THIS FILE. `npm run ci` runs backend vitest with
 * OPENWOP_SKIP_TESTCONTAINERS=1 and no OPENWOP_PG_TEST_DSN, so both cases report
 * skipped there (a skip is not a pass). It runs only with OPENWOP_PG_TEST_DSN set, or
 * with Docker outside the gate; otherwise it skips with a warning.
 *
 * Sabotage, measured on Postgres 15 with a DSN (w87): the `strpos(k, …)` key test made
 * false → both cases red; the value test fed the raw id instead of the JSON-escaped one
 * → the escaped case reds; `tenantFoldNeedles` returning `[from, from]` → the escaped
 * case reds; the `hostext:access-orgs:` exclusion dropped → both cases red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import pg from 'pg';
import type { Storage } from '../src/storage/storage.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { foldAfter, foldOldPass, foldSeed, FOLD_TO } from './helpers/foldShapes.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();

let storage: Storage | null = null;
let dsn = '';
let stopContainer: (() => Promise<unknown>) | null = null;
const NS = ['fbA', 'fbB'];

async function clean(): Promise<void> {
  const c = new pg.Client({ connectionString: dsn });
  await c.connect();
  for (const ns of NS) await c.query(`DELETE FROM host_ext_kv WHERE strpos(k, $1) > 0`, [ns]);
  await c.end();
}

beforeAll(async () => {
  if (!available) {
    console.warn('[fold-bounded-read-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  if (externalDsn) {
    dsn = externalDsn;
  } else {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  storage = await openPostgresStorage(dsn);
  await clean();
}, 120_000);

afterAll(async () => {
  if (dsn) await clean().catch(() => {});
  if (storage) await storage.close().catch(() => {});
  if (stopContainer) await stopContainer().catch(() => {});
}, 60_000);

describe.skipIf(!available)('bounded fold read on real Postgres', () => {
  it.each([
    ['an anon sandbox id', 'anon:sidLIVE_1', 'fbA'],
    ['a tenant id JSON escapes', 'anon:live"b\\c', 'fbB'],
  ])('rewrites exactly what the whole-table pass rewrote: %s', async (_label, from, ns) => {
    if (!storage) throw new Error('storage not opened');
    const rows = foldSeed(from, ns);
    const expected = foldOldPass(rows, from);
    expect(Object.keys(expected)).toContain(`hostext:wf:own:${FOLD_TO}:id-${ns}`);
    expect(await foldAfter(storage, rows, from, ns)).toEqual(expected);
  });
});
