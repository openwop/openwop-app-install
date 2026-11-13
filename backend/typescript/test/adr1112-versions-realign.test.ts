/**
 * ADR 1112 data residue (2026-11-13): page history read through the tenant index, and the
 * stale-overlay repair.
 *
 * Pins:
 *  - a page's history is the same through the full scan and through the verified tenant
 *    index, another tenant's same-id page never shows in it, and once the index is verified
 *    a publish never scans the whole version collection (DG-1112-11);
 *  - the 50-snapshot cap still holds through the index (DG-1112-8: the cap already existed),
 *    and a marker left without its row is never listed and never evicts a real snapshot;
 *  - a stored scheduleSim translation whose behaviour keys differ from its base is counted
 *    by `report`, repaired by `apply` (words and source digest kept, version kept), and a
 *    second pass finds nothing (DG-1112-6 / RI-1112-1);
 *  - the background job does nothing until OPENWOP_CMS_OVERLAY_REALIGN is set.
 *
 * Sabotage, each restored, each red: drop the pageId filter in `pageVersionMetas`; read
 * `versions.list()` in `pageVersionMetas` whatever the index says; cap on the projections
 * instead of the rows; skip the CAS in `apply`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { BACKGROUND_APP_JOBS } from '../src/host/appMigrations.js';
import { createPage, getPage, listVersions, migratePagesToKernel, realignPageOverlays, realignStoredOverlays, transitionPage, updatePage, type Page } from '../src/features/cms/cmsService.js';

type Raw = Record<string, unknown>;
const ORG = 'org-v';
const text = (html: string) => [{ sectionId: 'sec:t', type: 'richText', data: { html } }];

/** Verify the version collection's tenant index the way the hourly reconcile does. */
async function verifyVersionIndex(): Promise<void> {
  const handle = new DurableCollection<{ versionId: string; tenantId: string }>('cms:pageversion', (v) => v.versionId, undefined, (v) => v.tenantId);
  await handle.reconcileTenantIndex({ windowMs: 0, now: Date.now() - 1 });
  await handle.reconcileTenantIndex({ windowMs: 0, now: Date.now() });
  expect(await handle.tenantIndexVerified()).toBe(true);
}

async function publishEdits(tenantId: string, pageId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    if ((await getPage(tenantId, ORG, pageId))?.status === 'published') await transitionPage(tenantId, ORG, pageId, 'unpublish', 'u-admin');
    await updatePage(tenantId, ORG, pageId, { sections: text(`<p>Edit ${i}</p>`) }, 'u-author');
    await transitionPage(tenantId, ORG, pageId, 'publish', 'u-admin');
  }
}

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.OPENWOP_CMS_OVERLAY_REALIGN; });

describe('DG-1112-11 — page history through the tenant index', () => {
  it('is the same through the scan and the index, per tenant, and the cap still holds', async () => {
    const a = await createPage({ tenantId: 'tv-a', orgId: ORG, title: 'History', sections: text('<p>v0</p>'), createdBy: 'u-author' });
    const b = await createPage({ tenantId: 'tv-b', orgId: ORG, title: 'Other', sections: text('<p>v0</p>'), createdBy: 'u-author' });
    await publishEdits('tv-a', a.pageId, 3);
    const a2 = await createPage({ tenantId: 'tv-a', orgId: ORG, title: 'Sibling', sections: text('<p>v0</p>'), createdBy: 'u-author' });
    await publishEdits('tv-b', b.pageId, 1);
    await publishEdits('tv-a', a2.pageId, 1);
    const scanned = (await listVersions('tv-a', ORG, a.pageId)).map((v) => v.versionId);
    expect(scanned).toHaveLength(3);

    await verifyVersionIndex();
    expect((await listVersions('tv-a', ORG, a.pageId)).map((v) => v.versionId)).toEqual(scanned);
    expect((await listVersions('tv-b', ORG, b.pageId)).every((v) => v.tenantId === 'tv-b')).toBe(true);
    expect((await listVersions('tv-a', ORG, a2.pageId)).map((v) => v.pageId)).toEqual([a2.pageId]);

    const list = vi.spyOn(DurableCollection.prototype, 'list');
    await publishEdits('tv-a', a.pageId, 1);
    const versionScans = list.mock.contexts.filter((c) => (c as { name?: string }).name === 'cms:pageversion');
    expect(versionScans).toHaveLength(0);
    list.mockRestore();

    await publishEdits('tv-a', a.pageId, 48); // 52 publishes in all
    expect(await listVersions('tv-a', ORG, a.pageId)).toHaveLength(50);

    // A marker with no row (a crash between `put`'s marker and row writes), newest of all:
    // it is never listed, and it never pushes a real snapshot out of the 50.
    const p = { versionId: 'pver:phantom', tenantId: 'tv-a', orgId: ORG, pageId: a.pageId, version: 999, origin: 'publish', publishedAt: '2999-01-01T00:00:00.000Z', seq: 0, baseline: false };
    await storage.kvSet(`hostextidx:cms:pageversion:tv-a:pver:phantom`, JSON.stringify({ id: 'pver:phantom', p }));
    await publishEdits('tv-a', a.pageId, 1);
    const kept = await listVersions('tv-a', ORG, a.pageId);
    expect(kept).toHaveLength(50);
    expect(kept.some((v) => v.versionId === 'pver:phantom')).toBe(false);
  }, 60_000);
});

const milestones = [{ id: 'm1', label: 'Design lock', startWeek: 0, weeks: 4, floatDays: 0 }];
const base = { startDate: '2027-01-04', milestones, decisions: [{ id: 'a', title: 'Tile', milestone: 'm1', lockWeek: 2 }] };
/** Stored before alignment: the Spanish decision carries its own lock week. */
const staleEs = { milestones: [{ ...milestones[0], label: 'Cierre de diseño' }], decisions: [{ id: 'a', title: 'Azulejo', milestone: 'm1', lockWeek: 7 }] };

async function storeStalePage(tenantId: string, pageId: string): Promise<void> {
  const legacy = new DurableCollection<Page>('cms:page', (p) => p.pageId);
  await legacy.put({
    pageId, tenantId, orgId: ORG, title: pageId, slug: pageId, status: 'published', version: 3,
    sections: [{ sectionId: 'sec:s', type: 'scheduleSim', data: base, localizations: { es: staleEs }, sourceDigest: { es: '0123456789abcdef' } }],
    createdBy: 'u-author', updatedBy: 'u-author', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  });
  await migratePagesToKernel();
  // The kernel stores validated output, which now aligns the overlay, so put the
  // pre-alignment lock week back on the stored row itself.
  for (const row of await storage.kvList('hostext:entity:record:')) {
    const rec = JSON.parse(row.value) as { tenantId?: string; ext?: { blocks?: Array<{ sourceDigest?: Raw; localizations?: { es?: { decisions?: Raw[] } } }> } };
    const block = rec.tenantId === tenantId ? rec.ext?.blocks?.[0] : undefined;
    const dec = block?.localizations?.es?.decisions?.[0];
    if (!block || !dec || !row.value.includes(`"${pageId}"`)) continue;
    dec.lockWeek = 7;
    block.sourceDigest = { es: '0123456789abcdef' };
    await storage.kvSet(row.key, JSON.stringify(rec));
  }
}

describe('DG-1112-6 / RI-1112-1 — the stale-overlay repair', () => {
  it('reports, then repairs, then finds nothing', async () => {
    await storeStalePage('tr-a', 'page-stale');
    const before = await getPage('tr-a', ORG, 'page-stale');
    expect(realignPageOverlays(before as Page)).not.toBeNull(); // the gauge's test sees it
    expect(before?.sections[0]?.sourceDigest).toEqual({ es: '0123456789abcdef' });

    const report = await realignStoredOverlays('report');
    expect(report).toMatchObject({ stalePages: 1, staleOverlays: 1, realigned: 0 });
    expect(await getPage('tr-a', ORG, 'page-stale')).toEqual(before);

    const applied = await realignStoredOverlays('apply');
    expect(applied).toMatchObject({ stalePages: 1, realigned: 1, conflicts: 0, invalid: 0 });
    const after = await getPage('tr-a', ORG, 'page-stale');
    const es = after?.sections[0]?.localizations?.es as Raw;
    expect((es.decisions as Raw[])[0]).toMatchObject({ title: 'Azulejo', lockWeek: 2 });
    expect(after?.sections[0]?.sourceDigest).toEqual({ es: '0123456789abcdef' });
    expect(after?.version).toBe(3);
    expect(after?.updatedBy).toBe('u-author');

    expect(await realignStoredOverlays('apply')).toMatchObject({ stalePages: 0, realigned: 0 });
  });

  it('the background job is off until the env says report or apply', async () => {
    const job = BACKGROUND_APP_JOBS.find((j) => j.id === 'cms-overlay-realign');
    expect(job).toBeDefined();
    await storeStalePage('tr-b', 'page-stale-b');
    expect(await job?.run(storage)).toEqual({ complete: false });
    expect(realignPageOverlays((await getPage('tr-b', ORG, 'page-stale-b')) as Page)).not.toBeNull();
    process.env.OPENWOP_CMS_OVERLAY_REALIGN = 'report';
    expect(await job?.run(storage)).toEqual({ complete: false });
    process.env.OPENWOP_CMS_OVERLAY_REALIGN = 'apply';
    expect(await job?.run(storage)).toEqual({ complete: true });
    expect(realignPageOverlays((await getPage('tr-b', ORG, 'page-stale-b')) as Page)).toBeNull();
  });
});
