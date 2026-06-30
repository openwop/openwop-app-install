/**
 * ADR 0137 Phase 4 — client for the ambient work-graph suggestions. Backend is authority
 * (toggle + authorizeOrgScope); a 404 means the feature is off.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface WorkflowSuggestion {
  suggestionId: string;
  tenantId: string;
  signature: string;
  toolSequence: string[];
  count: number;
  exampleRunIds: string[];
  sampleGoal?: string;
  status: 'suggested' | 'accepted' | 'dismissed';
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface DraftSeed { name: string; toolSequence: string[]; sampleGoal?: string }
export interface Org { orgId: string; name: string }

const base = (orgId: string): string => `${config.baseUrl}/v1/host/openwop-app/work-graph/orgs/${encodeURIComponent(orgId)}/suggestions`;

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}
export async function listSuggestions(orgId: string): Promise<WorkflowSuggestion[]> {
  const res = await fetch(base(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ suggestions: WorkflowSuggestion[] }>(res, 'listSuggestions')).suggestions;
}
export async function refreshSuggestions(orgId: string): Promise<WorkflowSuggestion[]> {
  const res = await fetch(`${base(orgId)}/refresh`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return (await asJson<{ suggestions: WorkflowSuggestion[] }>(res, 'refreshSuggestions')).suggestions;
}
export async function dismissSuggestion(orgId: string, id: string): Promise<void> {
  await asJson(await fetch(`${base(orgId)}/${encodeURIComponent(id)}/dismiss`, fetchOpts({ method: 'POST', headers: authedHeaders() })), 'dismissSuggestion');
}
export async function acceptSuggestion(orgId: string, id: string): Promise<DraftSeed> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(id)}/accept`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return (await asJson<{ draftSeed: DraftSeed }>(res, 'acceptSuggestion')).draftSeed;
}
