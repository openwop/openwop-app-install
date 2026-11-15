/**
 * ADR 1123 — add a person who already has an account to an org, and link an
 * unbound roster row to one. The client never sends a subject: it sends a
 * `candidateId` the server handed out, or a superadmin's `lookupToken`.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { ApiError } from '../client/requestJson.js';
import type { OrgMember } from '../client/accessClient.js';

export interface MemberCandidate { candidateId: string; displayName: string; email?: string }
export interface LookupCandidate { lookupToken: string; displayName: string; email?: string }
/** Who to add: a picked candidate, or a superadmin's looked-up account. */
export type Addee = { candidateId: string } | { lookupToken: string };

const base = `${config.baseUrl}/host/openwop-app/orgs`;
const headers = () => ({ 'content-type': 'application/json', ...authedHeaders() });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    let detail = '';
    try {
      body = await res.json();
      const b = body as { error?: { message?: string }; message?: string };
      detail = b?.error?.message ?? b?.message ?? '';
    } catch { /* non-JSON error body */ }
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, body, message: detail || `${ctx} returned ${res.status}` });
  }
  return (await res.json()) as T;
}

/** The people the caller may add (`for: 'link'` keeps the org's own members). */
export async function listMemberCandidates(orgId: string, purpose: 'add' | 'link' = 'add'): Promise<MemberCandidate[]> {
  const q = purpose === 'link' ? '?for=link' : '';
  const res = await fetch(`${base}/${encodeURIComponent(orgId)}/member-candidates${q}`, fetchOpts({ headers: headers() }));
  return (await asJson<{ candidates: MemberCandidate[] }>(res, 'GET member-candidates')).candidates;
}

/** Superadmin only: one exact address. `null` = nothing to add. */
export async function lookupMemberByEmail(orgId: string, email: string): Promise<LookupCandidate | null> {
  const res = await fetch(`${base}/${encodeURIComponent(orgId)}/member-lookup`, fetchOpts({ method: 'POST', headers: headers(), body: JSON.stringify({ email }) }));
  return (await asJson<{ candidate: LookupCandidate | null }>(res, 'POST member-lookup')).candidate;
}

export async function addExistingMember(orgId: string, who: Addee, roles: string[]): Promise<OrgMember> {
  const res = await fetch(`${base}/${encodeURIComponent(orgId)}/members/add-existing`, fetchOpts({ method: 'POST', headers: headers(), body: JSON.stringify({ ...who, roles }) }));
  return asJson<OrgMember>(res, 'POST members/add-existing');
}

export async function linkMember(orgId: string, memberId: string, who: Addee): Promise<OrgMember> {
  const res = await fetch(`${base}/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}/link`, fetchOpts({ method: 'POST', headers: headers(), body: JSON.stringify(who) }));
  return asJson<OrgMember>(res, 'POST members/link');
}
