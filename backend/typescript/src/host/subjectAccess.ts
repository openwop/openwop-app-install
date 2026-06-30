/**
 * Subject → caller access-level resolver (ADR 0054 D5) — a host seam that answers
 * "what may THIS caller do with this Subject's surfaces?" for subjects whose READ
 * visibility is membership-scoped (today: a `kind:'project'` Subject with
 * `visibility:'private'`).
 *
 * Distinct from `subjectOrgScope` (which derives a subject's *owning org* — orgId
 * — for org-DERIVATION, used by kanban + documents): this returns the resolved
 * ACCESS LEVEL for a specific caller, composing the org-scope authority
 * (`accessControl`) with the project's `visibility` + `members` (the project
 * feature owns those). The two seams are orthogonal and both kept.
 *
 * THE BOUNDARY (ADR 0045/0054): WRITE is ALWAYS org-scoped authority — membership
 * never grants write. Only READ gains a membership dimension (a read-ACL, the
 * `AdvisoryBoard.visibility` pattern), never an RBAC scope. The resolver MUST
 * encode that: `'write'` ⟺ the caller holds `workspace:write` in the owning org.
 *
 * FAIL-CLOSED for org-scoped subjects, fail-through for others: a subject with no
 * registered resolution returns `null` ⇒ NOT membership-scoped ⇒ the caller falls
 * back to the legacy tenant/personal gate (agents are tenant-global; personal
 * boards are owner-private, ADR 0025). Same safety argument as `subjectOrgScope`.
 *
 * @see docs/adr/0054-collaborative-project.md (D5)
 */

import type { Subject } from './subject.js';

export type AccessLevel = 'none' | 'read' | 'write';

/** Resolve the caller's access level for `subject`, or `null` when the subject is
 *  not membership/org-scoped (no resolver applies — use the legacy gate). */
export type SubjectAccessResolver = (tenantId: string, subject: Subject, callerSubject: string | undefined) => Promise<AccessLevel | null>;

let resolver: SubjectAccessResolver | null = null;

/** Register the resolver (called once at boot by the owning feature). */
export function setSubjectAccessResolver(fn: SubjectAccessResolver): void {
  resolver = fn;
}

/** The caller's access level for `subject`, or `null` when not org/member-scoped. */
export async function resolveSubjectAccess(tenantId: string, subject: Subject, callerSubject: string | undefined): Promise<AccessLevel | null> {
  return resolver ? resolver(tenantId, subject, callerSubject) : null;
}

/** True when `have` satisfies the `need` (read is satisfied by write). */
export function levelSatisfies(have: AccessLevel, need: 'read' | 'write'): boolean {
  return need === 'read' ? have === 'read' || have === 'write' : have === 'write';
}
