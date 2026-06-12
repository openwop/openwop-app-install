/**
 * Forms feature service (host-extension, ADR 0017) — the capture leg of the
 * growth loop. Org-scoped form definitions + an APPEND-ONLY submission log; a
 * public submit can best-effort create a CRM contact THROUGH `crmService`
 * (`createContact`), never a direct contacts-store write — the single-source-of-
 * truth fix for MyndHyve's `formApi` wart. Backed by the durable host_ext_kv.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { createContact } from '../crm/contactsService.js';

export type FieldType = 'text' | 'email' | 'textarea' | 'select' | 'checkbox';
export const FIELD_TYPES: readonly FieldType[] = ['text', 'email', 'textarea', 'select', 'checkbox'];

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[]; // `select` only
}

export type FormStatus = 'draft' | 'published';

export interface FormDef {
  formId: string;
  tenantId: string;
  orgId: string;
  title: string;
  status: FormStatus;
  fields: FormField[];
  createToContact: boolean;
  submitMessage?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  submissionId: string;
  tenantId: string;
  orgId: string;
  formId: string;
  values: Record<string, string | number | boolean>;
  contactId?: string;
  error?: string;
  meta: { referrer?: string; utm?: Record<string, string> };
  createdAt: string;
}

/** A fixed decoy field the public render asks the client to include (hidden). A
 *  non-empty value on submit ⇒ a bot ⇒ the submission is silently dropped. */
export const HONEYPOT_FIELD = '_hp_ref';
const MAX_FIELDS = 50;
const MAX_FIELD_LEN = 5_000;
const MAX_VALUES_CHARS = 20_000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const forms = new DurableCollection<FormDef>('forms:def', (f) => f.formId);
const submissions = new DurableCollection<Submission>('forms:submission', (s) => s.submissionId);

function sanitizeFields(input: unknown): FormField[] {
  if (!Array.isArray(input)) throw new OpenwopError('validation_error', '`fields` MUST be an array.', 400, { field: 'fields' });
  if (input.length > MAX_FIELDS) throw new OpenwopError('validation_error', `A form may have at most ${MAX_FIELDS} fields.`, 400, {});
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const key = typeof f.key === 'string' ? f.key.trim() : '';
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) throw new OpenwopError('validation_error', `fields[${i}].key MUST match [a-zA-Z0-9_]{1,64}.`, 400, {});
    if (key === HONEYPOT_FIELD) throw new OpenwopError('validation_error', `fields[${i}].key is reserved.`, 400, { field: key });
    if (seen.has(key)) throw new OpenwopError('validation_error', `Duplicate field key: ${key}.`, 400, { field: key });
    seen.add(key);
    const type = FIELD_TYPES.includes(f.type as FieldType) ? (f.type as FieldType) : 'text';
    const label = typeof f.label === 'string' && f.label.trim() ? f.label : key;
    const field: FormField = { key, label, type, required: f.required === true };
    if (type === 'select') field.options = Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string') : [];
    return field;
  });
}

export async function listForms(tenantId: string, orgId: string): Promise<FormDef[]> {
  const all = await forms.list();
  return all.filter((f) => f.tenantId === tenantId && f.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Tenant+org-guarded read (the authed surface + ctx.features.forms use this). */
export async function getForm(tenantId: string, orgId: string, formId: string): Promise<FormDef | null> {
  const f = await forms.get(formId);
  return f && f.tenantId === tenantId && f.orgId === orgId ? f : null;
}

export async function createForm(input: {
  tenantId: string; orgId: string; title: string; fields: unknown;
  createToContact?: boolean; submitMessage?: string; createdBy: string;
}): Promise<FormDef> {
  const now = new Date().toISOString();
  const form: FormDef = {
    formId: `form:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title: input.title,
    status: 'draft',
    fields: sanitizeFields(input.fields ?? []),
    createToContact: input.createToContact === true,
    ...(input.submitMessage ? { submitMessage: input.submitMessage } : {}),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await forms.put(form);
  return form;
}

export async function updateForm(tenantId: string, orgId: string, formId: string, patch: {
  title?: string; fields?: unknown; createToContact?: boolean; submitMessage?: string;
}): Promise<FormDef | null> {
  const existing = await getForm(tenantId, orgId, formId);
  if (!existing) return null;
  const next: FormDef = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.fields !== undefined) next.fields = sanitizeFields(patch.fields);
  if (patch.createToContact !== undefined) next.createToContact = patch.createToContact === true;
  if (patch.submitMessage !== undefined) next.submitMessage = patch.submitMessage;
  await forms.put(next);
  return next;
}

export async function setFormStatus(tenantId: string, orgId: string, formId: string, status: FormStatus): Promise<FormDef | null> {
  const existing = await getForm(tenantId, orgId, formId);
  if (!existing) return null;
  const next: FormDef = { ...existing, status, updatedAt: new Date().toISOString() };
  await forms.put(next);
  return next;
}

export async function deleteForm(tenantId: string, orgId: string, formId: string): Promise<boolean> {
  const existing = await getForm(tenantId, orgId, formId);
  if (!existing) return false;
  return forms.delete(formId);
}

/** Public resolver: a PUBLISHED form by id, NO tenant guard — the public route
 *  derives tenant from the result and then gates on its toggle (uniform 404). */
export async function getPublishedForm(formId: string): Promise<FormDef | null> {
  const f = await forms.get(formId);
  return f && f.status === 'published' ? f : null;
}

export async function listSubmissions(tenantId: string, orgId: string, formId: string): Promise<Submission[]> {
  const all = await submissions.list();
  return all
    .filter((s) => s.tenantId === tenantId && s.orgId === orgId && s.formId === formId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Validate raw submit values against the form's fields; returns the cleaned map. */
export function validateValues(form: FormDef, values: Record<string, unknown>): Record<string, string | number | boolean> {
  if (JSON.stringify(values).length > MAX_VALUES_CHARS) throw new OpenwopError('validation_error', 'Submission too large.', 413, {});
  const out: Record<string, string | number | boolean> = {};
  for (const f of form.fields) {
    const v = values[f.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (f.required && empty) throw new OpenwopError('validation_error', `Field \`${f.key}\` is required.`, 400, { field: f.key });
    if (empty) continue;
    if (f.type === 'checkbox') { out[f.key] = v === true || v === 'true'; continue; }
    if (typeof v !== 'string') throw new OpenwopError('validation_error', `Field \`${f.key}\` MUST be a string.`, 400, { field: f.key });
    if (v.length > MAX_FIELD_LEN) throw new OpenwopError('validation_error', `Field \`${f.key}\` is too long.`, 400, { field: f.key });
    if (f.type === 'email' && !EMAIL_RE.test(v)) throw new OpenwopError('validation_error', `Field \`${f.key}\` MUST be a valid email.`, 400, { field: f.key });
    if (f.type === 'select' && f.options && f.options.length > 0 && !f.options.includes(v)) throw new OpenwopError('validation_error', `Field \`${f.key}\` is not an allowed option.`, 400, { field: f.key });
    out[f.key] = v;
  }
  return out;
}

function deriveContact(form: FormDef, values: Record<string, string | number | boolean>): { name: string; email?: string; company?: string } | null {
  const emailField = form.fields.find((f) => f.type === 'email');
  const email = emailField && typeof values[emailField.key] === 'string' ? (values[emailField.key] as string) : undefined;
  const name = typeof values.name === 'string' ? (values.name as string) : email;
  if (!name) return null;
  const company = typeof values.company === 'string' ? (values.company as string) : undefined;
  return { name, ...(email ? { email } : {}), ...(company ? { company } : {}) };
}

/**
 * Record a submission (APPEND-ONLY) then BEST-EFFORT create a CRM contact via
 * `crmService.createContact` — the lead is durably captured before any secondary
 * effect, so a CRM hiccup degrades to a recorded `error`, never a lost lead.
 * `tenantId`/`orgId` come from the resolved form, never the request.
 */
export async function recordSubmission(form: FormDef, values: Record<string, string | number | boolean>, meta: Submission['meta']): Promise<Submission> {
  const submission: Submission = {
    submissionId: `sub:${randomUUID()}`,
    tenantId: form.tenantId,
    orgId: form.orgId,
    formId: form.formId,
    values,
    meta,
    createdAt: new Date().toISOString(),
  };
  await submissions.put(submission); // persist FIRST — capture before side-effects
  if (form.createToContact) {
    const mapped = deriveContact(form, values);
    if (!mapped) {
      submission.error = 'no_contact_fields';
    } else {
      try {
        const contact = await createContact({ tenantId: form.tenantId, name: mapped.name, ...(mapped.email ? { email: mapped.email } : {}), ...(mapped.company ? { company: mapped.company } : {}) });
        submission.contactId = contact.contactId;
      } catch {
        submission.error = 'contact_create_failed';
      }
    }
    await submissions.put(submission); // re-persist with contactId / error
  }
  return submission;
}

/** Test-only: clear both stores. */
export async function __resetFormsStore(): Promise<void> {
  await forms.__clear();
  await submissions.__clear();
}
