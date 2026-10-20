/**
 * ADR 0137 Phase 4 + ADR 0930 — client for the ambient work-graph suggestions. Backend is
 * authority (org RBAC + per-person ownership): every read returns the CALLER's own
 * patterns only, and the pause is the caller's own.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface WorkflowSuggestion {
  suggestionId: string;
  tenantId: string;
  /** ADR 0930 — the owner key the pattern was mined under (always the caller's). */
  ownerPrincipal?: string;
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

const base = (orgId: string): string => `${config.baseUrl}/host/openwop-app/work-graph/orgs/${encodeURIComponent(orgId)}/suggestions`;

/** A failed call, carrying its HTTP status so the page can say what it means
 *  (grade-ux AWG2UX-9) instead of showing the server's English text. */
export class WorkGraphError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'WorkGraphError'; }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new WorkGraphError(detail || `${ctx} returned ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}
export async function listSuggestions(orgId: string): Promise<WorkflowSuggestion[]> {
  const res = await fetch(base(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ suggestions: WorkflowSuggestion[] }>(res, 'listSuggestions')).suggestions;
}
/** ADR 0930 A9 — a Scan reads the workspace's newest completed runs, up to a cap;
 *  `truncated` says older runs exist that it did not read. */
export interface ScanResult { suggestions: WorkflowSuggestion[]; paused: boolean; scanned: number; truncated: boolean }
export async function refreshSuggestions(orgId: string): Promise<ScanResult> {
  const res = await fetch(`${base(orgId)}/refresh`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<ScanResult>(res, 'refreshSuggestions');
}
const settingsUrl = (orgId: string): string => `${config.baseUrl}/host/openwop-app/work-graph/orgs/${encodeURIComponent(orgId)}/settings`;
/** ADR 0930 D7 — the caller's own pause. */
export interface WorkGraphSettings { paused: boolean; reason?: 'paused' | 'erased' }
export async function getWorkGraphSettings(orgId: string): Promise<WorkGraphSettings> {
  return asJson<WorkGraphSettings>(await fetch(settingsUrl(orgId), fetchOpts({ headers: authedHeaders() })), 'getWorkGraphSettings');
}
export async function setWorkGraphPaused(orgId: string, paused: boolean): Promise<{ paused: boolean }> {
  const res = await fetch(settingsUrl(orgId), fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ paused }) }));
  return asJson<{ paused: boolean }>(res, 'setWorkGraphPaused');
}
export async function dismissSuggestion(orgId: string, id: string): Promise<void> {
  await asJson(await fetch(`${base(orgId)}/${encodeURIComponent(id)}/dismiss`, fetchOpts({ method: 'POST', headers: authedHeaders() })), 'dismissSuggestion');
}
export async function acceptSuggestion(orgId: string, id: string): Promise<DraftSeed> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(id)}/accept`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return (await asJson<{ draftSeed: DraftSeed }>(res, 'acceptSuggestion')).draftSeed;
}
