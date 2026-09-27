/**
 * deleteOrg's refuse-while-populated guard (grade-data RI-7) must count EXACTLY
 * what the full scan counts, now that the database pre-filters (2026-09-26).
 *
 * The guard used to pull every row of every collection into the app (~134k rows
 * on production) and hit the statement timeout, so every org delete 500'd. The
 * fix narrows the scan in the database to rows whose raw JSON contains the org
 * id. An UNDERCOUNT here is the dangerous direction — it lets a populated org be
 * deleted and orphans its data — so every case compares the pre-filtered count
 * with the full scan's answer, on rows built to trip a narrower filter:
 *   - rows in the org, in another org, and in another tenant;
 *   - a validator-REJECTED legacy row that still carries the org (FU-DATA-1:
 *     such rows count, and have no index marker);
 *   - an org id containing LIKE metacharacters (`_`, `%`) — escaping them is an
 *     efficiency property (a wildcard only widens a superset), pinned separately;
 *   - an org id outside the lossless alphabet, which must take the full scan.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';

interface Row { id: string; tenantId: string; orgId?: string; note?: string }

let storage: Storage;
let n = 0;
const coll = (): DurableCollection<Row> =>
  new DurableCollection<Row>(
    `zz-orgdel-${(n += 1)}`,
    (r) => r.id,
    // A validator that rejects `note: 'legacy'` rows, like a tightened schema would.
    (p) => (p && typeof p === 'object' && (p as Row).note !== 'legacy' ? (p as Row) : null),
    (r) => r.tenantId,
  );

/** The pre-fix answer: every row of the collection, filtered exactly in the app. */
async function fullScanCount(c: DurableCollection<Row>, tenantId: string, orgId: string): Promise<number> {
  const prefix = (c as unknown as { prefix(): string }).prefix();
  let count = 0;
  for (const { value } of await storage.kvList(prefix)) {
    const p = JSON.parse(value) as Row;
    if (p.tenantId === tenantId && p.orgId === orgId) count += 1;
  }
  return count;
}

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('org-delete guard — the database pre-filter never undercounts', () => {
  it('counts exactly what the full scan counts, including a validator-rejected row', async () => {
    const c = coll();
    const T = 'tenant-x', O = 'org-a2a3fc26';
    await c.put({ id: 'r1', tenantId: T, orgId: O });
    await c.put({ id: 'r2', tenantId: T, orgId: O });
    await c.put({ id: 'r3', tenantId: T, orgId: 'org-other' });
    await c.put({ id: 'r4', tenantId: 'tenant-y', orgId: O }); // same org id, other tenant
    await c.put({ id: 'r5', tenantId: T }); // no org
    // A legacy row the validator now rejects, written raw (no marker) — it still
    // holds the org's data and MUST count.
    const prefix = (c as unknown as { prefix(): string }).prefix();
    await storage.kvSet(`${prefix}r6`, JSON.stringify({ id: 'r6', tenantId: T, orgId: O, note: 'legacy' }));

    const full = await fullScanCount(c, T, O);
    expect(full, 'non-vacuity: r1, r2 and the legacy r6').toBe(3);
    expect(await c.countRowsFor(T, O)).toBe(full);
  });

  it('an org id with LIKE metacharacters counts exactly (the exact filter decides)', async () => {
    const c = coll();
    const T = 'tenant-x';
    await c.put({ id: 'a', tenantId: T, orgId: 'org_1%' });
    await c.put({ id: 'b', tenantId: T, orgId: 'orgX1abc' }); // what `org_1%` would match as a pattern
    expect(await c.countRowsFor(T, 'org_1%')).toBe(await fullScanCount(c, T, 'org_1%'));
    expect(await c.countRowsFor(T, 'org_1%')).toBe(1);
  });

  it('kvListContaining treats the needle literally (efficiency, not correctness)', async () => {
    // A wildcard needle only WIDENS the superset, so the count above is right with or
    // without escaping — it was a sabotage that proved it. What escaping buys is that
    // the database returns just the literal matches; this pins that property itself.
    const c = coll();
    await c.put({ id: 'a', tenantId: 't', orgId: 'org_1%' });
    await c.put({ id: 'b', tenantId: 't', orgId: 'orgX1abc' });
    const prefix = (c as unknown as { prefix(): string }).prefix();
    const rows = await storage.kvListContaining!(prefix, 'org_1%');
    expect(rows.map((r) => r.key)).toEqual([`${prefix}a`]);
  });

  it('an org id outside the lossless alphabet takes the full scan (and still counts right)', async () => {
    const c = coll();
    const T = 'tenant-x', O = 'org-"quoted"-é';
    await c.put({ id: 'q', tenantId: T, orgId: O });
    expect(await c.countRowsFor(T, O)).toBe(await fullScanCount(c, T, O));
    expect(await c.countRowsFor(T, O)).toBe(1);
  });

  it('the pre-filter is actually used for a plain org id (the fix is not a no-op)', async () => {
    const c = coll();
    await c.put({ id: 'p', tenantId: 't', orgId: 'org-1' });
    let narrowed = 0;
    const orig = storage.kvListContaining!.bind(storage);
    storage.kvListContaining = async (...a) => { narrowed += 1; return orig(...a); };
    await c.countRowsFor('t', 'org-1');
    expect(narrowed).toBe(1);
  });
});
