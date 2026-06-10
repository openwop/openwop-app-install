/**
 * CRM contacts store (host-extension, sample-grade — ADR 0001 §4).
 *
 * Tenant-scoped contacts backed by the durable host_ext_kv collection (same
 * read-through, cross-instance store as roster/kanban; no schema migration).
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';

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

const store = new DurableCollection<Contact>('crm:contact', (c) => c.contactId);

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

/** Test-only: clear all contacts. */
export async function __resetCrmStore(): Promise<void> {
  await store.__clear();
}
