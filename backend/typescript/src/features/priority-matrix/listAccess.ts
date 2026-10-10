/**
 * ADR 0842 D1 — the ONE "may this person read / write this priority list" rule.
 *
 * Priority lists are reached through five lanes: the HTTP routes, the Prioritization
 * Analyst's agent tools, the workflow surface, the managed KB and comment threads. The
 * routes were gated and graded PASS while the workflow surface answered every human-
 * started run as if it were the tenant, and the agent write tools skipped the project
 * gate the routes applied — three copies of one rule, two of them wrong. This module is
 * the rule; every lane imports it instead of re-deriving it.
 *
 *   READ  = `workspace:read` in the list's org  AND  (not project-bound, OR the project
 *           seam answers ≥ read for this person)
 *   WRITE = READ  AND  `workspace:write` in the list's org
 *
 * Membership never grants write (ADR 0054 D5): the project seam only narrows READ.
 *
 * `subject` is a REAL person here. An absent subject is answered by `resolveEffectiveAccess`
 * with the tenant-owner arm, which is right for the HTTP doors (they always pass
 * `userId ?? principalId`) and wrong for a lane that has nobody — so the agent tools and
 * the surface decide what "no person" means BEFORE they call in (tools: fail empty;
 * system runs: tenant-trusted), never by passing `undefined` through.
 */

import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { resolveSubjectAccess, levelSatisfies } from '../../host/subjectAccess.js';
import type { PriorityList } from './types.js';

/** PMX-14 (ADR 0590) — the org-scope predicate (the CRM `orgScopeGranted` pattern). */
export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

/** ADR 0610 D3′ — a project-bound list is membership-scoped; null from the seam means
 *  "not membership-scoped", so the org gate is the whole rule. */
export async function listProjectReadable(tenantId: string, list: PriorityList, subject: string | undefined): Promise<boolean> {
  if (!list.projectId) return true;
  const level = await resolveSubjectAccess(tenantId, { kind: 'project', id: list.projectId }, subject);
  return level === null || levelSatisfies(level, 'read');
}

/** May `subject` read `list`? (org read + project read) */
export async function canReadList(tenantId: string, list: PriorityList, subject: string | undefined): Promise<boolean> {
  return (await orgScopeGranted(tenantId, subject, list.orgId, 'workspace:read')) && (await listProjectReadable(tenantId, list, subject));
}

/** The route's 404/403 split, as a value: `'none'` (indistinguishable from missing),
 *  `'read'` (may read, may not write) or `'write'`. */
export async function listAccessLevel(tenantId: string, list: PriorityList, subject: string | undefined): Promise<'none' | 'read' | 'write'> {
  if (!(await canReadList(tenantId, list, subject))) return 'none';
  return (await orgScopeGranted(tenantId, subject, list.orgId, 'workspace:write')) ? 'write' : 'read';
}

/** ADR 0058 §8 — config authority (criteria/weights, delete, the per-voter ballots):
 *  the list creator, or `host:org:manage` in the list's org. */
export async function hasListConfigAuthority(tenantId: string, list: PriorityList, subject: string | undefined): Promise<boolean> {
  if (subject && list.createdBy === subject) return true;
  return orgScopeGranted(tenantId, subject, list.orgId, 'host:org:manage');
}
