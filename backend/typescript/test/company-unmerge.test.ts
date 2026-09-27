/**
 * GEN-7 — reversible COMPANY merge (the sibling of the ADR 0264 contact unmerge).
 * merge fills survivor scalars + absorbs tags/customFields + relinks refs + tombstones
 * the source; unmerge restores the source live (its own data was left intact) with its
 * refs, and strips ONLY what the survivor absorbed — fail-closed per field (a survivor
 * value edited since the merge is respected).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createCompany, getCompany, updateCompany, deleteCompany } from '../src/features/crm/entities/companies.js';
import { createDeal, getDeal } from '../src/features/crm/entities/deals.js';
import { mergeCompanies, unmergeCompanies } from '../src/features/crm/crmMergeService.js';
import { listCompanyMergeEvents } from '../src/features/crm/crmCompanyMergeEventsService.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

const yes = async (): Promise<boolean> => true;

describe('GEN-7 company unmerge round-trip', () => {
  it('merge then unmerge restores the source (with its refs) and strips only what the survivor absorbed', async () => {
    const tenantId = `org:cunm-${Date.now()}`;
    const orgId = 'org-cunm';
    const survivor = await createCompany({ tenantId, orgId, name: 'Survivor Co', createdBy: 'tester' }); // no domain/tags/cf
    const source = await createCompany({ tenantId, orgId, name: 'Source Co', domain: 'src.com', tags: ['src-tag'], customFields: { plan: 'gold' }, createdBy: 'tester' });
    const deal = await createDeal({ tenantId, orgId, title: 'Deal-1', companyId: source.companyId, createdBy: 'tester', validateCompany: yes, validateContact: yes });

    // ── merge ──
    await mergeCompanies(tenantId, orgId, survivor.companyId, source.companyId, 'tester');
    const survMerged = await getCompany(tenantId, orgId, survivor.companyId);
    expect(survMerged!.domain).toBe('src.com');                 // filled from source
    expect(survMerged!.tags).toContain('src-tag');              // absorbed tag
    expect(survMerged!.customFields?.plan).toBe('gold');        // absorbed customField key
    expect((await getCompany(tenantId, orgId, source.companyId))!.mergedInto).toBe(survivor.companyId); // tombstoned
    expect((await getDeal(tenantId, orgId, deal.dealId))!.companyId).toBe(survivor.companyId);          // ref relinked

    // the event captured exactly the absorbed substrate
    const ev = (await listCompanyMergeEvents(tenantId))[0];
    expect(ev.filledFields.domain).toBe('src.com');
    expect(ev.absorbedTags).toEqual(['src-tag']);
    expect(ev.absorbedCustomFields.plan).toBe('gold');
    expect(ev.refIds.deals).toContain(deal.dealId);

    // ── unmerge ──
    const res = await unmergeCompanies(tenantId, orgId, ev.mergeEventId);
    expect(res.sourceId).toBe(source.companyId);

    const survFinal = await getCompany(tenantId, orgId, survivor.companyId);
    expect(survFinal!.domain).toBeUndefined();                 // filled scalar cleared (was blank pre-merge)
    expect(survFinal!.tags).not.toContain('src-tag');          // absorbed tag removed
    expect(survFinal!.customFields?.plan).toBeUndefined();     // absorbed key deleted
    const srcFinal = await getCompany(tenantId, orgId, source.companyId);
    expect(srcFinal!.mergedInto).toBeUndefined();              // un-tombstoned (live again)
    expect(srcFinal!.domain).toBe('src.com');                  // source retained its OWN original data
    expect(srcFinal!.tags).toContain('src-tag');
    expect((await getDeal(tenantId, orgId, deal.dealId))!.companyId).toBe(source.companyId); // ref restored

    // idempotent: a second unmerge is a conflict
    await expect(unmergeCompanies(tenantId, orgId, ev.mergeEventId)).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('fail-closed: a survivor field EDITED after the merge is left intact on unmerge (source still restored)', async () => {
    const tenantId = `org:cunm2-${Date.now()}`;
    const orgId = 'org-cunm2';
    const survivor = await createCompany({ tenantId, orgId, name: 'Surv2', createdBy: 'tester' });
    const source = await createCompany({ tenantId, orgId, name: 'Src2', domain: 'src2.com', createdBy: 'tester' });

    await mergeCompanies(tenantId, orgId, survivor.companyId, source.companyId, 'tester');
    // the user edits the survivor's (absorbed) domain after the merge
    await updateCompany(tenantId, orgId, survivor.companyId, { domain: 'edited.com' });

    const ev = (await listCompanyMergeEvents(tenantId))[0];
    await unmergeCompanies(tenantId, orgId, ev.mergeEventId);

    // the diverged survivor field is respected (NOT cleared) …
    expect((await getCompany(tenantId, orgId, survivor.companyId))!.domain).toBe('edited.com');
    // … and the source is still fully restored regardless (its own data was intact).
    const srcFinal = await getCompany(tenantId, orgId, source.companyId);
    expect(srcFinal!.mergedInto).toBeUndefined();
    expect(srcFinal!.domain).toBe('src2.com');
  });

  it('unmerge SUCCEEDS when the survivor was deleted after the merge (gone ≠ contention — no spurious 409)', async () => {
    const tenantId = `org:cunm3-${Date.now()}`;
    const orgId = 'org-cunm3';
    const survivor = await createCompany({ tenantId, orgId, name: 'Surv3', createdBy: 'tester' });
    const source = await createCompany({ tenantId, orgId, name: 'Src3', domain: 'src3.com', createdBy: 'tester' });
    await mergeCompanies(tenantId, orgId, survivor.companyId, source.companyId, 'tester');
    // the survivor is deleted — there is nothing left to strip.
    await deleteCompany(tenantId, orgId, survivor.companyId);

    const ev = (await listCompanyMergeEvents(tenantId))[0];
    // A gone survivor is "vacuously reverted" (true), NOT a retriable contention (false) —
    // the unmerge must complete + restore the source, not 409 forever.
    const res = await unmergeCompanies(tenantId, orgId, ev.mergeEventId);
    expect(res.sourceId).toBe(source.companyId);
    expect((await getCompany(tenantId, orgId, source.companyId))!.mergedInto).toBeUndefined();
    // idempotent: the event is consumed (a second unmerge 409s already-reversed, not retry).
    await expect(unmergeCompanies(tenantId, orgId, ev.mergeEventId)).rejects.toMatchObject({ httpStatus: 409 });
  });
});
