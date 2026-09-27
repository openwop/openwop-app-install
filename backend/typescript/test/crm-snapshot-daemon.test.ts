/**
 * CRMGAP-12b — `processDueCrmSnapshots` (features/crm/snapshotDaemon.ts) had
 * NO test at all. Unit-style: fake `deps`/`listCrmTenants`, a real memory
 * storage (the `claimOnce` atomic counter + the CRM entity
 * collections both need it). Covers:
 *   - deterministic `snapshotId` upsert, grouped by stageId in memory
 *     (CRMGAP-7 — one `listDeals` query per pipeline, not per stage)
 *   - the per-(tenant,org,isoWeek) claim slot: the FIRST poll in a week
 *     wins and writes; a later poll in the SAME week is a no-op
 *   - the 104-cap prune (`MAX_SNAPSHOTS_PER_PIPELINE`) across consecutive
 *     weekly polls of the SAME (org,pipeline)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { processDueCrmSnapshots, isoWeek } from '../src/features/crm/snapshotDaemon.js';
import {
  createDeal,
  crmSnapshotId,
  getOrCreateDefaultPipeline,
  listCrmSnapshots,
  __resetCrmEntities,
} from '../src/features/crm/crmEntitiesService.js';

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetCrmEntities();
});
afterEach(() => {
  __resetHostExtPersistence();
});

describe('processDueCrmSnapshots', () => {
  it('writes one deterministic, stage-grouped snapshot per pipeline per org; a second poll in the SAME week is a no-op', async () => {
    const t1 = 'tenant-snap-1';
    const o1 = 'org-snap-1';
    const t2 = 'tenant-snap-2';
    const o2 = 'org-snap-2';

    const p1 = await getOrCreateDefaultPipeline(t1, o1);
    const newStage1 = p1.stages.find((s) => s.name === 'New')!;
    await createDeal({
      tenantId: t1, orgId: o1, title: 'D1', stageId: newStage1.stageId, amount: 100, createdBy: 'test',
      validateCompany: async () => true, validateContact: async () => true,
    });
    await createDeal({
      tenantId: t1, orgId: o1, title: 'D2', stageId: newStage1.stageId, amount: 200, createdBy: 'test',
      validateCompany: async () => true, validateContact: async () => true,
    });

    const p2 = await getOrCreateDefaultPipeline(t2, o2);
    const newStage2 = p2.stages.find((s) => s.name === 'New')!;
    await createDeal({
      tenantId: t2, orgId: o2, title: 'D3', stageId: newStage2.stageId, amount: 50, createdBy: 'test',
      validateCompany: async () => true, validateContact: async () => true,
    });

    const listCrmTenants = async (): Promise<Array<{ tenantId: string; orgId: string }>> => [
      { tenantId: t1, orgId: o1 },
      { tenantId: t2, orgId: o2 },
    ];
    const now = Date.parse('2026-07-06T12:00:00Z'); // a Monday — unambiguous ISO week
    const week = isoWeek(now);

    const written = await processDueCrmSnapshots({ storage }, listCrmTenants, now);
    expect(written).toBe(2); // one pipeline per org

    // Deterministic snapshotId; stage-grouped stats for org1's "New" stage.
    const snap1 = await listCrmSnapshots(t1, o1, p1.pipelineId, 10);
    expect(snap1).toHaveLength(1);
    expect(snap1[0]!.snapshotId).toBe(crmSnapshotId(t1, o1, p1.pipelineId, week));
    expect(snap1[0]!.isoWeek).toBe(week);
    const newEntry1 = snap1[0]!.perStage.find((s) => s.stageId === newStage1.stageId)!;
    expect(newEntry1.count).toBe(2);
    expect(newEntry1.sum).toBe(300);
    expect(newEntry1.weightedSum).toBeCloseTo(300 * (newStage1.probability / 100));
    // Untouched stages still report (count 0, sum 0) — not omitted.
    const wonEntry1 = snap1[0]!.perStage.find((s) => s.name === 'Won')!;
    expect(wonEntry1.count).toBe(0);

    const snap2 = await listCrmSnapshots(t2, o2, p2.pipelineId, 10);
    expect(snap2).toHaveLength(1);
    expect(snap2[0]!.snapshotId).toBe(crmSnapshotId(t2, o2, p2.pipelineId, week));
    const newEntry2 = snap2[0]!.perStage.find((s) => s.stageId === newStage2.stageId)!;
    expect(newEntry2.count).toBe(1);
    expect(newEntry2.sum).toBe(50);

    // Same week, second poll: the claim slot is already taken for BOTH orgs — no-op.
    const writtenAgain = await processDueCrmSnapshots({ storage }, listCrmTenants, now);
    expect(writtenAgain).toBe(0);
    expect(await listCrmSnapshots(t1, o1, p1.pipelineId, 10)).toHaveLength(1); // still exactly one row
  });

  it('the 104-cap prune holds across consecutive weekly polls of the same (org,pipeline)', async () => {
    const tenantId = 'tenant-snap-cap';
    const orgId = 'org-snap-cap';
    const pipeline = await getOrCreateDefaultPipeline(tenantId, orgId);
    const listCrmTenants = async (): Promise<Array<{ tenantId: string; orgId: string }>> => [{ tenantId, orgId }];

    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const base = Date.parse('2024-01-01T12:00:00Z'); // Monday — clean weekly increments
    const POLLS = 110; // > MAX_SNAPSHOTS_PER_PIPELINE (104)
    for (let i = 0; i < POLLS; i++) {
      const written = await processDueCrmSnapshots({ storage }, listCrmTenants, base + i * WEEK_MS);
      expect(written, `poll ${i} should always claim a fresh week and write`).toBe(1);
    }

    const rows = await listCrmSnapshots(tenantId, orgId, pipeline.pipelineId, 1000);
    expect(rows).toHaveLength(104);
    // The surviving rows are the MOST RECENT 104 weeks — oldest pruned.
    const isoWeeks = rows.map((r) => r.isoWeek).sort();
    const expectedOldestSurviving = isoWeek(base + (POLLS - 104) * WEEK_MS);
    expect(isoWeeks[0]).toBe(expectedOldestSurviving);
  });
});
