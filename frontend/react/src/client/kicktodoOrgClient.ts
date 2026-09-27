/**
 * KickTodo org-programs FE client (ADR 0428 P4) — React-free over
 * `/host/openwop-app/kicktodo/org-programs/:orgId/*`.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const BASE = `${config.baseUrl}/host/openwop-app/kicktodo/org-programs`;

export interface OrgLibraryView {
  library: { entries: Array<{ challengeId: string; version: number }> } | null;
  catalog: { curated: boolean; challenges: Array<{ id: string; version: number; title: string }> };
}

export interface OrgReportCell {
  circleId: string;
  challengeId: string;
  challengeVersion: number;
  outcome: { members: number; activeMembers: number; completedMembers: number; completionRate: number } | null;
  withheldReason?: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    // KTUX-1: fetchOpts must be CALLED — it folds `init` in AND adds
    // `credentials: 'include'` in cookie mode. The bare `...fetchOpts` spread the
    // function object, sending every request unauthenticated (401 in production
    // cookie mode). Same defect as KTEXP-1 in the studio client.
    ...fetchOpts(init),
    headers: { 'content-type': 'application/json', ...authedHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`org-programs request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getOrgLibrary(orgId: string): Promise<OrgLibraryView> {
  return await req(`/${encodeURIComponent(orgId)}/library`);
}

export async function setOrgLibraryEntry(orgId: string, challengeId: string, version: number, present: boolean): Promise<void> {
  await req(`/${encodeURIComponent(orgId)}/library`, { method: 'POST', body: JSON.stringify({ challengeId, version, present }) });
}

export async function getOrgReport(orgId: string): Promise<OrgReportCell[]> {
  return (await req<{ cells: OrgReportCell[] }>(`/${encodeURIComponent(orgId)}/report`)).cells;
}

/** ADR 0438 A4 — the admin People & access lens: AGGREGATES ONLY (no per-person
 *  rows, no cohort outcomes — those stay at their own consent-gated authorities). */
export interface AdminPeopleView {
  /** Distinct PEOPLE (subject-deduped across seats); byRole counts people per
   *  role (union across their seats); rolelessCount = people with no role. */
  members: { total: number; byRole: Array<{ role: string; count: number }>; rolelessCount: number };
  orgs: Array<{ orgId: string; name: string; memberCount: number; cohortLinkCount: number; libraryCurated: boolean }>;
  consent: { cohortAggregatesGated: boolean };
}

export async function getAdminPeople(): Promise<AdminPeopleView> {
  return await req('/admin/people');
}
