/**
 * CRM feature client (host-extension, non-normative). Wraps
 * /v1/host/sample/crm/*. The surface 404s when the CRM toggle is off — the
 * page gates on useFeatureAccess('crm') so it never calls a disabled surface.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

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

export interface TriageResult {
  runId: string;
  variant: string | null;
  bindings: unknown;
  workflowId: string;
}

const base = `${config.baseUrl}/v1/host/sample/crm`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listContacts(): Promise<Contact[]> {
  const res = await fetch(`${base}/contacts`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ contacts: Contact[] }>(res, 'listContacts')).contacts;
}

export async function createContact(input: { name: string; email?: string; company?: string; stage?: ContactStage }): Promise<Contact> {
  const res = await fetch(`${base}/contacts`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Contact>(res, 'createContact');
}

export async function deleteContact(contactId: string): Promise<void> {
  const res = await fetch(`${base}/contacts/${encodeURIComponent(contactId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new Error(`deleteContact returned ${res.status}`);
}

export async function triageContact(contactId: string): Promise<TriageResult> {
  const res = await fetch(`${base}/contacts/${encodeURIComponent(contactId)}/triage`, fetchOpts({
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({}),
  }));
  return asJson<TriageResult>(res, 'triageContact');
}
