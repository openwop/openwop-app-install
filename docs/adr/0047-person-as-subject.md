# ADR 0047 — Person as Subject (ADR 0045 Phase 4)

**Status:** implemented (recognition + security pass)
**Date:** 2026-06-15
**Toggle:** none.
**Depends on / composes:** ADR 0045 (the Subject model), ADR 0041/0042 (subject memory + knowledge),
ADR 0025 (user board/workflows/schedules), ADR 0006 (RBAC — the authority owner).
**Surface:** host-internal. **Host-only — no RFC.**

## Why this exists — and why it's small

ADR 0045 Phase 4 was "make the human `Profile` a `Subject` that owns the shared surfaces." The
honest finding: **it already is.** The incremental work (ADR 0041 memory, 0042 knowledge, 0025
board/schedules/workflows, and ADR 0045 Phases 1–2) realized the person-subject surface by
surface:

| Surface | Person owns it as | Where |
|---|---|---|
| memory | `{kind:'user', id}` | `profile-memory/routes.ts:33` (`selfSubject`) |
| knowledge | `Profile.knowledge` | `profilesService.ts` (ADR 0042) |
| board | `{kind:'user'}` (`ownerUserId`) | `kanbanService` (`ensurePersonalBoard`, `listBoardsForSubject`) |
| schedules | `{kind:'user'}` (`ownerUserId`) | `schedulingService` (`listJobsForSubject`) |
| workflows | `Profile.workflows[]` | `profilesService` (ADR 0025) |

So Phase 4 is **recognition + a security pass**, not a migration. The concrete deliverable is the
canonical projection (`personSubject(userId)`) and the explicit authority invariant.

## Decision

1. **`personSubject(userId)` is the canonical projection** of a human principal to a `kind:'user'`
   Subject (`host/subject.ts`). It is the only sanctioned way to obtain a person's owner key.
2. **The authority invariant (the security pass — ADR 0045's dominant constraint):** a `user`
   Subject is an **OWNER key, never an authenticated principal**. Constructing `personSubject(x)`
   grants nothing. Acting on a person's surfaces still requires EITHER the resolved person
   themselves (self-ownership — every `/profiles/me/*` route resolves `resolveCallerUser` and keys
   on the caller's OWN userId) OR a person with the RBAC scope in `accessControl`. **No surface
   reads authority from a Subject.**

## Security-pass evidence (already enforced + tested)

- **Memory:** per-user isolation — a caller sees/deletes only their OWN `user:<id>` memory
  (`profile-memory-route.test.ts` "per-user isolation"); anonymous → 401 (a Subject ≠ auth).
- **Knowledge:** self-ownership + org-scope IDOR (`profile-knowledge-route.test.ts`).
- **Board/schedules:** tenant isolation (`user-board-symmetry.test.ts`).
- **Twin (ADR 0044):** a person and their twin agent stay DISTINCT subjects with a grant edge —
  the Subject model does not merge principals, so 0044 is not regressed.

## What's NOT unified (deliberately — ADR 0045 §3)

- **Authentication** (sessions) and **authority** (RBAC scopes, org membership) stay with the
  `person` principal in `accessControl`. A `user` Subject never confers them.
- The frontend `ProfilePage` already renders the person's surfaces (My Board / Schedules / Memory /
  Knowledge) against the user-side of the unified backend — no "parallel plumbing" remains to
  collapse beyond what Phases 1–3 already did.

## Implementation status

| Item | Status |
|---|---|
| person-subject realized across surfaces | implemented (incrementally, recognized here) |
| `personSubject`/`rosterSubject` projections | implemented (`host/subject.ts`) |
| authority invariant + security-pass evidence | documented; enforced + tested |
