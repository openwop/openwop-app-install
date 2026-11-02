/**
 * The anon-teardown sweeper decides whether to DESTROY a tenant with a plain
 * string comparison:
 *
 *   retentionSweepDaemon.ts:269   t.lastHostExtAt < cutoffIso
 *
 * That is only chronological while BOTH sides are fixed-width ISO-8601 UTC.
 * Today they are (`new Date().toISOString()` on every writer, on both
 * adapters), so this pins the invariant rather than fixing a bug.
 *
 * It is worth pinning because the same class already shipped ONCE in the very
 * same function: the chat cross-check at postgres/index.ts:562 carries a
 * `to_char(... '"T"' ...)` and a comment explaining that pg's bare `::text`
 * render is `'YYYY-MM-DD hh:mm:ss+00'`, whose SPACE at position 10 sorts below
 * `'T'` — so a same-day touch read as stale. One column in this query was
 * format-sensitive and nobody noticed until it bit.
 *
 * The two existing assertions on this field are `typeof === 'string'`
 * (anon-tenant-lifecycle:135, storage-hostext-activity-live:69), which cannot
 * catch it: `''` and `'2026-07-28 02:22:25+00'` are both strings. This asserts
 * the SHAPE and the ORDERING PROPERTY the sweeper actually depends on.
 *
 * The cutoff case is SAME-DAY on purpose: a SPACE-for-`T` render only misorders values
 * that share a date (a 14-day cutoff differs earlier in the string and could not see
 * it). Only `Date` is faked; the writes are stamped by the adapter's own clock read.
 *
 * Tracker TST-DFD-3. Red when (w71g1, witnessed): the adapter stamps `updated_at` in any
 * render other than `toISOString()` (both the shape case and the same-day cutoff case).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';

/** Exactly what `Date.prototype.toISOString` emits — fixed width, ms, UTC `Z`. */
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
});
afterEach(() => { vi.useRealTimers(); });

describe('hostext activity — the shape the teardown comparison relies on', () => {
  it('returns lastHostExtAt as fixed-width ISO-8601 UTC, not merely a string', async () => {
    await storage.kvSet('hostext:t1', JSON.stringify({ tenantId: 'anon:probe-1', x: 1 }));

    const rows = await storage.listHostExtTenantActivity('anon:', 100);
    const row = rows.find((r) => r.tenantId === 'anon:probe-1');
    expect(row).toBeDefined();

    // The assertion the existing `typeof === 'string'` checks cannot make.
    // A pg `::text` render ('YYYY-MM-DD hh:mm:ss+00') and '' both pass typeof.
    expect(row!.lastHostExtAt).toMatch(STRICT_ISO);
  });

  it('a JUST-WRITTEN tenant does not compare as older than a 14-day cutoff', async () => {
    // Written at noon; the sweeper's comparison is checked against a 14-day cutoff AND a
    // same-day cutoff one hour earlier — the one a non-ISO render gets wrong.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
    await storage.kvSet('hostext:t2', JSON.stringify({ tenantId: 'anon:probe-2', x: 1 }));

    const rows = await storage.listHostExtTenantActivity('anon:', 100);
    const row = rows.find((r) => r.tenantId === 'anon:probe-2');
    expect(row).toBeDefined();

    // The sweeper's own predicate, verbatim. This is the property that decides
    // whether a live tenant is torn down — assert it directly rather than
    // trusting that the format implies it.
    const cutoffIso = new Date(Date.now() - 14 * 86_400_000).toISOString();
    expect(row!.lastHostExtAt < cutoffIso).toBe(false);
    const sameDayCutoff = '2026-07-28T11:00:00.000Z';
    expect(row!.lastHostExtAt < sameDayCutoff, `${row!.lastHostExtAt} vs ${sameDayCutoff}`).toBe(false);
  });

  it('orders lexicographically the same way it orders chronologically', async () => {
    // Two writes one second apart (faked Date), so the string compare and the clock must agree.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-28T09:59:59.500Z'));
    await storage.kvSet('hostext:a', JSON.stringify({ tenantId: 'anon:older', x: 1 }));
    vi.setSystemTime(new Date('2026-07-28T10:00:00.500Z'));
    await storage.kvSet('hostext:b', JSON.stringify({ tenantId: 'anon:newer', x: 1 }));

    const rows = await storage.listHostExtTenantActivity('anon:', 100);
    const older = rows.find((r) => r.tenantId === 'anon:older')!;
    const newer = rows.find((r) => r.tenantId === 'anon:newer')!;
    expect(older).toBeDefined();
    expect(newer).toBeDefined();

    expect(older.lastHostExtAt < newer.lastHostExtAt).toBe(true);
    expect(Date.parse(older.lastHostExtAt)).toBeLessThan(Date.parse(newer.lastHostExtAt));
  });
});
