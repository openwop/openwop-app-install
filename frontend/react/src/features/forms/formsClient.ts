/**
 * Forms API client (ADR 0017). Authed org-scoped builder under
 * /v1/host/sample/forms/orgs/:orgId; surfaces the PUBLIC /public-forms/:formId URL
 * and a form's captured submissions.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type FieldType = 'text' | 'email' | 'textarea' | 'select' | 'checkbox';
export const FIELD_TYPES: readonly FieldType[] = ['text', 'email', 'textarea', 'select', 'checkbox'];
export interface FormField { key: string; label: string; type: FieldType; required: boolean; options?: string[] }
export type FormStatus = 'draft' | 'published';

export interface FormDef {
  formId: string;
  orgId: string;
  title: string;
  status: FormStatus;
  fields: FormField[];
  createToContact: boolean;
  submitMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  submissionId: string;
  formId: string;
  values: Record<string, string | number | boolean>;
  contactId?: string;
  error?: string;
  createdAt: string;
}

const root = `${config.baseUrl}/v1/host/sample`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const base = (orgId: string): string => `${root}/forms/orgs/${encodeURIComponent(orgId)}/forms`;

export async function listForms(orgId: string): Promise<FormDef[]> {
  const res = await fetch(base(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ forms: FormDef[] }>(res, 'listForms')).forms;
}

export async function createForm(orgId: string, input: { title: string; fields: FormField[]; createToContact: boolean; submitMessage?: string }): Promise<FormDef> {
  const res = await fetch(base(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<FormDef>(res, 'createForm');
}

export async function updateForm(orgId: string, formId: string, patch: { title?: string; fields?: FormField[]; createToContact?: boolean; submitMessage?: string }): Promise<FormDef> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<FormDef>(res, 'updateForm');
}

export async function setFormStatus(orgId: string, formId: string, status: FormStatus): Promise<FormDef> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}/status`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ status }) }));
  return asJson<FormDef>(res, 'setFormStatus');
}

export async function deleteForm(orgId: string, formId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteForm returned ${res.status}`);
}

export async function listSubmissions(orgId: string, formId: string): Promise<Submission[]> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(formId)}/submissions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ submissions: Submission[] }>(res, 'listSubmissions')).submissions;
}

/** The public, unauthenticated form URL (render + submit live under it). */
export const publicFormUrl = (formId: string): string => `${root}/public-forms/${encodeURIComponent(formId)}`;
