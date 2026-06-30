/**
 * CRM contacts store (host-extension, best-effort — ADR 0001 §4).
 *
 * Tenant-scoped contacts backed by the durable host_ext_kv collection (same
 * read-through, cross-instance store as roster/kanban; no schema migration).
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';

// ADR 0077 P1 — declare this entity's PII fields once at module load (the
// `registerSubjectEraser` side-effect pattern). `name` + `email` identify a person;
// `company` is an org attribute, not personal data.
declarePiiFields('crm.contact', ['name', 'email']);

export type ContactStage = 'lead' | 'qualified' | 'customer' | 'churned';
export const CONTACT_STAGES: readonly ContactStage[] = ['lead', 'qualified', 'customer', 'churned'];

export interface Contact {
  contactId: string;
  tenantId: string;
  name: string;
  email?: string;
  company?: string;
  stage: ContactStage;
  createdAt: string;
  updatedAt: string;
}

// GOV-1: `tenantOf` arms the tenant secondary index so the retention purger scans only
// this tenant's slice (`listForTenantIndexed`) instead of the whole collection.
const store = new DurableCollection<Contact>('crm:contact', (c) => c.contactId, undefined, (c) => c.tenantId);

/** The caller's contacts, newest first. */
export async function listContacts(tenantId: string): Promise<Contact[]> {
  const all = await store.list();
  return all.filter((c) => c.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getContact(contactId: string): Promise<Contact | null> {
  return store.get(contactId);
}

export async function createContact(input: {
  tenantId: string;
  name: string;
  email?: string;
  company?: string;
  stage?: ContactStage;
}): Promise<Contact> {
  const now = new Date().toISOString();
  const contact: Contact = {
    contactId: `crm:${randomUUID()}`,
    tenantId: input.tenantId,
    name: input.name,
    stage: input.stage ?? 'lead',
    createdAt: now,
    updatedAt: now,
    ...(input.email ? { email: input.email } : {}),
    ...(input.company ? { company: input.company } : {}),
  };
  await store.put(contact);
  return contact;
}

export async function updateContact(
  contactId: string,
  patch: { name?: string; email?: string | null; company?: string | null; stage?: ContactStage },
): Promise<Contact | null> {
  const existing = await store.get(contactId);
  if (!existing) return null;
  const next: Contact = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.stage !== undefined) next.stage = patch.stage;
  if (patch.email !== undefined) {
    if (patch.email === null || patch.email === '') delete next.email;
    else next.email = patch.email;
  }
  if (patch.company !== undefined) {
    if (patch.company === null || patch.company === '') delete next.company;
    else next.company = patch.company;
  }
  await store.put(next);
  return next;
}

export async function deleteContact(contactId: string): Promise<boolean> {
  return store.delete(contactId);
}

// DELIBERATELY NOT a `registerSubjectEraser` consumer (crm is retention-only): a CRM
// contact is a THIRD-PARTY business record the tenant holds ABOUT someone else — it has no
// app-user/principal key (contactId is a random uuid), so a DSAR keyed on the subject's
// principal must NOT delete it. The contact's marketing send-history IS reachable (the
// email feature erases send-logs by contactId). "Erase the third party I hold a record
// about" is a distinct DSAR-by-email path (its own route/ADR), never this shared
// principal-keyed seam — overloading it would cross-match other erasers' namespaces.
// (ADR 0081 P5 correction: profiles+comments IN, crm OUT.)

// ADR 0081 P5 — time-based retention (ADR 0077 seam). A contact carries person PII
// (name/email, declared above). Delete this tenant's contacts NOT touched within the
// window — age on `updatedAt` (abandoned records, not merely old ones: a durable entity
// differs from analytics' event-time `ts`). No-op on a falsy tenant / non-PII
// classification (fail-closed — never a cross-tenant/global purge).
registerRetentionPurger({
  feature: 'crm',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('crm', await store.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (c) => ({ tenantId: c.tenantId, updatedAt: c.updatedAt, id: c.contactId }),
      (id) => store.delete(id));
  },
});

/** Test-only: clear all contacts. */
export async function __resetCrmStore(): Promise<void> {
  await store.__clear();
}
