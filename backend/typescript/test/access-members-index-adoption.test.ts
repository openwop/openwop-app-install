/**
 * ADR 0866 — `access-members` reads through its tenant index once a reconcile
 * has verified it, and a MISS from the index is never authoritative.
 *
 * Every authorization resolver here used to full-scan the member rows of every
 * tenant. Once the index is verified they read one tenant's slice. A row the
 * index lacks (a marker lost to a failed write, or an old revision's write before
 * the next reconcile) must still be found, because absence here denies, grants
 * the self-approval exemption, or (demo mode, single-principal tenant) grants
 * OWNER through the bypass. `dropMarker` makes that row: the primary row stays,
 * its index marker goes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { reconcileTenantIndexesOnce } from '../src/host/tenantIndexAdoption.js';
import {
  createMember,
  hasDistinctScopeHolder,
  listMembers,
  resolveEffectiveAccess,
  resolveSubjectScopesUnion,
} from '../src/host/accessControlService.js';
import type { Storage } from '../src/storage/storage.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-10T00:00:00Z');
const SCAN_PREFIX = 'hostext:access-members:';
const PRIOR_DEMO = process.env.OPENWOP_DEMO_MODE;

let storage: Storage;
beforeAll(() => { process.env.OPENWOP_DEMO_MODE = 'true'; }); // the bypass a miss could reach
afterAll(() => {
  if (PRIOR_DEMO === undefined) delete process.env.OPENWOP_DEMO_MODE;
  else process.env.OPENWOP_DEMO_MODE = PRIOR_DEMO;
});
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

/** Verify the index, then run the one-time backfill (any indexed read). Without
 *  that warm read, the first indexed read AFTER `dropMarker` backfills the marker
 *  back and every miss case below passes vacuously (measured: it did). */
async function verifyIndex(tenantId: string): Promise<void> {
  await reconcileTenantIndexesOnce(storage, T0);
  await reconcileTenantIndexesOnce(storage, T0 + 180 * MIN);
  await listMembers(tenantId, tenantId);
}
const dropMarker = (tenantId: string, memberId: string) => storage.kvDelete(`hostextidx:access-members:${tenantId}:${memberId}`);
function countScans(): () => number {
  const spy = vi.spyOn(storage, 'kvList');
  return () => spy.mock.calls.filter(([prefix]) => prefix === SCAN_PREFIX).length;
}

describe('ADR 0866 — access-members index adoption', () => {
  it('resolves a member from the index once verified, with no full scan', async () => {
    const t = 'ws:aidx-hit';
    await createMember({ tenantId: t, orgId: t, displayName: 'Ann', subject: 'user:ann', roles: ['admin'] });

    let scans = countScans();
    expect((await resolveEffectiveAccess(t, { subject: 'user:ann' })).roles).toEqual(['admin']);
    expect(scans(), 'before verification the resolver scans').toBeGreaterThan(0);
    vi.restoreAllMocks();

    await verifyIndex(t); // also warms the one-time backfill (one scan per database, not per request)
    scans = countScans();
    expect((await resolveEffectiveAccess(t, { subject: 'user:ann' })).roles).toEqual(['admin']);
    expect((await resolveSubjectScopesUnion(t, 'user:ann')).scopes).toContain('host:byok:manage');
    expect((await listMembers(t, t)).map((m) => m.subject)).toEqual(['user:ann']);
    expect(scans(), 'a found member costs no cross-tenant scan').toBe(0);
    vi.restoreAllMocks();
  });

  it('a member the index misses resolves to its REAL roles, not the demo owner bypass', async () => {
    const t = 'user:aidx-miss'; // single-principal: an absent member would resolve as owner
    const m = await createMember({ tenantId: t, orgId: t, displayName: 'Vic', subject: 'user:vic', roles: ['viewer'] });
    await verifyIndex(t);
    await dropMarker(t, m.memberId);

    const access = await resolveEffectiveAccess(t, { subject: 'user:vic' });
    expect(access.basis).toBe('member');
    expect(access.roles).toEqual(['viewer']);
    expect(access.scopes).not.toContain('host:org:manage');
    expect((await resolveSubjectScopesUnion(t, 'user:vic')).basis).toBe('member');
  });

  it('an approver the index misses still counts as a distinct holder (no self-approval exemption)', async () => {
    const t = 'ws:aidx-approver';
    await createMember({ tenantId: t, orgId: t, displayName: 'Me', subject: 'user:me', roles: ['admin'] });
    const other = await createMember({ tenantId: t, orgId: t, displayName: 'Other', subject: 'user:other', roles: ['admin'] });
    await verifyIndex(t);
    await dropMarker(t, other.memberId);

    expect(await hasDistinctScopeHolder(t, 'host:byok:manage', 'user:me')).toBe(true);
  });

  it('a non-member still fails closed after verification', async () => {
    const t = 'ws:aidx-none';
    await createMember({ tenantId: t, orgId: t, displayName: 'Ann', subject: 'user:ann', roles: ['admin'] });
    await verifyIndex(t);
    expect(await resolveEffectiveAccess(t, { subject: 'user:stranger' })).toMatchObject({ roles: [], basis: 'none' });
    expect(await hasDistinctScopeHolder(t, 'host:byok:manage', 'user:ann')).toBe(false);
  });
});
