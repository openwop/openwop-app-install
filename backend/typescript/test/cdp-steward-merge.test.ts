/**
 * CDP-B — steward contact-merge approval (ADR 0264). A match candidate is proposed
 * as a contact-merge approval; on APPROVE the registered CRM handler performs the
 * deterministic merge (a human dispositions it — never an auto-merge); on REJECT
 * nothing merges. Missing decider → forbidden.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createContact, getContact } from '../src/features/crm/contactsService.js';
import { createContactMergeApproval, getContactMergeApprovalHandler, getApproval } from '../src/host/approvalService.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // createApp registers backend features → the CRM feature registers the merge handler.
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

async function propose(tenantId: string) {
  const survivor = await createContact({ tenantId, name: 'Survivor' });
  const source = await createContact({ tenantId, name: 'Source', email: `s-${Math.random()}@x.test` });
  const approval = await createContactMergeApproval({ tenantId, survivorContactId: survivor.contactId, sourceContactId: source.contactId, proposal: 'merge' });
  return { survivor, source, approval };
}

describe('CDP-B steward merge', () => {
  it('registers a handler; APPROVE performs the merge', async () => {
    const handler = getContactMergeApprovalHandler();
    expect(handler).toBeTruthy();
    const tenantId = `org:stew-${Date.now()}`;
    const { survivor, source, approval } = await propose(tenantId);

    const decided = await handler!(tenantId, approval.approvalId, 'approved', { decidedByUserId: 'steward-1' });
    expect(decided?.changed).toBe(true);
    expect((await getContact(source.contactId))!.mergedInto).toBe(survivor.contactId); // merged
    expect((await getApproval(approval.approvalId))!.status).toBe('approved');
  });

  it('REJECT resolves the approval without merging', async () => {
    const handler = getContactMergeApprovalHandler()!;
    const tenantId = `org:stew2-${Date.now()}`;
    const { source, approval } = await propose(tenantId);
    const decided = await handler(tenantId, approval.approvalId, 'rejected', { decidedByUserId: 'steward-1' });
    expect(decided?.changed).toBe(true);
    expect((await getContact(source.contactId))!.mergedInto).toBeUndefined(); // NOT merged
    expect((await getApproval(approval.approvalId))!.status).toBe('rejected');
  });

  it('requires a signed-in decider (no auto-decide)', async () => {
    const handler = getContactMergeApprovalHandler()!;
    const tenantId = `org:stew3-${Date.now()}`;
    const { approval } = await propose(tenantId);
    await expect(handler(tenantId, approval.approvalId, 'approved', {})).rejects.toMatchObject({ code: 'forbidden_scope' });
  });
});
