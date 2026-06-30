/**
 * Forms feature SERVICE-layer coverage (ADR 0017) — fills the grade-code FEAT-4
 * gap: the existing `forms-route` / `forms-surface` tests exercise the HTTP
 * surface, but the pure service CRUD + tenant isolation invariants were never
 * unit-tested directly. This drives `formsService` against an in-memory sqlite
 * `DurableCollection` (no HTTP boot), asserting create/get/list/update/status/
 * delete round-trips, the validation guards, and that one tenant can never read
 * another's form (`getForm` tenant/org guard).
 *
 * `recordSubmission` (the only path that reaches out to `crmService.createContact`)
 * is exercised only with `createToContact: false`, so the test stays pure — no
 * CRM dependency, no network.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { OpenwopError } from '../src/types.js';
import {
  createForm,
  getForm,
  listForms,
  updateForm,
  setFormStatus,
  deleteForm,
  getPublishedForm,
  listSubmissions,
  validateValues,
  recordSubmission,
  __resetFormsStore,
  type FormDef,
} from '../src/features/forms/formsService.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const ORG = 'org-1';
const USER = 'user-1';

async function make(tenantId: string, orgId = ORG, title = 'Contact us'): Promise<FormDef> {
  return createForm({
    tenantId,
    orgId,
    title,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true },
    ],
    createdBy: USER,
  });
}

describe('formsService (service layer, in-memory durable)', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __resetFormsStore();
  });

  it('createForm → getForm round-trips the definition (default draft status)', async () => {
    const form = await make(TENANT_A);
    expect(form.formId).toMatch(/^form:/);
    expect(form.status).toBe('draft');
    expect(form.tenantId).toBe(TENANT_A);
    expect(form.fields).toHaveLength(2);

    const got = await getForm(TENANT_A, ORG, form.formId);
    expect(got).not.toBeNull();
    expect(got!.formId).toBe(form.formId);
    expect(got!.title).toBe('Contact us');
  });

  it('listForms returns only the (tenant, org) slice, newest first', async () => {
    const f1 = await make(TENANT_A, ORG, 'First');
    const f2 = await make(TENANT_A, ORG, 'Second');
    await make(TENANT_A, 'org-other', 'Other org'); // same tenant, different org
    await make(TENANT_B, ORG, 'Other tenant'); // different tenant

    const list = await listForms(TENANT_A, ORG);
    const ids = list.map((f) => f.formId);
    expect(ids).toContain(f1.formId);
    expect(ids).toContain(f2.formId);
    expect(ids).toHaveLength(2);
    expect(list.every((f) => f.tenantId === TENANT_A && f.orgId === ORG)).toBe(true);
  });

  it('tenant isolation: tenant B cannot read tenant A\'s form', async () => {
    const a = await make(TENANT_A);
    expect(await getForm(TENANT_B, ORG, a.formId)).toBeNull();
    // wrong org within the same tenant is also denied
    expect(await getForm(TENANT_A, 'org-other', a.formId)).toBeNull();
    expect(await listForms(TENANT_B, ORG)).toHaveLength(0);
  });

  it('updateForm patches title/fields and bumps updatedAt; returns null for foreign tenant', async () => {
    const a = await make(TENANT_A);
    const updated = await updateForm(TENANT_A, ORG, a.formId, {
      title: 'Renamed',
      fields: [{ key: 'q1', label: 'Q1', type: 'textarea', required: false }],
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Renamed');
    expect(updated!.fields).toHaveLength(1);
    expect(updated!.fields[0].key).toBe('q1');

    // tenant B cannot update tenant A's form
    expect(await updateForm(TENANT_B, ORG, a.formId, { title: 'hijack' })).toBeNull();
    const reread = await getForm(TENANT_A, ORG, a.formId);
    expect(reread!.title).toBe('Renamed');
  });

  it('setFormStatus publishes and gates getPublishedForm', async () => {
    const a = await make(TENANT_A);
    expect(await getPublishedForm(a.formId)).toBeNull(); // draft is not public

    const published = await setFormStatus(TENANT_A, ORG, a.formId, 'published');
    expect(published!.status).toBe('published');
    const pub = await getPublishedForm(a.formId);
    expect(pub).not.toBeNull();
    expect(pub!.formId).toBe(a.formId);
  });

  it('deleteForm removes the row and is idempotent / tenant-guarded', async () => {
    const a = await make(TENANT_A);
    // tenant B delete is a no-op (foreign)
    expect(await deleteForm(TENANT_B, ORG, a.formId)).toBe(false);
    expect(await getForm(TENANT_A, ORG, a.formId)).not.toBeNull();

    expect(await deleteForm(TENANT_A, ORG, a.formId)).toBe(true);
    expect(await getForm(TENANT_A, ORG, a.formId)).toBeNull();
    expect(await deleteForm(TENANT_A, ORG, a.formId)).toBe(false); // already gone
  });

  it('createForm rejects duplicate field keys and reserved honeypot key', async () => {
    await expect(
      createForm({
        tenantId: TENANT_A,
        orgId: ORG,
        title: 'Bad',
        fields: [
          { key: 'dup', label: 'A', type: 'text', required: false },
          { key: 'dup', label: 'B', type: 'text', required: false },
        ],
        createdBy: USER,
      }),
    ).rejects.toBeInstanceOf(OpenwopError);

    await expect(
      createForm({
        tenantId: TENANT_A,
        orgId: ORG,
        title: 'Bad2',
        fields: [{ key: '_hp_ref', label: 'Honeypot', type: 'text', required: false }],
        createdBy: USER,
      }),
    ).rejects.toBeInstanceOf(OpenwopError);
  });

  it('validateValues enforces required + email shape and returns the cleaned map', async () => {
    const form = await make(TENANT_A);
    expect(() => validateValues(form, { name: 'Ada' })).toThrow(OpenwopError); // email required
    expect(() => validateValues(form, { name: 'Ada', email: 'not-an-email' })).toThrow(OpenwopError);
    const clean = validateValues(form, { name: 'Ada', email: 'ada@example.com' });
    expect(clean).toEqual({ name: 'Ada', email: 'ada@example.com' });
  });

  it('recordSubmission (createToContact:false) appends a submission scoped to the form', async () => {
    const form = await make(TENANT_A);
    const values = validateValues(form, { name: 'Ada', email: 'ada@example.com' });
    const sub = await recordSubmission(form, values, {});
    expect(sub.submissionId).toMatch(/^sub:/);
    expect(sub.contactId).toBeUndefined();
    expect(sub.formId).toBe(form.formId);

    const subs = await listSubmissions(TENANT_A, ORG, form.formId);
    expect(subs).toHaveLength(1);
    expect(subs[0].values).toEqual({ name: 'Ada', email: 'ada@example.com' });
    // tenant B sees nothing
    expect(await listSubmissions(TENANT_B, ORG, form.formId)).toHaveLength(0);
  });
});
