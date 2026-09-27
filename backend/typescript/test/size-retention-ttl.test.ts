/**
 * ADR 0380 — size-retention TTL hygiene:
 *  - `idempotencyTtlDays()` env resolution (default ON at 7; 0 disables; garbage → 7).
 *  - The global idempotency prune ('' prefix) deletes only rows past the cutoff
 *    (both adapters share the LIKE+created_at implementation; exercised on sqlite).
 *  - The kv age-out seam: deletes rows older than the TTL by their registered
 *    timestamp field, SKIPS unparseable / missing-timestamp rows (never delete on
 *    a guess), and is fail-open per store (one throwing store never stops the rest).
 *  - `deleteOrphanAgentRunActivity` (app-migration v3's engine): deletes exactly
 *    the attribution rows whose run is gone; idempotent on re-run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { idempotencyTtlDays } from '../src/host/retentionSweepDaemon.js';
import { registerKvAgeOut, __clearKvAgeOutForTest, __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';

const DAY = 86_400_000;
const NOW = new Date('2026-07-16T12:00:00.000Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
});
afterEach(async () => {
  __clearKvAgeOutForTest();
  delete process.env.OPENWOP_IDEMPOTENCY_TTL_DAYS;
  await storage.close();
});

describe('idempotencyTtlDays (ADR 0380 §1)', () => {
  it('defaults ON at 7 days', () => {
    expect(idempotencyTtlDays()).toBe(7);
  });
  it('honors an explicit value and 0-disables', () => {
    process.env.OPENWOP_IDEMPOTENCY_TTL_DAYS = '30';
    expect(idempotencyTtlDays()).toBe(30);
    process.env.OPENWOP_IDEMPOTENCY_TTL_DAYS = '0';
    expect(idempotencyTtlDays()).toBe(0);
  });
  it('falls back to the default on garbage', () => {
    process.env.OPENWOP_IDEMPOTENCY_TTL_DAYS = 'nope';
    expect(idempotencyTtlDays()).toBe(7);
    process.env.OPENWOP_IDEMPOTENCY_TTL_DAYS = '-3';
    expect(idempotencyTtlDays()).toBe(7);
  });
});

describe('global idempotency prune (empty prefix)', () => {
  it('deletes only rows older than the cutoff, across ALL key shapes', async () => {
    await storage.claimOnce('http:old-key', iso(10));
    await storage.claimOnce('retention-sweep:old-claim', iso(10));
    await storage.claimOnce('http:fresh-key', iso(1));

    const deleted = await storage.pruneOnceByPrefix('', iso(7));
    expect(deleted).toBe(2);

    // The fresh row survives (a re-claim is NOT granted) …
    expect((await storage.claimOnce('http:fresh-key', iso(0))).claimed).toBe(false);
    // … while the aged rows are re-claimable (gone).
    expect((await storage.claimOnce('http:old-key', iso(0))).claimed).toBe(true);
  });
});

describe('kv age-out seam (ADR 0380 §3)', () => {
  it('deletes past-TTL rows by the registered timestamp field and skips unparseable rows', async () => {
    registerKvAgeOut({ id: 'test:ledger', prefix: 'hostext:test-ledger:', ttlDays: 30, timestampField: 'processedAt' });
    await storage.kvSet('hostext:test-ledger:old', JSON.stringify({ processedAt: iso(45) }));
    await storage.kvSet('hostext:test-ledger:fresh', JSON.stringify({ processedAt: iso(5) }));
    await storage.kvSet('hostext:test-ledger:no-field', JSON.stringify({ other: iso(45) }));
    await storage.kvSet('hostext:test-ledger:not-json', 'evt-not-json');
    await storage.kvSet('hostext:other:old', JSON.stringify({ processedAt: iso(45) })); // outside the prefix

    await __runKvAgeOutOnce(storage, NOW);

    const remaining = (await storage.kvList('hostext:test-ledger:')).map((r) => r.key).sort();
    // Only the aged, well-formed row is deleted; skip-on-a-guess for the rest.
    expect(remaining).toEqual([
      'hostext:test-ledger:fresh',
      'hostext:test-ledger:no-field',
      'hostext:test-ledger:not-json',
    ]);
    expect(await storage.kvGet('hostext:other:old')).not.toBeNull();
  });

  it('is fail-open per store: a throwing store never stops the others', async () => {
    registerKvAgeOut({ id: 'test:boom', prefix: 'hostext:boom:', ttlDays: 1, timestampField: 'at' });
    registerKvAgeOut({ id: 'test:ok', prefix: 'hostext:ok:', ttlDays: 1, timestampField: 'at' });
    await storage.kvSet('hostext:ok:old', JSON.stringify({ at: iso(3) }));

    const wrapped: Storage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'kvList') {
          return (prefix: string) => {
            if (prefix === 'hostext:boom:') throw new Error('store down');
            return target.kvList(prefix);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // CONS-13 — the sweep used to return `void`, so "it did not throw" was the
    // only thing a caller could observe. It now reports per-store counters, and
    // a store that THREW is reported with its error rather than vanishing into
    // a warn line — which is what made a mis-prefixed registration invisible.
    const out = await __runKvAgeOutOnce(wrapped, NOW);
    const byId = new Map(out.map((r) => [r.id, r]));
    expect(byId.get('test:boom')?.error, 'the throwing store is REPORTED, not silently skipped').toBeTruthy();
    expect(byId.get('test:ok')?.deleted).toBe(1);
    expect(await storage.kvGet('hostext:ok:old')).toBeNull(); // the healthy store still swept
  });

  it('rejects a non-positive ttl at registration', () => {
    expect(() => registerKvAgeOut({ id: 'x', prefix: 'hostext:x:', ttlDays: 0, timestampField: 'at' })).toThrow();
  });
});

describe('deleteOrphanAgentRunActivity (ADR 0380 §2 / app-migration v3)', () => {
  it('deletes exactly the rows whose run is gone; idempotent on re-run', async () => {
    const live: RunRecord = {
      runId: 'run-live', workflowId: 'wf-1', tenantId: 't-1', status: 'completed',
      inputs: {}, metadata: {}, configurable: {},
      createdAt: iso(2), updatedAt: iso(1),
    };
    await storage.insertRun(live);
    await storage.recordAgentRunAttribution({ runId: 'run-live', tenantId: 't-1', rosterId: 'r-1', source: 'heartbeat', createdAt: iso(2) });
    // The pre-cascade residue: an attribution whose run was swept.
    await storage.recordAgentRunAttribution({ runId: 'run-gone', tenantId: 't-1', rosterId: 'r-1', source: 'heartbeat', createdAt: iso(40) });

    expect(await storage.deleteOrphanAgentRunActivity()).toBe(1);
    expect(await storage.deleteOrphanAgentRunActivity()).toBe(0); // idempotent

    // The live attribution still resolves through the index join.
    const rows = await storage.listAgentRunActivity({ tenantId: 't-1' });
    expect(rows.map((r) => r.runId)).toEqual(['run-live']);
  });
});
