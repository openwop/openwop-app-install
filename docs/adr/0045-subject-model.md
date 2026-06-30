# ADR 0045 — The Subject model: one owner abstraction for agents, people, and projects

**Status:** implemented (all 5 phases — Phases 1–2 here; `project` ADR 0046, `person` ADR 0047, capabilities ADR 0048. The `AgentRef` open question is RESOLVED: subjects only own surfaces, runs stay agent-attributed ⇒ host-only, no RFC.)
**Date:** 2026-06-15
**Toggle:** none for the foundation (a type refactor); per-kind surfaces (e.g. `project`) gate per their own ADR.
**Capability:** introduces the `capabilities[]` axis as the home for "what a subject can do" (folding `AgentCapabilityId`).
**Depends on / composes:** ADR 0041 (subject memory — already subject-keyed), ADR 0042 (subject knowledge),
ADR 0044 (twin — depends on agent ≠ person staying distinct principals), ADR 0025 (user work-surfaces),
ADR 0006 (RBAC / `accessControl` — the authority owner that MUST stay separate), ADR 0001, ADR 0031
(`agentProfile`). Touches `rosterService`, `profilesService`, `kanbanService`, `schedulingService`, the
workflow-assignment paths.
**Surface:** host-internal. **NON-NORMATIVE for the host refactor — no RFC** *(with one hard caveat at
Phase 5 — see RFC gate: if a non-agent subject becomes a run's `AgentRef`, that needs an RFC)*.

## Why this exists

The last four ADRs (0041 memory, 0042 knowledge, 0044 twin) each shipped an agent capability and then
**mirrored it onto the human profile** — a recurring tax. The cause: there are two base entities
(`RosterEntry` = agent, `Profile` = user) with *parallel* work surfaces (boards, workflows, schedules,
memory, knowledge), and no shared abstraction owning "who a surface belongs to."

A boundaries audit (2026-06-15, `/architect`) found the abstraction has **already re-emerged three times,
independently**, each reinventing a `{kind:'agent'|'user'}` discriminator:
- `kanbanService.ts:119` — `BoardOwner = {kind:'agent', rosterId} | {kind:'user', userId} | null` (+ `personalBoardId`, `:192`).
- `subjectMemory.ts:40` — `MemorySubject = {kind:'agent', id} | {kind:'user', id}` (ADR 0041).
- `schedulingService.ts:55` — `ScheduledJob.rosterId?` XOR an implied user owner.

No single type owns this; each surface pays for it and they can drift. This ADR **names the abstraction**
(`Subject`), unifies the scattered discriminators, and sets the rules so new subject *kinds* (`project`,
…) and the human profile become the *same* surfaces agents use — without collapsing the boundaries that
keep the system safe.

## The reframe (the core decision)

The proposal that prompted this was "extend *agent* to support `type[]` (persona/advisor/person/project)."
That inverts the dependency: an *agent* is the heavy cognitive thing (dispatch, persona, model-class,
autonomy, heartbeat); making a person a *kind of agent* drags all of that onto users. **Invert it:**

> The base is a **`Subject`** that *owns work surfaces*. "Agent-ness" (cognition) is a **capability** a
> subject may activate — not the base. A person is a Subject that is *also* an authenticated principal.
> A project is a *bare* Subject.

And **split the two axes the original `type[]` conflated**:
- **`kind`** — what a subject fundamentally IS: `person | agent | project | …` (extensible).
- **`capabilities[]`** — what it can DO: `cognition | advisor | assistant | knowledge | …` (folds
  `AgentCapabilityId`, `types.ts:336`). `advisor` is a *capability* (eligibility for an advisory board),
  NOT a kind.

```
Subject { id, tenantId, kind }
  owns →   board · workflows · schedules · memory · knowledge      (work-surface layer)
  may activate → capabilities[]   (cognition / advisor / assistant / knowledge / …)
```

Mapping the original proposal's "types": `persona` → `kind:'agent'` (cognition); `advisor` → a capability;
`person` → `kind:'person'` (+ principal); `project` → bare `kind:'project'`.

## The three layers — and the one that MUST NOT unify

| Layer | Examples | Unify across subjects? |
|---|---|---|
| **Work surfaces** | board, workflows, schedules, memory, knowledge | **YES — the whole point.** Memory/knowledge already are; boards/schedules are `kind`-aware already. |
| **Cognition** | dispatch, persona, model-class, autonomy, heartbeat | **NO — capability-gated.** Only a subject with the `cognition` capability (an `agent`, or a person's *twin*, ADR 0044). A project/person is NEVER heartbeat-dispatched. |
| **Authority / identity** | authn session, RBAC scopes, org membership | **NO — `person` only. The hard boundary.** |

### The authority invariant (the dominant constraint — acceptance criteria)
A `Subject` confers **no authority**. RBAC stays in `accessControl` (ADR 0006), keyed on `person`
principals only. The refactor is a CRITICAL failure if any of these is violated:
1. **No scope is ever read from a `Subject`** (only from a `person` principal via `accessControl`).
2. **An `agent`/`project` Subject is never treated as an authenticated caller** (no session, no implicit
   membership). Acting on a surface still requires a *person* with the scope, or the agent's ADR 0036
   policy + autonomy + (for cross-subject reads) an ADR 0044 grant.
3. **A person and their twin remain two distinct subjects** with a grant edge between them (ADR 0044 is
   *not* regressed by merging them).
4. **Cognition hard-gates on the capability/kind** — the heartbeat daemon, autonomy, and dispatch must
   refuse a non-`cognition` subject. A `project`'s `schedules` surface runs *workflows*, not agent turns.

## Phased plan

| Phase | Scope | Risk / gate | ADR |
|---|---|---|---|
| **1 — Name the abstraction** | Introduce `Subject = {kind, id}` + `subjectScope()`; refactor `BoardOwner`, `MemorySubject`, the schedule owner to *be* `Subject`. **No data migration, no behavior change** — pure consolidation. | Low; reversible. | this ADR |
| **2 — Re-key surfaces on `Subject`** | Boards + schedules + workflow-assignment own by `Subject` (they're already `kind`-aware). One implementation per surface. | **Gate: replay/fork determinism** on the re-keyed owners (opaque, stable). | this ADR |
| **3 — `kind:'project'`** | A bare Subject over the unified surfaces (its own board/schedules/workflows/memory). Net-new, additive, no migration. | Low; first visible payoff. | **ADR 0046** (forthcoming) |
| **4 — Person as Subject** | The human `Profile` becomes a `Subject` owning the shared surfaces; collapse the parallel ProfilePage plumbing. **`accessControl` authority + the session model stay entirely separate.** | **Gate: a security pass on the authority invariant above.** | **ADR 0047** (forthcoming) |
| **5 — Cognition + advisor as capabilities** | Fold `AgentCapabilityId`; express agent cognition + advisor on the Subject; `RosterEntry` becomes the `kind:'agent'` projection. | **Gate: `AgentRef` wire review** (RFC gate below). | **ADR 0048** (forthcoming) |

Phases 1–3 are mostly upside at low risk and drop the mirroring tax immediately; 4–5 carry the authority
and wire questions and therefore get their own ADRs + dedicated reviews. This ADR fully specifies 1–2;
3/4/5 are *named, sequenced placeholders*, authored when their phase begins (their design firms up as the
foundation lands — per ADR discipline we don't pre-author a decision whose shape isn't settled).

## Alternatives weighed

- **"Everything is an agent with `type[]`" (the original framing).** Rejected — drags cognition/heartbeat
  onto people and projects, and conflates `kind` (is) with `capabilities` (does). The Subject base + a
  cognition *capability* is the same flexibility without the bleed.
- **Leave it as-is (mirror per feature).** Rejected as the *default*, but it's the honest fallback if
  profiling shows the mirror tax is actually cheap (see Falsifiability). The last four ADRs are evidence
  against it.
- **Big-bang unification.** Rejected — the migration blast radius (kanban/scheduler/workflow/roster/
  profiles + replay-sensitive owners) demands phasing at real gates.

## RFC gate

**Host-only for Phases 1–4 — no RFC.** Subject is a host-side ownership abstraction; the scattered
discriminators it unifies are already host-ext; memory/knowledge owners are opaque (RFC 0048).
**Phase 5 caveat (loud):** `AgentRef` (persona + agentId) is a **wire** concept (RFC 0002), used for run
attribution. As long as only `kind:'agent'` subjects reach a run's agent slot, this stays host-only. **The
moment a `person` or `project` subject becomes addressable *as a run's agent*, run-event attribution
changes shape → a new RFC in `../openwop/` is required before that lands.** Decide early (see open
questions) — it changes the whole risk profile.

## Open questions (for sign-off)

- **Is a `person`/`project` ever a run's `AgentRef`?** If yes → RFC (Phase 5). If no (subjects only *own*
  surfaces; runs are still attributed to agents) → host-only throughout. **Decide before Phase 5.**
- **One `kind` or a `kind[]`?** Can a subject be both `person` and `agent` (a person who also dispatches)?
  Leaning single `kind` + capabilities for the "does" axis; revisit if a real dual-kind case appears.
- **Project authority.** A project has no principal — who acts on its surfaces? Proposed: a person with
  `workspace:write` in the project's org (project = an org-scoped work container), never the project itself.
- **Replay stability of re-keyed owners.** Boards/schedules carrying a `Subject` owner must serialize the
  owner opaquely + stably so `:fork` is deterministic (Phase 2 gate).

## Implementation status

| Phase | Status |
|---|---|
| 1 — name the abstraction | implemented (`host/subject.ts` — `Subject`/`subjectScope`; `MemorySubject` folded into `Subject`; `boardSubject`/`scheduleSubject` derivations; `subject.test.ts`; zero behavior change) |
| 2 — re-key surfaces | implemented (`listBoardsForSubject`/`listJobsForSubject` canonical owner queries; cascade + heartbeat routed through them; `listJobsByRoster`/`listJobsByUser` are now subject specializations. **Note:** assigned-workflow arrays are *entity-local* (`RosterEntry.workflows` / `Profile.workflows`) — no owner-keyed store to unify, so Phase 2 covers boards + schedules. Behavior-identical; storage unchanged ⇒ replay-safe.) |
| 3 — project (ADR 0046) | implemented (ADR 0046 — `features/projects/*`; board via generic `ownerSubject`, memory free via subject; proved a new kind is nearly free) |
| 4 — person-as-subject (ADR 0047) | implemented (ADR 0047 — recognition + security pass; the person was already a `kind:'user'` Subject across all surfaces; added `personSubject`/`rosterSubject` projections + the authority invariant) |
| 5 — cognition/advisor as capability (ADR 0048) | implemented (ADR 0048 — `AgentCapabilityId` gains `cognition`/`advisor`; kind↔capability orthogonality + `rosterSubject` agent projection; **wire gate resolved: no — subjects only own surfaces, `AgentRef` unchanged, host-only**. Dispatch/advisory gating on the flags = documented follow-ons.) |
