/**
 * ADR 0627 D7 (`CRM-25`) — cascades are UNLINK-AND-KEEP. The SPA's five delete
 * confirms promise "its deals, tasks and activities are kept and unlinked"; this
 * file is what makes that sentence true for tasks and activities (deals already
 * had `deals-crm-unlink`).
 *
 * Every case asserts BOTH halves: the dangling pointer is GONE and the row
 * REMAINS (a cascade-delete would satisfy a pointer-gone assertion alone).
 * SABOTAGE: remove the `deal` handling from `tasks-crm-unlink` (e.g. return
 * early when `entity === 'deal'`) → "delete a deal" goes red.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createContact, deleteContact } from '../src/features/crm/contactsService.js';
import { createCompany, deleteCompany } from '../src/features/crm/entities/companies.js';
import { createDeal, deleteDeal, getDeal } from '../src/features/crm/entities/deals.js';
import { createTask, getTask, listTasks, makeLinkValidators } from '../src/features/crm/entities/tasks.js';
import { createActivity, getActivity, listActivities } from '../src/features/crm/entities/activities.js';

const T = 'tenant-unlink';
const ORG = 'org-1';
const OTHER_ORG = 'org-2';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

async function seed(orgId = ORG) {
  const contact = await createContact({ tenantId: T, name: 'Person', email: `p-${orgId}@acme.test` });
  const company = await createCompany({ tenantId: T, orgId, name: 'Acme', createdBy: 'u1' });
  const deal = await createDeal({
    tenantId: T, orgId, title: 'Deal', companyId: company.companyId, contactId: contact.contactId, createdBy: 'u1',
    validateCompany: async () => true, validateContact: async () => true,
  });
  const validators = makeLinkValidators(T, orgId);
  const task = await createTask({ tenantId: T, orgId, title: 'Follow up', dealId: deal.dealId, contactId: contact.contactId, companyId: company.companyId, createdBy: 'u1', validators });
  const activity = await createActivity({ tenantId: T, orgId, kind: 'note', body: 'Called them', dealId: deal.dealId, contactId: contact.contactId, companyId: company.companyId, createdBy: 'u1', validators });
  return { contact, company, deal, task, activity };
}

describe('ADR 0627 D7 — unlink-and-keep on the record-deleted seam', () => {
  it('delete a DEAL → its tasks\' and activities\' dealId is gone; the rows remain (contact/company links intact)', async () => {
    const s = await seed();
    expect(await deleteDeal(T, ORG, s.deal.dealId)).toBe(true);

    const task = await getTask(T, ORG, s.task.taskId);
    expect(task, 'the task is KEPT').not.toBeNull();
    expect(task!.dealId).toBeUndefined();
    expect(task!.contactId).toBe(s.contact.contactId);
    expect(task!.companyId).toBe(s.company.companyId);

    const activity = await getActivity(T, ORG, s.activity.activityId);
    expect(activity, 'the timeline entry is KEPT').not.toBeNull();
    expect(activity!.dealId).toBeUndefined();
    expect(activity!.body).toBe('Called them');
    expect(activity!.contactId).toBe(s.contact.contactId);
  });

  it('delete a COMPANY → tasks/activities/deals drop companyId; every row remains', async () => {
    const s = await seed();
    expect(await deleteCompany(T, ORG, s.company.companyId)).toBe(true);

    expect((await getTask(T, ORG, s.task.taskId))!.companyId).toBeUndefined();
    expect((await getActivity(T, ORG, s.activity.activityId))!.companyId).toBeUndefined();
    const deal = await getDeal(T, ORG, s.deal.dealId);
    expect(deal, 'the deal is KEPT (revenue data)').not.toBeNull();
    expect(deal!.companyId).toBeUndefined();
    expect(deal!.contactId).toBe(s.contact.contactId);
    expect(await listTasks(T, ORG)).toHaveLength(1);
    expect(await listActivities(T, ORG)).toHaveLength(1);
  });

  it('delete a CONTACT → all three pointer kinds go across deals, tasks and activities; nothing is deleted', async () => {
    const s = await seed();
    expect(await deleteContact(s.contact.contactId)).toBe(true);

    expect((await getDeal(T, ORG, s.deal.dealId))!.contactId).toBeUndefined();
    expect((await getTask(T, ORG, s.task.taskId))!.contactId).toBeUndefined();
    expect((await getActivity(T, ORG, s.activity.activityId))!.contactId).toBeUndefined();
    // The other pointers are untouched by a contact delete.
    expect((await getTask(T, ORG, s.task.taskId))!.dealId).toBe(s.deal.dealId);
    expect((await getActivity(T, ORG, s.activity.activityId))!.companyId).toBe(s.company.companyId);
    expect(await listTasks(T, ORG)).toHaveLength(1);
    expect(await listActivities(T, ORG)).toHaveLength(1);
  });

  it('company/deal unlinks are ORG-scoped; a contact unlink is tenant-wide', async () => {
    const a = await seed(ORG);
    const b = await seed(OTHER_ORG);
    // Deleting org-1's company must not touch org-2's rows even if ids collided —
    // they don't, but the handler filters on orgId regardless (defense in depth).
    await deleteCompany(T, ORG, a.company.companyId);
    expect((await getTask(T, OTHER_ORG, b.task.taskId))!.companyId).toBe(b.company.companyId);
    // A contact is the tenant rolodex: deleting it unlinks in EVERY org.
    const shared = await createContact({ tenantId: T, name: 'Shared', email: 'shared@acme.test' });
    const vA = makeLinkValidators(T, ORG);
    const vB = makeLinkValidators(T, OTHER_ORG);
    const tA = await createTask({ tenantId: T, orgId: ORG, title: 'A', contactId: shared.contactId, createdBy: 'u1', validators: vA });
    const tB = await createTask({ tenantId: T, orgId: OTHER_ORG, title: 'B', contactId: shared.contactId, createdBy: 'u1', validators: vB });
    await deleteContact(shared.contactId);
    expect((await getTask(T, ORG, tA.taskId))!.contactId).toBeUndefined();
    expect((await getTask(T, OTHER_ORG, tB.taskId))!.contactId).toBeUndefined();
  });

  it('is idempotent: a second fire over already-unlinked rows changes nothing', async () => {
    const s = await seed();
    await deleteDeal(T, ORG, s.deal.dealId);
    const before = await getTask(T, ORG, s.task.taskId);
    const { fireCrmRecordDeleted } = await import('../src/host/crmRecordLifecycle.js');
    await fireCrmRecordDeleted({ tenantId: T, orgId: ORG, entity: 'deal', recordId: s.deal.dealId });
    expect(await getTask(T, ORG, s.task.taskId)).toEqual(before);
  });
});
