/**
 * CC-SEARCH-1b — every jsonb write on the runs path survives a lone UTF-16
 * surrogate, not just the node-result / event / interrupt writes #5825 fixed.
 *
 * CC-SEARCH-1 (#5825) routed node results, event payloads, interrupts and run
 * creation through `nulSafe`, but four other jsonb writes still passed a raw
 * object (node-pg stringifies it with no replacer) or a bare `JSON.stringify`:
 * `updateRun` (inputs / metadata / configurable), `mergeRunMetadata`,
 * `insertAnnotation` and `putEnvelopeCorrelation`. Web text cut by UTF-16 code
 * units (`slice`) can carry half an emoji into any of them, and Postgres `jsonb`
 * rejects the lone escape with `invalid input syntax for type json` — the same
 * failure that dead-lettered `outreach.researched-firsttouch` on 373d4863a.
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set (this Mac: Homebrew postgresql@15,
 * matching prod Cloud SQL 15), else a `postgres:15-alpine` testcontainer when
 * Docker is reachable, else skips with a notice. Live-infra: skipped in
 * `npm run ci` (OPENWOP_SKIP_TESTCONTAINERS=1) — a skip there is not a pass; the
 * pure sibling `cc-search-1b-jsonb-writes.test.ts` pins the serializer in CI.
 *
 * Red when: any of the four writes stringifies without `nulSafe` — Postgres
 * throws `invalid input syntax for type json` (witnessed against PG 15).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import type { Storage } from '../src/storage/storage.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();

let storage: Storage | null = null;
let stopContainer: (() => Promise<unknown>) | null = null;
const T = 'cc-search-1b-pg';
const RUN = `cc-search-1b-run-${Date.now()}`;
/** Half an emoji, as a code-unit `slice` leaves it. */
const HALF = 'Goal apps 😀'.slice(0, 11);
const SAFE = 'Goal apps �';

beforeAll(async () => {
  if (!available) {
    console.warn('[cc-search-1b-jsonb-writes-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  let dsn: string;
  if (externalDsn) {
    dsn = externalDsn;
  } else {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  storage = await openPostgresStorage(dsn);
  const now = new Date().toISOString();
  await storage.insertRun({
    runId: RUN, workflowId: 'cc-search-1b', tenantId: T, status: 'running',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  });
}, 120_000);

afterAll(async () => {
  await stopContainer?.();
});

describe.skipIf(!available)('CC-SEARCH-1b — runs-path jsonb writes accept a lone surrogate (PG 15)', () => {
  it('updateRun stores inputs / metadata / configurable with U+FFFD in place of the half emoji', async () => {
    await storage!.updateRun(RUN, { inputs: { snippet: HALF }, metadata: { note: HALF }, configurable: { q: [HALF] } });
    const run = await storage!.getRun(RUN);
    expect(run?.inputs).toEqual({ snippet: SAFE });
    expect(run?.metadata).toMatchObject({ note: SAFE });
    expect(run?.configurable).toEqual({ q: [SAFE] });
  });

  it('mergeRunMetadata merges a value carrying a lone low surrogate', async () => {
    expect(await storage!.mergeRunMetadata(RUN, { lowOnly: '\ude00x' })).toBe(true);
    expect((await storage!.getRun(RUN))?.metadata).toMatchObject({ lowOnly: '�x' });
  });

  it('insertAnnotation and putEnvelopeCorrelation persist instead of throwing', async () => {
    const at = new Date().toISOString();
    await expect(storage!.insertAnnotation({
      annotationId: `${RUN}-a1`, runId: RUN, tenantId: T, payload: { comment: HALF }, createdAt: at,
    } as Parameters<Storage['insertAnnotation']>[0])).resolves.not.toThrow();
    await expect(storage!.putEnvelopeCorrelation(RUN, `${RUN}-c1`, { text: HALF } as never, 'cc-test', at)).resolves.not.toThrow();
  });
});
