/**
 * ADR 1043 RELAY-LOG-RETENTION-1 — the delivery log's delete methods, on BOTH
 * storage backends (sqlite, and postgres through pg-mem as in
 * `storage-adapter-parity.test.ts`).
 *
 *  - `pruneDeliveryLog` deletes rows with `at` before the cutoff, keeps the rest,
 *    and keeps every row of a tenant in `exceptTenants` (legal hold);
 *  - `deleteDeliveryLogForConversation` deletes exact `conversation_id` matches
 *    in one tenant (no prefix match, no other tenant);
 *  - `deleteDeliveryLogForRelay` deletes one relay's rows in one tenant;
 *  - the migration adds the `at` index the age-out deletes through (sqlite).
 *
 * Red when either backend's predicate drifts (cutoff direction, the hold
 * exclusion, exact vs prefix, the tenant fence) or the index migration is lost.
 * Sabotage-witnessed 2026-11-04: flipping the postgres prune to `at > $1` turned
 * the postgres prune case red (sqlite stayed green). Re-witnessed 2026-11-05
 * (/grade-tests w89), each backend's own case red: the cutoff flipped, the hold
 * exclusion inverted (`NOT IN` → `IN`), a prefix (LIKE) conversation match, the
 * tenant fence dropped from the conversation and relay deletes, the relay match
 * dropped (postgres), and the sqlite `at` index pointed at another column. The
 * prune counts are exact (1 each call): a miscounted prune is red too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { pgMemAdapters } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { newDb } = require('pg-mem') as typeof import('pg-mem');
  return { pgMemAdapters: newDb().adapters.createPg() };
});
vi.mock('pg', () => ({ default: pgMemAdapters, ...pgMemAdapters }));

import Database from 'better-sqlite3';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { applyMigrations } from '../src/storage/sqlite/schema.js';
import type { Storage } from '../src/storage/storage.js';

const backends = ['sqlite', 'postgres'] as const;
const storages = new Map<string, Storage>();

beforeAll(async () => {
  storages.set('sqlite', await openSqliteStorage(':memory:'));
  storages.set('postgres', await openPostgresStorage('postgres://test/test'));
});
afterAll(async () => { for (const s of storages.values()) await s.close().catch(() => undefined); });

const S = (b: string): Storage => storages.get(b)!;
let seq = 0;
async function row(s: Storage, tenantId: string, conversationId: string, at: string, relayId?: string): Promise<string> {
  const logId = `dl_${++seq}`;
  await s.appendDeliveryLog({ logId, tenantId, channel: 'whatsapp', direction: 'outbound', conversationId, status: 'delivered', at, ...(relayId ? { relayId } : {}) });
  return logId;
}
const ids = async (s: Storage, tenantId: string): Promise<string[]> => (await s.listDeliveryLog({ tenantId, limit: 1000 })).map((r) => r.logId).sort();

describe.each(backends)('messaging_delivery_log delete paths (%s)', (b) => {
  it('pruneDeliveryLog deletes rows before the cutoff and skips excepted tenants', async () => {
    const s = S(b);
    const T = `t-prune-${b}`;
    const H = `t-held-${b}`;
    await row(s, T, 'c1', '2026-10-01T00:00:00.000Z');
    const fresh = await row(s, T, 'c1', '2026-11-03T00:00:00.000Z');
    const held = await row(s, H, 'c2', '2026-10-01T00:00:00.000Z');
    const n = await s.pruneDeliveryLog('2026-11-01T00:00:00.000Z', [H, 'unrelated-tenant']);
    // Exactly T's old row: every other case writes after the cutoff.
    expect(n).toBe(1);
    expect(await ids(s, T)).toEqual([fresh]);
    expect(await ids(s, H)).toEqual([held]);
    // With no exception the held tenant's old row goes too.
    expect(await s.pruneDeliveryLog('2026-11-01T00:00:00.000Z', [])).toBe(1);
    expect(await ids(s, H)).toEqual([]);
  });

  it('deleteDeliveryLogForConversation matches exactly, in one tenant', async () => {
    const s = S(b);
    const T = `t-conv-${b}`;
    const O = `t-conv-other-${b}`;
    await row(s, T, '+1555', '2026-11-03T00:00:00.000Z');
    const near = await row(s, T, '+15551', '2026-11-03T00:00:00.000Z');
    const other = await row(s, O, '+1555', '2026-11-03T00:00:00.000Z');
    expect(await s.deleteDeliveryLogForConversation(T, '+1555')).toBe(1);
    expect(await ids(s, T)).toEqual([near]);
    expect(await ids(s, O)).toEqual([other]);
  });

  it('deleteDeliveryLogForRelay deletes one relay\'s rows in one tenant', async () => {
    const s = S(b);
    const T = `t-relay-${b}`;
    const O = `t-relay-other-${b}`;
    await row(s, T, 'c', '2026-11-03T00:00:00.000Z', 'relay_a');
    const keepB = await row(s, T, 'c', '2026-11-03T00:00:00.000Z', 'relay_b');
    const keepO = await row(s, O, 'c', '2026-11-03T00:00:00.000Z', 'relay_a');
    expect(await s.deleteDeliveryLogForRelay(T, 'relay_a')).toBe(1);
    expect(await ids(s, T)).toEqual([keepB]);
    expect(await ids(s, O)).toEqual([keepO]);
  });
});

describe('the age-out index (sqlite migration)', () => {
  it('messaging_delivery_log has an index on `at`', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const idx = db.prepare(`SELECT name FROM pragma_index_list('messaging_delivery_log')`).all() as Array<{ name: string }>;
    const cols = idx.flatMap((i) => (db.prepare(`SELECT name FROM pragma_index_info(?)`).all(i.name) as Array<{ name: string }>).map((c) => `${i.name}:${c.name}`));
    expect(cols).toContain('idx_messaging_delivery_log_at:at');
  });
});
