/**
 * ADR 0997 D1 — `Storage.searchChatMessages` on REAL Postgres (the hermetic lane
 * runs the SQLite adapter only). Pins the Postgres SQL: `session_id = ANY`,
 * `ILIKE ALL` (every needle, case-insensitive beyond ASCII), tombstone exclusion,
 * literal LIKE metacharacters, newest-first order and the limit.
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set (any Postgres; this ADR's evidence
 * used a PGlite socket server), else a `postgres:15-alpine` testcontainer when
 * Docker is reachable, else skips with a notice. Live-infra: skipped in
 * `npm run ci` (OPENWOP_SKIP_TESTCONTAINERS=1).
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
const T = 'adr0997-pg';
const S1 = 'adr0997-s1';
const S2 = 'adr0997-s2';
const S3 = 'adr0997-s3';

beforeAll(async () => {
  if (!available) {
    console.warn('[adr0997-chat-search-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
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
  const base = Date.parse('2026-10-28T00:00:00Z');
  for (const sid of [S1, S2, S3]) {
    if (await storage.getChatSession(T, sid)) await storage.deleteChatSession(T, sid);
    const at = new Date(base).toISOString();
    await storage.createChatSession({ sessionId: sid, tenantId: T, title: sid, createdAt: at, updatedAt: at, messageCount: 0 });
  }
  const rows: Array<[string, string, string]> = [
    [S1, 'm1', 'Réunion au CAFÉ demain'],
    [S1, 'm2', 'the 100% plan_b is ready'],
    [S1, 'm3', '{"deleted":true}'],
    [S2, 'm4', 'the café is closed'],
    [S3, 'm5', 'café in a session nobody asked about'],
  ];
  let i = 0;
  for (const [sessionId, messageId, content] of rows) {
    await storage.appendChatMessage({
      messageId: `adr0997-${messageId}`, sessionId, role: 'user', content, meta: null, authorSubject: null,
      createdAt: new Date(base + ++i * 1000).toISOString(),
    });
  }
});

afterAll(async () => {
  if (storage) for (const sid of [S1, S2, S3]) await storage.deleteChatSession(T, sid).catch(() => undefined);
  await stopContainer?.();
});

describe.skipIf(!available)('ADR 0997 — searchChatMessages on Postgres', () => {
  const ids = (rows: readonly { messageId: string }[]): string[] => rows.map((r) => r.messageId);

  it('matches every needle case-insensitively (non-ASCII too), only in the given sessions, newest first', async () => {
    const rows = await storage!.searchChatMessages([S1, S2], ['café'], { limit: 10 });
    expect(ids(rows)).toEqual(['adr0997-m4', 'adr0997-m1']);
    expect(ids(await storage!.searchChatMessages([S1, S2], ['café', 'demain'], { limit: 10 }))).toEqual(['adr0997-m1']);
  });

  it('treats LIKE metacharacters literally and never returns a tombstone', async () => {
    expect(ids(await storage!.searchChatMessages([S1], ['100%'], { limit: 10 }))).toEqual(['adr0997-m2']);
    expect(ids(await storage!.searchChatMessages([S1], ['1_0'], { limit: 10 }))).toEqual([]); // unescaped, `_` would match "100"
    expect(ids(await storage!.searchChatMessages([S1], ['plan_b'], { limit: 10 }))).toEqual(['adr0997-m2']);
    expect(ids(await storage!.searchChatMessages([S1], ['deleted'], { limit: 10 }))).toEqual([]);
  });

  it('honours the limit and empty inputs', async () => {
    expect(await storage!.searchChatMessages([S1, S2, S3], ['café'], { limit: 1 })).toHaveLength(1);
    expect(await storage!.searchChatMessages([], ['café'], { limit: 10 })).toEqual([]);
    expect(await storage!.searchChatMessages([S1], [], { limit: 10 })).toEqual([]);
  });
});
