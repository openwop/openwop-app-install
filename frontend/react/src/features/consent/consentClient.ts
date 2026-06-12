/**
 * Consent API client (ADR 0020). Authed org-scoped policy + records +
 * data-subject (GDPR) lookup/delete under /v1/host/sample/consent/orgs/:orgId.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type DefaultMode = 'opt-in' | 'opt-out';
export interface ConsentPolicy { tenantId: string; regulatedRegions: string[]; defaultMode: DefaultMode }
export interface ConsentRecord {
  subjectKey: string;
  region?: string;
  categories: { necessary: boolean; analytics: boolean; marketing: boolean };
  source: string;
  ts: string;
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

const base = (orgId: string): string => `${root}/consent/orgs/${encodeURIComponent(orgId)}`;

export async function getPolicy(orgId: string): Promise<ConsentPolicy> {
  const res = await fetch(`${base(orgId)}/policy`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ policy: ConsentPolicy }>(res, 'getPolicy')).policy;
}

export async function setPolicy(orgId: string, input: { regulatedRegions: string[]; defaultMode: DefaultMode }): Promise<ConsentPolicy> {
  const res = await fetch(`${base(orgId)}/policy`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ policy: ConsentPolicy }>(res, 'setPolicy')).policy;
}

export async function listRecords(orgId: string): Promise<ConsentRecord[]> {
  const res = await fetch(`${base(orgId)}/records`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ records: ConsentRecord[] }>(res, 'listRecords')).records;
}

export async function getSubject(orgId: string, subjectKey: string): Promise<ConsentRecord | null> {
  const res = await fetch(`${base(orgId)}/subjects/${encodeURIComponent(subjectKey)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ record: ConsentRecord | null }>(res, 'getSubject')).record;
}

export async function deleteSubject(orgId: string, subjectKey: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/subjects/${encodeURIComponent(subjectKey)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteSubject returned ${res.status}`);
}
