/**
 * RI-7 / DG-INT-5 (grade-data, architect-ruled) — `deleteOrg` refuses (NON-
 * throwing: `blocked` on the return, mapped to 409 at the route) while the org
 * still holds business rows, instead of orphaning everything org-scoped. Once
 * the content is gone the delete proceeds and cascades the access scaffolding.
 * Also: CRM-5's csm consumer — deleting a CRM company scrubs `crmRef` off csm
 * accounts (the account + health history survive).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createOrg, deleteOrg, listOrgs } from '../src/host/accessControlService.js';
import { createCompany, deleteCompany } from '../src/features/crm/crmEntitiesService.js';
import { onCrmRecordDeleted } from '../src/host/crmRecordLifecycle.js';
import { createAccount, getAccount, scrubCrmRefsForDeletedCompany } from '../src/features/csm/accountsService.js';

const T = 'org-guard-t1';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // The csm feature registers this at app boot; this service-level suite
  // registers the SAME keyed consumer explicitly.
  onCrmRecordDeleted('csm', async ({ tenantId, entity, recordId }) => {
    if (entity === 'company') await scrubCrmRefsForDeletedCompany(tenantId, recordId);
  });
});

describe('deleteOrg refuse-while-populated (RI-7)', () => {
  it('blocks while business rows exist, proceeds once emptied', async () => {
    const org = await createOrg({ tenantId: T, createdBy: 'test', name: 'Guarded Org' });
    const company = await createCompany({ tenantId: T, orgId: org.orgId, createdBy: 'test', name: 'Resident Co', domain: 'resident.test' });

    const blocked = await deleteOrg(org.orgId);
    expect(blocked.org).toBe(false);
    expect(blocked.blocked?.rows).toBeGreaterThanOrEqual(1); // the CRM company
    expect((await listOrgs(T)).some((o) => o.orgId === org.orgId)).toBe(true); // org survives

    await deleteCompany(T, org.orgId, company.companyId);
    const ok = await deleteOrg(org.orgId);
    expect(ok.org).toBe(true);
    expect(ok.blocked).toBeUndefined();
    expect((await listOrgs(T)).some((o) => o.orgId === org.orgId)).toBe(false);
  });
});

describe('csm crmRef scrub on company delete (CRM-5)', () => {
  it('scrubs the ref, keeps the account; bystander ref intact', async () => {
    const org = await createOrg({ tenantId: T, createdBy: 'test', name: 'CSM Org' });
    const doomedCo = await createCompany({ tenantId: T, orgId: org.orgId, createdBy: 'test', name: 'Doomed Co', domain: 'doomed.test' });
    const keeperCo = await createCompany({ tenantId: T, orgId: org.orgId, createdBy: 'test', name: 'Keeper Co', domain: 'keeper.test' });

    const doomedAcct = await createAccount({ tenantId: T, name: 'Doomed Account', crmRef: { orgId: org.orgId, companyId: doomedCo.companyId } });
    const keeperAcct = await createAccount({ tenantId: T, name: 'Keeper Account', crmRef: { orgId: org.orgId, companyId: keeperCo.companyId } });

    await deleteCompany(T, org.orgId, doomedCo.companyId);

    const doomedAfter = await getAccount(doomedAcct.accountId);
    expect(doomedAfter).not.toBeNull(); // account survives
    expect(doomedAfter!.crmRef).toBeUndefined(); // ref scrubbed
    expect((await getAccount(keeperAcct.accountId))!.crmRef?.companyId).toBe(keeperCo.companyId);
  });
});
