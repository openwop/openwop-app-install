/**
 * ADR 0409 Phase 2 — companies live in the content kernel. Pins the invariants
 * the honesty-gate suites don't directly assert: crm.company is a neverPublic
 * system type (never anonymously served), the full Company round-trips via
 * ext.company with queryable scalars in values, the merge CAS works over the
 * kernel, and the legacy→kernel migration is id-preserving + idempotent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  createCompany, getCompany, casUpdateCompany, migrateCompaniesToKernel, type Company,
} from '../src/features/crm/entities/companies.js';
import { getEntityType, getSystemEntity, queryEntities } from '../src/features/entities/entitiesService.js';
import { readPublicEntities } from '../src/features/entities/publicRead.js';

const T = 'tenant-crm-kernel';
const ORG = 'org-1';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0409 Phase 2 — crm.company on the kernel', () => {
  it('crm.company is a neverPublic system type; a company is never anonymously served', async () => {
    await createCompany({ tenantId: T, orgId: ORG, name: 'Acme', domain: 'acme.test', size: 42, createdBy: 'u1' });
    const type = await getEntityType(T, undefined, 'crm.company');
    expect(type?.system).toBe(true);
    expect(type?.neverPublic).toBe(true);
    // The anonymous surface refuses it outright (lock 2).
    await expect(readPublicEntities({ tenantId: T, typeName: 'crm.company', limit: 10 }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('round-trips the full Company via ext.company; scalars are queryable in values', async () => {
    const c = await createCompany({ tenantId: T, orgId: ORG, name: 'Globex', domain: 'globex.test', industry: 'Tech', size: 100, revenue: 5_000_000, createdBy: 'u1' });
    const got = await getCompany(T, ORG, c.companyId);
    expect(got).toMatchObject({ name: 'Globex', domain: 'globex.test', industry: 'Tech', size: 100, revenue: 5_000_000, orgId: ORG });
    // The kernel row: full Company in ext.company, scalars mirrored to values.
    const rec = await getSystemEntity(T, 'crm.company', c.companyId);
    expect((rec?.ext?.company as Company).name).toBe('Globex');
    expect(rec?.values.org_id).toBe(ORG);
    expect(rec?.values.name).toBe('Globex');
    expect(rec?.values.size).toBe(100);
    // ADR 0409 — the opaque top-level orgId keeps the RI-7 org-delete guard +
    // org teardown seeing org-scoped rows after the kernel move.
    expect(rec?.orgId).toBe(ORG);
    // Generic (RBAC-gated at the façade) query sees it by org.
    const q = await queryEntities({ tenantId: T, typeName: 'crm.company', filters: [{ key: 'org_id', op: 'eq', value: ORG }] });
    expect(q.entities.map((e) => e.values.name)).toContain('Globex');
    // Cross-org get is refused (IDOR guard preserved).
    expect(await getCompany(T, 'other-org', c.companyId)).toBeNull();
  });

  it('merge CAS (casUpdateCompany) swaps over the kernel and fails a stale expected', async () => {
    const c = await createCompany({ tenantId: T, orgId: ORG, name: 'Initech', createdBy: 'u1' });
    const fresh = await getCompany(T, ORG, c.companyId);
    const ok = await casUpdateCompany(fresh!, { domain: 'initech.test' });
    expect(ok?.domain).toBe('initech.test');
    // A stale expected (the pre-swap snapshot) now loses the CAS.
    const stale = await casUpdateCompany(fresh!, { industry: 'Software' });
    expect(stale).toBeNull();
  });

  it('migrates legacy crm:company rows id-preservingly + idempotently', async () => {
    const legacy = new DurableCollection<Company>('crm:company', (c) => c.companyId, undefined, (c) => c.tenantId);
    await legacy.put({
      companyId: 'cmp:legacy-1', tenantId: 'tenant-legacy', orgId: 'org-legacy', name: 'Old Co',
      domain: 'old.test', tags: ['vip'], customFields: { tier: 'gold' }, createdBy: 'u0',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const first = await migrateCompaniesToKernel();
    expect(first.migrated).toBeGreaterThanOrEqual(1);
    const again = await migrateCompaniesToKernel();
    expect(again.migrated).toBe(0);
    const got = await getCompany('tenant-legacy', 'org-legacy', 'cmp:legacy-1');
    expect(got).toMatchObject({ name: 'Old Co', domain: 'old.test', tags: ['vip'] });
    expect(got!.customFields.tier).toBe('gold'); // customFields round-trip via ext.company
  });
});
