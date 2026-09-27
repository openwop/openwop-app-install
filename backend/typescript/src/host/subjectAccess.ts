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

/** ADR 0278 — a PER-KIND registry. The original single-slot `set` seam meant the
 *  second registering feature silently clobbered the first (projects owned the
 *  slot; the advisory-board resolver would have knocked it out — or been knocked
 *  out — depending on boot order). Each owning feature registers for ITS kind;
 *  dispatch is by `subject.kind`; unregistered kinds fall through to `null`
 *  (the legacy tenant/personal gate), exactly as before. */
const resolvers = new Map<string, SubjectAccessResolver>();

/** Register the resolver for one subject KIND (called once at boot by the
 *  owning feature — projects for `'project'`, advisory-board for `'board'`). */
export function registerSubjectAccessResolver(kind: string, fn: SubjectAccessResolver): void {
  resolvers.set(kind, fn);
}

/** The caller's access level for `subject`, or `null` when not org/member-scoped. */
export async function resolveSubjectAccess(tenantId: string, subject: Subject, callerSubject: string | undefined): Promise<AccessLevel | null> {
  const fn = resolvers.get(subject.kind);
  return fn ? fn(tenantId, subject, callerSubject) : null;
}

/** True when `have` satisfies the `need` (read is satisfied by write). */
export function levelSatisfies(have: AccessLevel, need: 'read' | 'write'): boolean {
  return need === 'read' ? have === 'read' || have === 'write' : have === 'write';
}

// ── KBC-1 (ADR 0643 D2 precondition) — the caller, for a REQ-LESS gate ───────

/**
 * WHO IS ASKING, for a subject-gated read/write taken OUTSIDE an HTTP handler.
 *
 * `resolveSubjectAccess` wants a caller-subject string, and every existing call
 * site got one from `callerSubject(req)`. That is exactly why the ADR 0608 gate
 * ended up mounted on the HTTP door only: a workflow run, an agent chat turn and
 * an in-process indexer have no `req`, so there was no shape to hand them and
 * they read straight past the gate. This is that shape.
 *
 * Two states, and NEITHER of them is "trust me":
 *
 *  - `{ subject }` — a real principal. `undefined` is a legitimate value and it
 *    means THERE IS NO ACTING USER (a schedule-fired or inbound-webhook run,
 *    `BundleScope.actingUserId` absent by construction). It resolves like any
 *    other unknown caller, which for a membership-scoped subject is `'none'` ⇒
 *    REFUSED. Fail-closed is the whole point: a system run has no membership, so
 *    it may not read a membership-scoped corpus.
 *  - `{ preAuthorized: true }` — the lane resolved this subject's access at its
 *    OWN door and is re-entering the service (the project/notebook doors, which
 *    gate on project membership before they touch KB), or the lane is an
 *    in-process derived-index owner writing rows it minted itself. It is spelled
 *    explicitly, at the call site, so `grep PREAUTHORIZED_CALLER` enumerates
 *    every bypass — unlike an omitted argument, which enumerates nothing.
 *
 * OMITTING the caller is `{ subject: undefined }`, never `preAuthorized`. A call
 * site that forgets therefore gets a REFUSAL on a bound collection, not a silent
 * bypass — the direction a forgotten gate must fail in.
 */
export interface SubjectCaller {
  /** The acting principal (`callerSubject(req)` / `BundleScope.actingUserId`). */
  subject?: string;
  /** This lane already resolved the subject's access at its own door. */
  preAuthorized?: true;
}

/** The explicit, greppable bypass — see {@link SubjectCaller}. */
export const PREAUTHORIZED_CALLER: SubjectCaller = { preAuthorized: true };

/**
 * May `caller` READ a resource owned by `subject`?
 *
 * ── THE NO-SUBJECT CASE IS REFUSED HERE, NOT DELEGATED (measured) ────────────
 *
 * A caller with no `subject` MUST NOT be handed to `resolveSubjectAccess`, and
 * the reason is a fail-open one level down that is invisible from this file:
 * `resolveProjectAccess` calls `resolveEffectiveAccess(tenantId, { subject })`,
 * and when `subject` is `undefined` that function takes its LAST branch —
 * "No member context → the tenant owner principal, implicitly `owner`"
 * (`accessControlService.ts`) — returning the full OWNER scope set. `levelFor`
 * then sees `workspace:write` and answers `'write'`. So "nobody" resolves to
 * "the owner", and a system run would have read every private project in the
 * tenant.
 *
 * That branch is correct where it lives: an internal call with no member context
 * IS the tenant-owner principal. It is only wrong when the absent subject means
 * "there is no human here", which is exactly what `BundleScope.actingUserId`
 * being absent means for a schedule-fired or webhook-fired run. Nothing in the
 * resolver chain can tell those two apart, so the distinction has to be made by
 * whoever knows it — here, at the point the caller is constructed.
 *
 * Verified by a born-red leg (`kb-service-subject-gate.test.ts`, "a SYSTEM run
 * (no acting user) is refused"): without this line the system run reads the
 * private corpus, and it reads it THROUGH the ADR 0608 resolver, green.
 *
 * `null` from the resolver keeps its established meaning — the kind is not
 * membership-scoped, so org scope was the whole rule — which is the same
 * fall-through `kb/routes.ts` has used since ADR 0608 D4. Parity is deliberate:
 * the route gate stays mounted as defence in depth, and two gates that disagree
 * about the same row would be worse than one.
 */
export async function subjectReadAllowed(tenantId: string, subject: Subject, caller: SubjectCaller | undefined): Promise<boolean> {
  if (caller?.preAuthorized) return true;
  if (caller?.subject === undefined) return false; // no acting principal ⇒ no membership ⇒ refused (see above)
  const level = await resolveSubjectAccess(tenantId, subject, caller.subject);
  return level === null || levelSatisfies(level, 'read');
}
