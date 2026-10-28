/**
 * ADR 0775 P4 (`ARWF-11`) — the `user_agents` compare-and-swap on REAL Postgres.
 *
 * The conditional UPDATE compares every editable column null-safely
 * (`IS NOT DISTINCT FROM`) and the tool allowlist as `jsonb`. The SQLite twin is
 * pinned in `adr0775-p4-stale-write-guards.test.ts`; this pins the Postgres SQL,
 * which SQLite cannot exercise.
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set (any Postgres, e.g. a PGlite socket
 * server), else a `postgres:15-alpine` testcontainer when Docker is reachable,
 * else skips with a notice.
 *
 * Tracker: TST-BSW-3 (docs/steward/TEST-ASSESSMENT.md). CEILING: the default
 * gate (`npm run ci`, `OPENWOP_SKIP_TESTCONTAINERS=1`, no DSN) SKIPS both
 * cases, so the wave-60 sabotage probes on this SQL (`system_prompt`, the
 * null-safe `description`, the `jsonb` allowlist compare) were not witnessed
 * there. Case 1 targets the `system_prompt` predicate; case 2 targets the
 * null-safe compare (its first swap misses under a plain `=` on the NULL
 * description) and the `jsonb` allowlist compare (its stale swap matches if
 * the allowlist is not compared).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import type { Storage } from '../src/storage/storage.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import type { UserAgentRecord } from '../src/types.js';

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
    console.warn('[adr0775-p4-user-agent-cas-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
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
}, 120_000);

afterAll(async () => {
  await storage?.close();
  await stopContainer?.();
});

const T = 'tenant-p4-pg';
const record = (agentId: string, extra: Partial<UserAgentRecord> = {}): UserAgentRecord => ({
  agentId,
  tenantId: T,
  persona: agentId,
  modelClass: 'chat',
  systemPrompt: 'v1',
  toolAllowlist: ['openwop:core.files.read'],
  memoryShape: { scratchpad: true, conversation: false, longTerm: false },
  createdAt: new Date(0).toISOString(),
  ...extra,
});

describe.skipIf(!available)('user_agents compare-and-swap (Postgres)', () => {
  it('matches only while every editable column still equals `expected`', async () => {
    const s = storage!;
    const id = `user.p4-pg-${Date.now()}`;
    await s.insertUserAgent(record(id)); // label / description / threshold are NULL
    const read = (await s.getUserAgent(T, id))!;
    expect(await s.updateUserAgent(T, { ...read, systemPrompt: 'theirs' }, read)).toBe(true);
    expect(await s.updateUserAgent(T, { ...read, systemPrompt: 'mine' }, read)).toBe(false);
    expect((await s.getUserAgent(T, id))?.systemPrompt).toBe('theirs');
  });

  it('compares NULL columns null-safely and the allowlist as jsonb', async () => {
    const s = storage!;
    const id = `user.p4-pg-null-${Date.now()}`;
    await s.insertUserAgent(record(id, { label: 'L', confidenceThreshold: 0.65 }));
    const read = (await s.getUserAgent(T, id))!;
    // A swap against an unchanged row succeeds even with NULL description.
    expect(await s.updateUserAgent(T, { ...read, description: 'd' }, read)).toBe(true);
    const after = (await s.getUserAgent(T, id))!;
    // A concurrent allowlist change makes the stale swap miss.
    expect(await s.updateUserAgent(T, { ...after, toolAllowlist: [] }, after)).toBe(true);
    expect(await s.updateUserAgent(T, { ...after, label: 'stale' }, after)).toBe(false);
    expect((await s.getUserAgent(T, id))?.label).toBe('L');
  });
});
