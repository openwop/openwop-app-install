/**
 * CDP-B — reversible merge/unmerge (ADR 0264). The data-integrity round-trip:
 * merge fills fields + absorbs identifiers + relinks refs + tombstones source;
 * unmerge restores the source live with its OWN fields, identifiers, and refs, and
 * strips what the survivor absorbed. Resolution follows the reversal both ways.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createContact, getContact, findContactByEmail, addContactIdentifier } from '../src/features/crm/contactsService.js';
import { mergeContacts, unmergeContacts } from '../src/features/crm/crmMergeService.js';
import { listMergeEvents } from '../src/features/crm/crmMergeEventsService.js';
import { createDeal, getDeal } from '../src/features/crm/entities/deals.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('CDP-B unmerge round-trip', () => {
  it('merge then unmerge fully restores source (fields, identifiers, refs) + resolution', async () => {
    const tenantId = `org:unm-${Date.now()}`;
    const orgId = 'org-unm';
    const survivor = await createContact({ tenantId, name: 'Survivor' }); // no email/company
    const source = await createContact({ tenantId, name: 'Source', email: 'src@x.test', company: 'Acme' });
    await addContactIdentifier(source.contactId, tenantId, { type: 'loyalty', value: 'L9' });
    const deal = await createDeal({ tenantId, orgId, title: 'Deal-1', contactId: source.contactId, createdBy: 'tester', validateContact: async () => true } as any);

    // ── merge ──
    await mergeContacts(tenantId, survivor.contactId, source.contactId, 'tester');
    const survMerged = await getContact(survivor.contactId);
    expect(survMerged!.email).toBe('src@x.test');       // filled from source
    expect(survMerged!.company).toBe('Acme');
    expect(survMerged!.identifiers?.some((i) => i.type === 'loyalty' && i.value === 'L9')).toBe(true); // absorbed
    expect((await getContact(source.contactId))!.mergedInto).toBe(survivor.contactId); // tombstoned
    expect((await findContactByEmail(tenantId, 'src@x.test'))!.contactId).toBe(survivor.contactId); // resolves to survivor
    expect((await getDeal(tenantId, orgId, deal.dealId))!.contactId).toBe(survivor.contactId);      // ref relinked

    // ── unmerge ──
    const ev = (await listMergeEvents(tenantId))[0];
    const res = await unmergeContacts(tenantId, ev.mergeEventId);
    expect(res.sourceId).toBe(source.contactId);

    const survFinal = await getContact(survivor.contactId);
    expect(survFinal!.email).toBeUndefined();  // filled field cleared (was blank pre-merge)
    expect(survFinal!.company).toBeUndefined();
    expect(survFinal!.identifiers?.some((i) => i.type === 'loyalty')).toBeFalsy(); // absorbed removed
    const srcFinal = await getContact(source.contactId);
    expect(srcFinal!.mergedInto).toBeUndefined(); // un-tombstoned (live again)
    expect((await findContactByEmail(tenantId, 'src@x.test'))!.contactId).toBe(source.contactId); // resolves to SOURCE now
    expect((await getDeal(tenantId, orgId, deal.dealId))!.contactId).toBe(source.contactId);       // ref restored

    // idempotent: a second unmerge is a conflict
    await expect(unmergeContacts(tenantId, ev.mergeEventId)).rejects.toThrow();
  });
});
