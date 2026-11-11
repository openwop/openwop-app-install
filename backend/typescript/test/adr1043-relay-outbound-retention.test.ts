/**
 * ADR 1043 CHAN-F12 — undelivered relay egress ages out at the device token's
 * lifetime (30 days), on BOTH storage backends (sqlite, and postgres through
 * pg-mem as in `relay-delivery-log-storage.test.ts`).
 *
 *  (a) `pruneRelayOutbound` deletes egress enqueued before the cutoff and keeps
 *      newer egress; it keeps every row whose device belongs to an excepted
 *      (legal-hold) tenant; a row whose device is gone is deleted and reported
 *      with no tenant; it returns exactly what it deleted.
 *  (b) `sweepExpiredRelayOutbound` uses the token lifetime as its window, skips a
 *      held tenant, logs each expired egress `failed` in that tenant's delivery
 *      log, and clears its attempt counter.
 *  (c) the routes mint device tokens with the same constant the sweep uses.
 * Boot registration is asserted in `adr1043-relay-delivery-log-lifecycle.test.ts`
 * case (g), on the real booted app.
 *
 * Red when: either backend flips the cutoff, drops or inverts the hold exclusion,
 * stops deleting orphaned rows, or misreports what it deleted; the sweep window
 * stops being the token lifetime; the sweep skips the log or the attempt clear.
 * Sabotage-witnessed 2026-11-10, one edit at a time, each red on its own case: the
 * cutoff flipped (postgres; sqlite), the hold exclusion inverted (postgres `NOT IN` →
 * `IN`; sqlite `NOT EXISTS` → `EXISTS`), a doubled window, the attempt clear dropped,
 * and (in the lifecycle file, case g) the boot registration removed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { pgMemAdapters } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { newDb } = require('pg-mem') as typeof import('pg-mem');
  return { pgMemAdapters: newDb().adapters.createPg() };
});
vi.mock('pg', () => ({ default: pgMemAdapters, ...pgMemAdapters }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import type { Storage } from '../src/storage/storage.js';
import { RELAY_DEVICE_TOKEN_TTL_MS, sweepExpiredRelayOutbound } from '../src/messaging/outboundRetention.js';
import { egressAttempts, recordEgressAttempt } from '../src/messaging/relayLifecycle.js';
import { RETENTION_HOLD_KV_PREFIX } from '../src/host/retentionHold.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';

const DAY = 24 * 60 * 60 * 1000;
const backends = ['sqlite', 'postgres'] as const;
const storages = new Map<string, Storage>();

beforeAll(async () => {
  storages.set('sqlite', await openSqliteStorage(':memory:'));
  storages.set('postgres', await openPostgresStorage('postgres://test/test'));
  // The attempt counter is a host-ext collection; back it with the sqlite storage
  // the sweep is handed, so (b) reads one store.
  initHostExtPersistence(storages.get('sqlite')!);
});
afterAll(async () => { __resetHostExtPersistence(); for (const s of storages.values()) await s.close().catch(() => undefined); });

const S = (b: string): Storage => storages.get(b)!;
let seq = 0;
async function device(s: Storage, tenantId: string): Promise<string> {
  const relayId = `relay_or_${++seq}`;
  await s.upsertRelayDevice({ relayId, tenantId, channel: 'whatsapp', status: 'active', registeredAt: '2026-01-01T00:00:00.000Z' });
  return relayId;
}
async function egress(s: Storage, relayId: string, enqueuedAt: string): Promise<string> {
  const egressId = `egr_or_${++seq}`;
  await s.enqueueRelayOutbound({ egressId, relayId, channel: 'whatsapp', conversationId: '+15550009999', text: 'hello', enqueuedAt });
  return egressId;
}
const queued = async (s: Storage, relayId: string): Promise<string[]> => (await s.listRelayOutbound(relayId, 1000)).map((e) => e.egressId).sort();

describe.each(backends)('(a) pruneRelayOutbound (%s)', (b) => {
  it('deletes egress before the cutoff, keeps newer and held-tenant egress, and deletes orphans', async () => {
    const s = S(b);
    const T = `t-or-${b}`;
    const H = `t-or-held-${b}`;
    const mine = await device(s, T);
    const held = await device(s, H);
    const orphanRelay = `relay_or_gone_${b}`; // no device row
    const old = await egress(s, mine, '2026-09-01T00:00:00.000Z');
    const fresh = await egress(s, mine, '2026-11-05T00:00:00.000Z');
    const heldOld = await egress(s, held, '2026-09-01T00:00:00.000Z');
    const orphan = await egress(s, orphanRelay, '2026-09-01T00:00:00.000Z');

    const gone = await s.pruneRelayOutbound('2026-10-01T00:00:00.000Z', [H, 'unrelated-tenant']);
    expect([...gone].sort((x, y) => x.egressId.localeCompare(y.egressId))).toEqual([
      { egressId: old, relayId: mine, channel: 'whatsapp', tenantId: T },
      { egressId: orphan, relayId: orphanRelay, channel: 'whatsapp' },
    ].sort((x, y) => x.egressId.localeCompare(y.egressId)));
    expect(await queued(s, mine)).toEqual([fresh]);
    expect(await queued(s, held)).toEqual([heldOld]);
    expect(await queued(s, orphanRelay)).toEqual([]);

    // Without the exception the held tenant's old egress goes too; nothing else matches.
    expect((await s.pruneRelayOutbound('2026-10-01T00:00:00.000Z', [])).map((g) => g.egressId)).toEqual([heldOld]);
    expect(await queued(s, held)).toEqual([]);
  });
});

describe('(b) sweepExpiredRelayOutbound', () => {
  it('ages out at the token lifetime, skips a held tenant, logs the expiry and clears attempts', async () => {
    const s = S('sqlite');
    const NOW = Date.parse('2026-11-10T12:00:00.000Z');
    const T = 'tenant:or-sweep';
    const H = 'tenant:or-sweep-held';
    const mine = await device(s, T);
    const held = await device(s, H);
    const at = (ageMs: number) => new Date(NOW - ageMs).toISOString();
    const expired = await egress(s, mine, at(RELAY_DEVICE_TOKEN_TTL_MS + 60_000));
    const justInside = await egress(s, mine, at(RELAY_DEVICE_TOKEN_TTL_MS - 60_000));
    const heldExpired = await egress(s, held, at(RELAY_DEVICE_TOKEN_TTL_MS + DAY));
    await recordEgressAttempt(expired, mine, T, 'transient');
    expect(await egressAttempts(expired)).toBe(1);

    // The sweep reads holds from the storage it is handed (listHeldTenantsFrom).
    await s.kvSet(`${RETENTION_HOLD_KV_PREFIX}${H}`, JSON.stringify({ tenantId: H, reason: 'litigation', createdAt: '2026-11-01T00:00:00.000Z' }));
    try {
      expect(await sweepExpiredRelayOutbound(NOW, s)).toEqual({ deleted: 1 });
    } finally {
      await s.kvDelete(`${RETENTION_HOLD_KV_PREFIX}${H}`);
    }
    expect(await queued(s, mine)).toEqual([justInside]);
    expect(await queued(s, held)).toEqual([heldExpired]);
    expect(await egressAttempts(expired)).toBe(0);
    const logs = await s.listDeliveryLog({ tenantId: T, limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ relayId: mine, direction: 'outbound', status: 'failed', conversationId: '' });
    expect(logs[0]!.detail).toBe(`egress ${expired}: expired (undelivered past the device token lifetime)`);
    expect(await s.listDeliveryLog({ tenantId: H, limit: 10 })).toEqual([]);
  });
});

describe('(c) one constant', () => {
  it('the routes mint device tokens with the lifetime the sweep ages out at', () => {
    expect(RELAY_DEVICE_TOKEN_TTL_MS).toBe(30 * DAY);
    const routes = readFileSync(join(__dirname, '..', 'src', 'routes', 'messaging.ts'), 'utf8');
    expect(routes).toMatch(/const DEVICE_TOKEN_TTL_MS = RELAY_DEVICE_TOKEN_TTL_MS;/);
  });
});
