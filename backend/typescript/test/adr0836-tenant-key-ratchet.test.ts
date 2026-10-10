/**
 * ADR 0836 D4 — page ids are per TENANT, and `/v1/content` lets a caller choose
 * one. The system site's ids are predictable (`page:host-site-home`,
 * `page:host-site-docs-*`), so a store keyed by `pageId` alone lets any tenant
 * reach the system site's rows. Measured in prod 2026-10-06: 0 colliding rows —
 * latent, and trivially reachable.
 *
 * Two legs:
 * - the WITNESS: tenant B reuses `page:host-site-home` and publishes past the
 *   50-row history cap. On `origin/main` the cap's delete filtered by `pageId`
 *   only and deleted the system site's history.
 * - the RATCHET: every read and delete exit of the version store and the
 *   schedule-marker stores in `cmsService.ts` is tenant-scoped. A new exit that
 *   is not fails here, before it reaches a review.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { DurableCollection, initHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createPage, listVersions, setScheduledPublish, setScheduledUnpublish, transitionPage, updatePage } from '../src/features/cms/cmsService.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '../src/features/cms/cmsService.ts'), 'utf8');

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0836 D4 — a tenant reusing a system-site page id cannot touch the system site\'s history', () => {
  it('tenant B publishing `page:host-site-home` 55 times leaves host:site\'s history intact', async () => {
    const SYS = 'host:site';
    const SYS_ORG = 'host-site';
    const ID = 'page:host-site-home';
    await createPage({ tenantId: SYS, orgId: SYS_ORG, title: 'Home', pageId: ID, sections: [{ type: 'hero', data: { heading: 'v1' } }], createdBy: 'system' });
    await transitionPage(SYS, SYS_ORG, ID, 'publish', 'system');
    const before = await listVersions(SYS, SYS_ORG, ID);
    expect(before).toHaveLength(1);

    await createPage({ tenantId: 'org:attacker', orgId: 'o-x', title: 'Mine', pageId: ID, sections: [{ type: 'hero', data: { heading: 'x0' } }], createdBy: 'mallory' });
    for (let i = 1; i <= 55; i += 1) {
      await transitionPage('org:attacker', 'o-x', ID, 'publish', 'mallory');
      await transitionPage('org:attacker', 'o-x', ID, 'unpublish', 'mallory');
      await updatePage('org:attacker', 'o-x', ID, { sections: [{ type: 'hero', data: { heading: `x${i}` } }] }, 'mallory');
    }
    const after = await listVersions(SYS, SYS_ORG, ID);
    expect(after.map((v) => [v.versionId, v.origin])).toEqual(before.map((v) => [v.versionId, v.origin]));
    expect((await listVersions('org:attacker', 'o-x', ID)).length).toBe(50); // B's own cap still applies
  }, 60_000);
});

describe('ADR 0836 D4 — tenant teardown ERASES the tenant-keyed rows (reachable by the scanner ⇒ deleted in fact)', () => {
  // Re-keying the schedule markers by tenant made both collections
  // teardown-reachable by KEY, which retired their residual classification
  // (`teardown-reachability-coverage.test.ts`). Reachable on paper is not
  // erased: purge one tenant and look.
  type Marker = { pageId: string; tenantId: string; orgId: string; at: string };
  const pub = new DurableCollection<Marker>('cms:scheduled', (m) => `${encodeURIComponent(m.tenantId)}/${encodeURIComponent(m.pageId)}`);
  const unpub = new DurableCollection<Marker>('cms:scheduled-unpublish', (m) => `${encodeURIComponent(m.tenantId)}/${encodeURIComponent(m.pageId)}`);

  it('a tenant purge deletes that tenant\'s markers and versions, and leaves another tenant\'s', async () => {
    const later = (ms: number): string => new Date(Date.now() + ms).toISOString();
    for (const t of ['org:gone', 'org:stays']) {
      // The same page id in both tenants: the purge must split them by TENANT.
      await createPage({ tenantId: t, orgId: 'o', title: 'P', pageId: 'page:same', sections: [{ type: 'hero', data: { heading: 'h' } }], createdBy: 'u' });
      await transitionPage(t, 'o', 'page:same', 'submit', 'u'); // a version row
      await setScheduledPublish(t, 'o', 'page:same', later(60_000), 'u');
      await setScheduledUnpublish(t, 'o', 'page:same', later(120_000), 'u');
    }
    const count = async (tenantId: string) => ({
      pub: (await pub.list()).filter((m) => m.tenantId === tenantId).length,
      unpub: (await unpub.list()).filter((m) => m.tenantId === tenantId).length,
      versions: (await listVersions(tenantId, 'o', 'page:same')).length,
    });
    expect(await count('org:gone')).toEqual({ pub: 1, unpub: 1, versions: 1 }); // non-vacuous
    await purgeTenantHostExt('org:gone');
    expect(await count('org:gone')).toEqual({ pub: 0, unpub: 0, versions: 0 });
    expect(await count('org:stays')).toEqual({ pub: 1, unpub: 1, versions: 1 });
  });
});

describe('ADR 0836 D4 — ratchet: every version/marker exit in cmsService.ts is tenant-scoped', () => {
  const lines = SRC.split('\n');
  const window = (i: number, n: number): string => lines.slice(i, i + n).join('\n');

  it('every `versions.list()` is filtered on tenantId in the same statement', () => {
    const hits = lines.map((l, i) => (l.includes('versions.list()') ? i : -1)).filter((i) => i >= 0);
    expect(hits.length).toBeGreaterThanOrEqual(5); // a ratchet that matched nothing would pass
    for (const i of hits) expect(window(i, 4), `cmsService.ts:${i + 1}`).toMatch(/tenantId/);
  });

  it('every `versions.get(` is checked against tenantId before use', () => {
    const hits = lines.map((l, i) => (l.includes('versions.get(') ? i : -1)).filter((i) => i >= 0);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const i of hits) expect(window(i, 3), `cmsService.ts:${i + 1}`).toMatch(/tenantId/);
  });

  it('schedule markers are deleted only through the tenant-checked `dropMarker`', () => {
    expect(SRC).not.toMatch(/scheduled(Unpublish)?Markers\.delete\(/);
    const legacyGet = lines.findIndex((l) => l.includes('coll.get(pageId)'));
    expect(legacyGet).toBeGreaterThan(-1);
    expect(window(legacyGet, 2)).toMatch(/legacy\.tenantId === tenantId/);
  });

  it('marker keys are tenant-qualified and never carry a NUL (Postgres TEXT rejects it)', () => {
    expect(SRC).toMatch(/new DurableCollection<ScheduledMarker>\('cms:scheduled', \(m\) => markerKey\(m\.tenantId, m\.pageId\)\)/);
    expect(SRC).toMatch(/new DurableCollection<ScheduledMarker>\('cms:scheduled-unpublish', \(m\) => markerKey\(m\.tenantId, m\.pageId\)\)/);
    expect(/\\u0000/.test(SRC.slice(SRC.indexOf('function markerKey'), SRC.indexOf('function markerKey') + 400))).toBe(false);
  });
});
