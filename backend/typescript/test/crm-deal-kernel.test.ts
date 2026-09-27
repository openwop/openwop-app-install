/**
 * ADR 0409 Phase 3 — deals live in the content kernel. Pins: crm.deal is a
 * neverPublic system type, the full Deal round-trips via ext.deal with
 * queryable scalars + top-level orgId, and the legacy→kernel migration is
 * id-preserving + idempotent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createDeal, getDeal, migrateDealsToKernel, type Deal } from '../src/features/crm/entities/deals.js';
import { getEntityType, getSystemEntity, queryEntities } from '../src/features/entities/entitiesService.js';
import { readPublicEntities } from '../src/features/entities/publicRead.js';

const T = 'tenant-deal-kernel';
const ORG = 'org-1';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0409 Phase 3 — crm.deal on the kernel', () => {
  it('crm.deal is neverPublic; a deal round-trips via ext.deal; scalars + orgId queryable; never anonymously served', async () => {
    const d = await createDeal({ tenantId: T, orgId: ORG, title: 'Big Win', amount: 25_000, currency: 'USD', createdBy: 'u1', validateCompany: async () => true, validateContact: async () => true });
    const type = await getEntityType(T, undefined, 'crm.deal');
    expect(type?.system).toBe(true);
    expect(type?.neverPublic).toBe(true);

    const got = await getDeal(T, ORG, d.dealId);
    expect(got).toMatchObject({ title: 'Big Win', amount: 25_000, currency: 'USD', orgId: ORG });

    const rec = await getSystemEntity(T, 'crm.deal', d.dealId);
    expect((rec?.ext?.deal as Deal).title).toBe('Big Win');
    expect(rec?.values.title).toBe('Big Win');
    expect(rec?.values.amount).toBe(25_000);
    expect(rec?.orgId).toBe(ORG); // RI-7 org guard sees it

    // Generic query by org; cross-org get refused (IDOR guard preserved).
    const q = await queryEntities({ tenantId: T, typeName: 'crm.deal', filters: [{ key: 'org_id', op: 'eq', value: ORG }] });
    expect(q.entities.map((e) => e.values.title)).toContain('Big Win');
    expect(await getDeal(T, 'other-org', d.dealId)).toBeNull();

    // Anonymous surface refuses it.
    await expect(readPublicEntities({ tenantId: T, typeName: 'crm.deal', limit: 10 }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('migrates legacy crm:deal rows id-preservingly + idempotently', async () => {
    const legacy = new DurableCollection<Deal>('crm:deal', (d) => d.dealId, undefined, (d) => d.tenantId);
    await legacy.put({
      dealId: 'deal:legacy-1', tenantId: 'tenant-legacy', orgId: 'org-legacy', title: 'Old Deal',
      pipelineId: 'pl-1', stageId: 'st-1', amount: 9_000, currency: 'EUR', customFields: {},
      createdBy: 'u0', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const first = await migrateDealsToKernel();
    expect(first.migrated).toBeGreaterThanOrEqual(1);
    expect((await migrateDealsToKernel()).migrated).toBe(0);
    const got = await getDeal('tenant-legacy', 'org-legacy', 'deal:legacy-1');
    expect(got).toMatchObject({ title: 'Old Deal', amount: 9_000, currency: 'EUR', pipelineId: 'pl-1' });
  });
});
