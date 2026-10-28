/**
 * ADR 0949 P1a — the engine store becomes the system of record for CMS page
 * experiments, by expand/contract.
 *
 *   1. Assignment is byte-identical: over 100,000 keys and several arm layouts,
 *      the engine's `assignArm` (through `assignVariantForVisitor`) picks exactly
 *      the variant the pre-engine formula picked
 *      (`assignWeightedVariant(key, experimentId, salt, variants)`).
 *   2. The mapping round-trips: PageExperiment → Experiment → PageExperiment.
 *   3. A legacy `cms:pageexperiment` row is migrated on first read of its org and
 *      read from the engine after; after the per-org marker, a page read never
 *      scans a collection (the old hot-path `list()` is gone).
 *   4. Every write is mirrored to the legacy collection (deploy-rollback safety)
 *      and a delete removes both copies.
 *   5. Subject erasure reaches the engine store and the mirror.
 *
 * Sabotage (run 2026-10-20): hashing on a different scope reds 1; dropping the
 * marker write reds 3's scan pin; dropping the mirror write reds 4; erasing
 * only the mirror reds 5; an `orgId` field on the marker reds the org-delete
 * case (found by the wide sweep: `campaign-ops-demo-seed` could not delete its
 * demo orgs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { assignWeightedVariant } from '../src/host/variantAssignment.js';
import { getExperimentRow, listTenantExperimentRows } from '../src/host/experiments/store.js';
import { createPage } from '../src/features/cms/cmsService.js';
import {
  assignVariantForVisitor, createExperiment, deleteExperiment, erasePageExperimentSubject, findRunningExperiment,
  fromEngineExperiment, getExperiment, listExperiments, toEngineExperiment, type PageExperiment,
} from '../src/features/cms/pageExperimentsService.js';

const legacy = new DurableCollection<PageExperiment>('cms:pageexperiment', (e) => e.experimentId);
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});
afterAll(() => { vi.restoreAllMocks(); });

const exp = (over: Partial<PageExperiment> = {}): PageExperiment => ({
  experimentId: `pexp:fixture-${n++}`, tenantId: 't-p1a', orgId: 'o-p1a', pageId: 'pg-1', name: 'Hero', status: 'running',
  salt: `pexp-salt:${n}`, variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId: 'v2', weight: 50 }],
  createdBy: 'u-1', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-02T00:00:00.000Z',
  ...over,
});

describe('ADR 0949 P1a — 1/2. assignment witness and mapping', () => {
  it('assignment is byte-identical over 100,000 keys, for several arm layouts', () => {
    const layouts: PageExperiment['variants'][] = [
      [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId: 'v2', weight: 50 }],
      [{ key: 'a', versionId: 'v1', weight: 20 }, { key: 'b', versionId: 'v2', weight: 30 }, { key: 'c', versionId: null, weight: 50 }],
      [{ key: 'x', versionId: null, weight: 1 }, { key: 'y', versionId: 'v9', weight: 99 }],
    ];
    let checked = 0;
    for (const variants of layouts) {
      const p = exp({ variants });
      for (let i = 0; i < 100_000 / layouts.length + 1; i++) {
        const key = `visitor-${i}`;
        expect(assignVariantForVisitor(p, key)?.key).toBe(assignWeightedVariant(key, p.experimentId, p.salt, p.variants));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(100_000);
  });

  it('PageExperiment → Experiment → PageExperiment round-trips', () => {
    for (const p of [exp(), exp({ status: 'draft', startedAt: undefined }), exp({ status: 'stopped', stoppedAt: '2026-10-03T00:00:00.000Z' })]) {
      const clean = JSON.parse(JSON.stringify(p)) as PageExperiment;
      const e = toEngineExperiment(clean);
      expect(e).toMatchObject({ legacy: true, mode: 'decide', surface: { kind: 'cms.page', ref: 'pg-1' }, salt: clean.salt });
      expect(fromEngineExperiment(e)).toEqual(clean);
    }
  });
});

describe('ADR 0949 P1a — 3/4/5. store of record, migration, mirror, erasure', () => {
  it('a legacy row is migrated on first read, and later page reads never scan', async () => {
    const tenantId = `t-mig-${n++}`;
    const orgId = 'o-mig';
    const old = exp({ tenantId, orgId });
    await legacy.put(old);
    expect(await getExperimentRow(tenantId, orgId, old.experimentId)).toBeNull();
    expect((await getExperiment(tenantId, orgId, 'pg-1', old.experimentId))?.salt).toBe(old.salt);
    expect(await getExperimentRow(tenantId, orgId, old.experimentId)).toMatchObject({ legacy: true, salt: old.salt });
    const scan = vi.spyOn(DurableCollection.prototype, 'list');
    try {
      expect((await findRunningExperiment(tenantId, orgId, 'pg-1'))?.experimentId).toBe(old.experimentId);
      expect(scan).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); }
  });

  it('the migration marker never blocks deleting an emptied org', async () => {
    const tenantId = `t-org-${n++}`;
    const { createOrg, deleteOrg, getOrg } = await import('../src/host/accessControlService.js');
    const orgId = (await createOrg({ tenantId, createdBy: 'x', name: 'Emptied client' })).orgId;
    await listExperiments(tenantId, orgId, 'pg-none'); // writes the per-org marker
    expect((await deleteOrg(orgId)).org).toBe(true);
    expect(await getOrg(orgId)).toBeNull();
  });

  // ADR 0949 P2c contracted the mirror: writes no longer reach the legacy
  // collection (the P1a assertion this case made is inverted here).
  it('writes land in the engine only (P2c: no mirror); a delete removes the row', async () => {
    const tenantId = `t-mir-${n++}`;
    const orgId = 'o-mir';
    const page = await createPage({ tenantId, orgId, title: 'LP', createdBy: 'u-1', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const created = await createExperiment({ tenantId, orgId, pageId: page.pageId, name: 'Hero', variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId: null, weight: 50 }], createdBy: 'u-1' });
    expect(await legacy.get(created.experimentId)).toBeNull();
    expect(fromEngineExperiment(await getExperimentRow(tenantId, orgId, created.experimentId) as NonNullable<Awaited<ReturnType<typeof getExperimentRow>>>)).toEqual(created);
    expect((await listExperiments(tenantId, orgId, page.pageId)).map((e) => e.experimentId)).toEqual([created.experimentId]);
    expect(await deleteExperiment(tenantId, orgId, page.pageId, created.experimentId, 'u-1')).toBe(true);
    expect(await legacy.get(created.experimentId)).toBeNull();
    expect(await getExperimentRow(tenantId, orgId, created.experimentId)).toBeNull();
  });

  it('subject erasure reaches the engine store and any legacy row not yet contracted', async () => {
    const tenantId = `t-era-${n++}`;
    const orgId = 'o-era';
    const page = await createPage({ tenantId, orgId, title: 'LP', createdBy: 'u-gone', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    await createExperiment({ tenantId, orgId, pageId: page.pageId, name: 'Hero', variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId: null, weight: 50 }], createdBy: 'u-gone' });
    const stale = exp({ tenantId, orgId: 'o-era-other', createdBy: 'u-gone' }); // a legacy row the contract has not reached
    await legacy.put(stale);
    expect(await erasePageExperimentSubject(tenantId, new Set(['u-gone']), '[erased]')).toBe(1);
    expect((await listTenantExperimentRows(tenantId))[0]?.createdBy).toBe('[erased]');
    expect((await legacy.get(stale.experimentId))?.createdBy).toBe('[erased]');
  });
});
