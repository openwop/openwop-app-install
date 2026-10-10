/**
 * ADR 0847 D1 — the ONE "may this caller reach this entities namespace" rule.
 *
 * Every type, taxonomy and relationship lives in a namespace: the workspace root
 * (`projectId` '') or an ADR 0046 project. A project has its own read visibility
 * (ADR 0054 D5), and five lanes reach the namespace: the session routes, the API-key
 * routes, the workflow surface, the chat tools and public delivery. Each used to check
 * the tenant only, so a private project's types and rows were open to every workspace
 * reader. This module is the rule; every lane imports it.
 *
 *   root namespace    → the tenant-level tier the lane already checks decides alone
 *   project namespace → that tier AND the project seam (`resolveSubjectAccess`) at
 *                       `need` for EVERY subject the lane names (act-as: the caller AND
 *                       the acting member — ADR 0797 narrowing). A missing or deleted
 *                       project, or an absent subject, is `'none'`.
 *
 * Project membership never grants write or authoring: WRITE on a project is
 * `workspace:write` in its org (the seam's own rule), and authoring additionally needs
 * the tenant-level `host:members:manage` the lane checks first.
 */
import { resolveTenantLevelScopes, type Scope } from '../../host/accessControlService.js';
import { resolveSubjectAccess, levelSatisfies } from '../../host/subjectAccess.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';

export type NamespaceNeed = 'read' | 'write';

/** May every subject in `subjects` reach namespace `projectId` at `need`? */
export async function namespaceAllows(
  tenantId: string,
  projectId: string | undefined,
  subjects: ReadonlyArray<string | undefined>,
  need: NamespaceNeed,
): Promise<boolean> {
  if (!projectId) return true;
  if (subjects.length === 0) return false;
  for (const subject of subjects) {
    const level = await resolveSubjectAccess(tenantId, { kind: 'project', id: projectId }, subject);
    // `null` = no project resolver registered: a project namespace with nobody to ask
    // fails CLOSED, never open.
    if (level === null || !levelSatisfies(level, need)) return false;
  }
  return true;
}

/** Keep only the rows whose namespace every subject may READ (list routes, list verbs).
 *  One seam call per distinct project, not per row. */
export async function filterReadableNamespaces<T extends { projectId: string }>(
  tenantId: string,
  rows: T[],
  subjects: ReadonlyArray<string | undefined>,
): Promise<T[]> {
  const verdict = new Map<string, boolean>();
  const out: T[] = [];
  for (const row of rows) {
    let ok = verdict.get(row.projectId);
    if (ok === undefined) {
      ok = await namespaceAllows(tenantId, row.projectId, subjects, 'read');
      verdict.set(row.projectId, ok);
    }
    if (ok) out.push(row);
  }
  return out;
}

/**
 * The in-run caller (workflow surface + chat tools). `actingUserId` is the run owner;
 * `orgScopeSubject` is the member who caused an actorless run and only ever narrows
 * (ADR 0832). With neither, the run is a system run (an `entity-written` binding, a
 * webhook): tenant-trusted in the root namespace, refused in a project namespace —
 * a visibility rule nobody can be checked against fails closed.
 */
export type RunCaller = { kind: 'person'; subject: string } | { kind: 'system' };

export function runCallerOf(scope: BundleScope): RunCaller {
  const subject = scope.actingUserId ?? scope.orgScopeSubject;
  return subject ? { kind: 'person', subject } : { kind: 'system' };
}

/** "A run is limited to its starter's access": the tenant-level tier (the routes' own
 *  resolver, so the ADR 0372 single-principal exit keeps anon sandboxes working) and
 *  the namespace rule. */
export async function runCallerAllows(
  tenantId: string,
  caller: RunCaller,
  projectId: string | undefined,
  need: NamespaceNeed,
): Promise<boolean> {
  if (caller.kind === 'system') return !projectId;
  const scope: Scope = need === 'write' ? 'workspace:write' : 'workspace:read';
  if (!(await resolveTenantLevelScopes(tenantId, caller.subject)).scopes.includes(scope)) return false;
  return namespaceAllows(tenantId, projectId, [caller.subject], need);
}

/** List filter for the in-run lanes. */
export async function filterRunReadable<T extends { projectId: string }>(tenantId: string, caller: RunCaller, rows: T[]): Promise<T[]> {
  if (caller.kind === 'system') return rows.filter((r) => !r.projectId);
  if (!(await resolveTenantLevelScopes(tenantId, caller.subject)).scopes.includes('workspace:read')) return [];
  return filterReadableNamespaces(tenantId, rows, [caller.subject]);
}
