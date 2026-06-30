/**
 * The Subject — one owner abstraction (ADR 0045) for the WORK-SURFACE layer:
 * boards, schedules, workflows, memory, knowledge. A `Subject` answers "who owns
 * this surface," and nothing more.
 *
 * It names the discriminator the codebase had independently reinvented per
 * surface — `BoardOwner` (`kanbanService`), `MemorySubject` (`subjectMemory`),
 * and the `rosterId`-XOR-`ownerUserId` owner on schedules. Phase 1 introduces the
 * canonical type + the per-surface derivations; Phase 2 re-keys the surfaces onto
 * it (no migration: storage fields are unchanged, this is the in-memory owner view).
 *
 * BOUNDARY (ADR 0045 — the hard rule): a Subject confers NO authority. RBAC stays
 * `person`-only in `accessControl` (ADR 0006). Nothing reads a scope from a
 * Subject; an `agent`/`project` Subject is never an authenticated caller.
 *
 * @see docs/adr/0045-subject-model.md
 */

/** What a subject fundamentally IS. `'project'` is reserved for ADR 0046 Phase 3;
 *  memory/knowledge already accept it (forward-compatible). The "what it can DO"
 *  axis (cognition / advisor / …) lives separately on `capabilities[]`. */
export type SubjectKind = 'agent' | 'user' | 'project';

/** The owner of a work surface — a `kind` + an opaque `id`. */
export interface Subject {
  kind: SubjectKind;
  id: string;
}

/** Stable, opaque scope string `${kind}:${id}` — the memory namespace (RFC 0004
 *  `memoryRef`) and the canonical owner key. Deterministic ⇒ replay-safe; never
 *  re-resolved. `agent:<id>` / `user:<id>` are byte-identical to the legacy
 *  per-surface scopes, so existing data + paths are unchanged. */
export function subjectScope(subject: Subject): string {
  return `${subject.kind}:${subject.id}`;
}

// ── canonical projections (ADR 0045/0047) ────────────────────────────────────
// The base entities project to a Subject. A `person` projects to `kind:'user'`,
// a roster agent to `kind:'agent'`, a project to `kind:'project'`. These are the
// ONLY way to obtain a Subject from a principal/agent/project id — so the
// "a Subject confers no authority" boundary is auditable (a Subject is an *owner*
// key; RBAC stays on the `person` principal in `accessControl`).

/** A human user as a Subject (ADR 0047). NOTE: a `user` Subject is an OWNER key,
 *  NOT an authenticated principal — authority comes from `accessControl` on the
 *  resolved person, never from constructing this. */
export function personSubject(userId: string): Subject {
  return { kind: 'user', id: userId };
}

/** A standing roster agent as a Subject (ADR 0045). */
export function rosterSubject(rosterId: string): Subject {
  return { kind: 'agent', id: rosterId };
}
