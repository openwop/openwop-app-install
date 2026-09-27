/**
 * ADR 0693 / ADR 0697 follow-up — a tenant's per-subject usage buckets must die
 * with the tenant.
 *
 * THE DEFECT THIS PINS. `deleteAllTenantData` (ADR 0284) introspects every table
 * carrying a `tenant_id` column and deletes by EXACT match. ADR 0693 phases 1–3
 * put a one-way hash in that column, so tearing down a workspace deleted the rows
 * literally keyed to it and left every participant's row behind — permanently,
 * under a key nobody can enumerate, in a store §4 calls subject-linked personal
 * data. The §4 subject eraser cannot help: it re-derives a bucket from a SUBJECT,
 * and teardown has a tenant.
 *
 * It had no symptom. Orphaned counters are unreadable, nothing errors, and the
 * teardown reports success. So the test has to assert the ABSENCE of rows nobody
 * would have noticed the presence of.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { managedUsageBucket, usageBucketMatchersForTenant } from '../src/providers/managedUsageScope.js';
import { eraseTenantOwnedUsage } from '../src/providers/managedProvider.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';

const WS = 'host-teardown';
const A = 'user:aaaa1111';
const B = 'user:bbbb2222';
const DAY = '2026-09-15';

let storage: Storage;

/** Charge exactly as `prepareManagedDispatch` does: compose, then increment. */
async function charge(tenantId: string, subject: string | undefined, n: number): Promise<void> {
  await storage.incrementManagedUsage(managedUsageBucket(tenantId, subject), 'openwop-free', DAY, n, 0);
}
async function usage(tenantId: string, subject?: string): Promise<number> {
  const u = await storage.getManagedUsage(managedUsageBucket(tenantId, subject), 'openwop-free', DAY);
  return u.inputTokens + u.outputTokens;
}

beforeEach(async () => {
  storage = await openStorage('memory://');
});

describe('ADR 0697 follow-up — teardown reaches the buckets a tenant owns', () => {
  it("THE case: a workspace teardown removes its PARTICIPANTS' rows, not just its own", async () => {
    await charge(WS, A, 100);
    await charge(WS, B, 200);
    await charge(WS, undefined, 50);        // the anonymous/widget row, keyed to the tenant itself

    expect(await usage(WS, A)).toBe(100);
    expect(await usage(WS, B)).toBe(200);

    await eraseTenantOwnedUsage(storage, WS);

    // Before the fix: 100 and 200, surviving a workspace that no longer exists.
    expect(await usage(WS, A), "A's row must die with the workspace").toBe(0);
    expect(await usage(WS, B), "B's row must die with the workspace").toBe(0);
    expect(await usage(WS), 'the tenant-keyed row too').toBe(0);
  });

  it('another tenant is untouched — the sweep is scoped, not a wildcard', async () => {
    const OTHER = 'host-other';
    await charge(WS, A, 100);
    await charge(OTHER, A, 300);

    await eraseTenantOwnedUsage(storage, WS);

    expect(await usage(WS, A)).toBe(0);
    expect(await usage(OTHER, A), "a different workspace's rows must survive").toBe(300);
  });

  it('a LIKE wildcard in a tenant id cannot widen the DELETE', async () => {
    // THE ASSERTION THAT PINS THE `ESCAPE` CLAUSE. `_` matches any single
    // character in SQL LIKE, so an unescaped pattern for `ws:a_b` would also
    // delete `ws:axb` — a different tenant, on a DELETE. No live tenant shape
    // contains `_` or `%`, so this defends against a tenant id minted from user
    // input later rather than against today's data. Without it the escaping is
    // untested and would read as working.
    const TRICKY = 'ws:a_b';
    const SIBLING = 'ws:axb';
    await charge(TRICKY, A, 10);
    await charge(SIBLING, A, 20);

    await eraseTenantOwnedUsage(storage, TRICKY);

    expect(await usage(TRICKY, A)).toBe(0);
    expect(await usage(SIBLING, A), 'an `_` must not match `x`').toBe(20);
  });

  it('the matcher escapes both wildcards, and says which escape char it used', () => {
    const m = usageBucketMatchersForTenant('ws:a_b%c');
    expect(m.exact).toBe('ws:a_b%c');
    expect(m.likePattern).toContain('a\\_b\\%c');
    expect(m.likeEscape).toBe('\\');
  });
});

describe('ADR 0693 §4 — the fix must not weaken pseudonymity', () => {
  it('the bucket still does not reveal the SUBJECT', () => {
    // The tenant now rides in the key in clear, deliberately: a workspace id is
    // not personal data and teardown needs it. The person must remain hidden.
    const bucket = managedUsageBucket(WS, A);
    expect(bucket).not.toContain(A);
    expect(bucket).not.toContain('aaaa1111');
    expect(bucket).toContain(WS);           // and the tenant IS present, on purpose
  });

  it('two subjects in one workspace are still distinct buckets', () => {
    expect(managedUsageBucket(WS, A)).not.toBe(managedUsageBucket(WS, B));
  });

  it('a personal tenant is unchanged — still no reserved bucket at all', () => {
    expect(managedUsageBucket('user:solo', 'user:solo')).toBe('user:solo');
  });
});
