/**
 * Subject → owning-org resolver (ADR 0046 / ADR 0045) — a host seam that answers
 * "which org owns this Subject's surfaces?" for the surfaces whose visibility is
 * org-scoped (today: a project's kanban board).
 *
 * WHY a seam (not a stored `orgId` on the board): the owning org is DERIVED from
 * the board's `ownerSubject` — a `kind:'project'` board reads the project's
 * current `orgId`. Keeping it a live derivation means (a) no per-board `orgId`
 * column to migrate/backfill (existing project boards are protected immediately),
 * (b) the org can never drift from the project's, and (c) `core` (kanban) never
 * imports a `feature` (projects) — the feature FILLS this seam at boot, the same
 * way `kb` fills `setKnowledgeBackend`.
 *
 * A subject with no registered resolution (an `agent`/`user`, or projects
 * disabled) returns `null` ⇒ NOT org-scoped ⇒ the legacy tenant/personal board
 * visibility applies. Fail-open is safe here only because "no org" means "no
 * org-level restriction to enforce" — agents are tenant-global, personal boards
 * are owner-private (ADR 0025).
 *
 * @see docs/adr/0046-project-subject.md (read-privacy model)
 */

import type { Subject } from './subject.js';

/** Resolve the org that owns `subject`'s surfaces in `tenantId`, or `null` if the
 *  subject isn't org-scoped (or can't be resolved — e.g. the project was deleted). */
export type SubjectOrgResolver = (tenantId: string, subject: Subject) => Promise<string | null>;

let resolver: SubjectOrgResolver | null = null;

/** Register the resolver (called once at boot by the owning feature). */
export function setSubjectOrgResolver(fn: SubjectOrgResolver): void {
  resolver = fn;
}

/** The org that owns `subject`'s surfaces, or `null` when the subject is not
 *  org-scoped / no resolver is registered.
 *
 *  FAIL-OPEN INVARIANT: with no resolver this returns `null` ⇒ the board is
 *  treated as NOT org-scoped (legacy tenant/personal visibility). This is safe
 *  ONLY because the `projects` feature both (a) is the sole creator of
 *  `kind:'project'` boards and (b) registers the resolver at boot — so "no
 *  resolver" implies "no org-scoped board exists to protect." If a future change
 *  makes projects toggleable/lazy, register the resolver UNCONDITIONALLY (or
 *  fail closed here) so this gate can't silently reopen. */
export async function resolveSubjectOrg(tenantId: string, subject: Subject): Promise<string | null> {
  return resolver ? resolver(tenantId, subject) : null;
}
