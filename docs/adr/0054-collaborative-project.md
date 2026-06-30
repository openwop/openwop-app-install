# ADR 0054 — The collaborative project (charter, membership, group chat)

**Status:** implemented (Phases 1–4). Phase 4 (moderator/turn policy) built per D6 — the project chat reuses the ADR 0040 cadence primitive (shared `host/turnPolicy.ts` validator + `planBoardroomTurns`/`useBoardroomCadence`); explicit Convene; cohort cap 8; moderator-must-be-a-member; host-extension, no RFC. Read-privacy fork DECIDED 2026-06-16 — member-scoped via an additive `visibility` field + a generalized `subjectAccess` seam; see D5.
**Date:** 2026-06-16
**Extends:** ADR 0046 (the `project` Subject) · **Composes:** ADR 0043 (persistent conversations), ADR 0040 (advisory-board multi-agent convene), ADR 0006 (accessControl / RBAC), ADR 0045 (Subject model) · **Generalizes:** `host/subjectOrgScope.ts` (ADR 0046) → `subjectAccess`
**Toggle:** none — **graduated to always-on 2026-06-16** (§ Correction below). The
collaborative additions originally gated behind a **`project-collab`** toggle (default OFF,
`bucketUnit: tenant`) "during rollout"; rollout is complete and the toggle is retired.

## Correction (2026-06-16) — `project-collab` retired (always-on)

The collaborative surfaces (members, `private` visibility, group chat) shipped behind a
`project-collab` toggle (default OFF) "during rollout". That rollout is now complete: the
toggle is **removed** and these surfaces are **always-on**, consistent with the base
`projects` feature (which graduated 2026-06-15) and the agent-knowledge graduation the same
week. This is safe because the toggle never gated *authority* — every collaborative WRITE
still goes through `requireProject('workspace:write')` (org-scoped; membership never grants
authority, ADR 0045), and a `private` project stays read-gated to its members + org writers
via the `subjectAccess` seam (D5). With the toggle gone, the only behavioural change is that
operators no longer have to flip it on to add members / make a project private.

Mechanics: drop the `registerToggleDefault({ id: 'project-collab' … })` call in
`features/projects/feature.ts`; remove the `requireFeatureEnabled` gate from the 4 collab
routes in `routes.ts` (members POST/DELETE, visibility PATCH, chat POST); add
`'project-collab'` to `RETIRED_TOGGLE_IDS` (boot-time override cleanup); the frontend
`ProjectDetailPage` renders the Members + Chat tabs unconditionally. References below to the
`project-collab` toggle / "gated on `project-collab`" / "Toggle stays OFF" predate this.

## Why this exists

A `project` is already a `kind:'project'` Subject (ADR 0045/0046) that OWNS the same work
surfaces an agent or person does — board, subject-memory, subject-knowledge, assigned
workflows, schedules — because all three are **Subjects that own surfaces**, NOT because a
project subtypes an agent. What it is missing is the *collaboration* layer that makes it a
place people and agents work *together*: a **charter** (goals/dates/health), an explicit
**membership** of people + agents, and a **shared conversation** for the team.

The load-bearing finding (boundaries audit, below): **none of this is new infrastructure.**
The conversation system (ADR 0043) already models a multi-participant `group` chat of people
+ agents; the advisory-board convene (ADR 0040) already orchestrates a *cohort* of agents in
one thread; `accessControl` (ADR 0006) already owns authority. This ADR **binds** a project to
those systems and adds **additive metadata** — it builds no parallel chat, no parallel auth,
no parallel agent roster.

**The hard rule carried from ADR 0045 (do not regress):** a project has **no cognition and no
authority of its own.** Authority to act on a project stays person-only in `accessControl` (a
person with `workspace:write` in the project's org acts on it). Project membership is
*descriptive* (who's on the team + their project role label) — it is NOT a second RBAC surface.

## Boundaries audit (compose, don't fork)

| Need | Single owner — composed | Evidence |
|---|---|---|
| Group chat (people + agents, persistent) | `ConversationMeta` (ADR 0043) — `type: 'agent'\|'person'\|'group'\|'workspace'`, `participants: ConversationParticipant[]` with `subjectRef` (`user:<id>` / `agent:<id>`), per-participant `lastReadAt` | `host/conversationStore.ts:51-67`; `SubjectRef` is forward-compatible (the `project:` ref already slots into the scheme) |
| Bind a conversation to a container | `boardId?` + `markAsBoardGroup(tenantId, convId, boardId, participants, ownerUserId)` promotes an agent chat → a group bound to a container | `conversationStore.ts:63,143`; route `chatSessions.ts` `POST …/:sessionId/board` |
| Convene a cohort of agents in one thread | advisory `advisors: string[]` (roster ids) + optional `moderatorRosterId`; the board is *only a cohort definition* — the chat runs over existing `chat.turn` infra; cross-agent turns are narrative-cast `[Name]:` | `features/advisory-board/{types,service}.ts`; `host/conversationExchange.ts:68-81` (`turnsToMessages`), `agentPromptScaffold.ts` |
| Membership / authority | `accessControl` — `OrgMember {subject, orgId, roles, teamIds}`, `Group` (RBAC unit, carries roles), `Team` (descriptive, **no** authority), `resolveEffectiveAccess` | `host/accessControlService.ts:188-222,927` |
| Project entity + Subject surfaces | `features/projects` — board/memory/knowledge/workflows/schedules via the Subject; `projectSubject(id)` | `features/projects/projectsService.ts:27-62` |
| "Agents on a container" precedent | advisory `advisors[]` (roster ids), board↔roster binding (RFC 0086), project `workflows[]` | as above |

**No collision, no duplication.** Today there is **no** project membership, **no** project
metadata, and **no** project conversation — the work is *additive fields + a binding + a
generalized container→conversation seam*.

## Decision

### D1 — Charter / definition (additive metadata on the project)
Add an optional `charter` sub-object to the `Project` entity (additive; absent ⇒ unchanged):
```ts
interface ProjectCharter {
  goal?: string;            // the one-line outcome
  objectives?: string[];    // measurable sub-goals
  brief?: string;           // free-text charter / context (markdown)
  startDate?: string;       // ISO-8601
  endDate?: string;         // ISO-8601 (target)
  status?: 'planning' | 'active' | 'paused' | 'done' | 'archived';
  health?: 'on-track' | 'at-risk' | 'off-track';
  milestones?: Array<{ id: string; title: string; dueDate?: string; done: boolean }>;
}
```
Rationale for a sub-object (not flat fields): it keeps the charter a single optional unit, is
cheap to validate/cap, and reads as "the project's definition" in the UI Overview tab. PATCH
via the existing `/projects/:id` route (extend `updateProject`); gated on `workspace:write`.

### D2 — Membership (descriptive roster; authority stays org-scoped)
Add an optional `members` roster to the `Project` entity:
```ts
type ProjectRole = 'lead' | 'contributor' | 'observer';
interface ProjectMember {
  ref: SubjectRef;          // 'user:<userId>' | 'agent:<rosterId>'  (reuse ADR 0043's vocab)
  role: ProjectRole;        // DESCRIPTIVE label — NOT an RBAC scope
  addedAt: string;
}
```
- **People** are referenced by `user:<userId>`; **agents** by `agent:<rosterId>` (the advisory
  `advisors[]` precedent + ADR 0043's `SubjectRef`). One vocabulary, no new id scheme.
- **WRITE authority is unchanged and never membership-derived:** to mutate a project (charter,
  members, board, …) the caller ALWAYS needs `workspace:write` in the project's `orgId` (the gate
  `requireProject` already enforces). Membership NEVER grants write. `ProjectRole` is a *label*
  (like accessControl's `Team`), not a scope — `resolveEffectiveAccess` is never consulted for it.
  This is the ADR 0045 boundary: a project confers no *authority*. (READ *visibility* is a separate
  axis that membership DOES influence — see D5; that is a read-ACL, not authority.)
- A people-member SHOULD be an org member of the project's org (validated on add — can't add a
  stranger); an agent-member SHOULD be a tenant roster entry (validated on add). Removing a
  member is descriptive only for authority (does not revoke org write); for a `private` project it
  also removes read visibility (D5).

### D3 — Project group chat (bind the project to ONE group conversation)
- Add an optional **`ownerSubject?: Subject`** to `ConversationMeta` (the generic container
  binding — the same `ownerSubject` move boards/memory/schedules already made; supersedes the
  advisory-specific `boardId` over time, which stays for back-compat). A project's chat is a
  `type:'group'` conversation with `ownerSubject = {kind:'project', id}`.
- Generalize `markAsBoardGroup` → **`bindConversationToSubject(tenantId, conversationId, ownerSubject, participants, ownerUserId)`** (advisory keeps a thin wrapper). The project's chat is
  ensured idempotently and bound to `project:<id>`; participants are seeded from `members[]`
  (people + agents).
- **Convene reuses ADR 0040 verbatim:** the project's *agent* members are a cohort; convening
  them is the existing `@@`/lineup expansion — they reply in the one thread, narrative-cast
  `[Name]:`, over `conversationExchange`. No project-specific turn logic. (A project may name a
  moderator agent later — deferred, mirrors advisory `moderatorRosterId`.)
- **Persistence + read-state** are the conversation system's (durable `messages` channel,
  `lastReadAt` per participant) — nothing new.
- **Who can open/read the project chat** is the project's read gate (D5): an `org`-visible
  project's chat is readable by org readers; a `private` project's chat by its members (+ org
  writers). The chat is just another project-owned surface, so it inherits the same `subjectAccess`.

  > **Correction (Phase 3 follow-up, code-review):** the first Phase 3 cut gated only the
  > *ensure* route (`POST /projects/:id/chat`) via `requireProject`; the conversation's actual
  > data lives behind the generic `chat/sessions/:id(/messages)` routes, which gated on the
  > ADR 0043 Phase 6 *participant/owner* heuristic — wrong for a project chat, which seeds only
  > the project's AGENTS as participants. That both **excluded non-owner people-members** (the
  > shared room wasn't shared) and **admitted a removed owner**. Fixed by making the
  > chat-session READ gate (`requireVisibleAsync`) and MANAGE gate (`requireManageAsync`)
  > consult `resolveSubjectAccess` whenever a conversation carries an `ownerSubject`: members
  > read, non-members + removed owners are denied, and MANAGE (rename/delete/participant
  > mutation) requires org WRITE — never mere membership (the D5 boundary). Non-subject
  > conversations (agents, DMs, personal boards) fall through to the legacy gate unchanged.

### D5 — Visibility & the `subjectAccess` seam (the read-privacy decision)

**Decision (2026-06-16, `/architect`): projects support member-scoped visibility, done additively.
The reframe that makes this clean: visibility ≠ authority.**

- Add **`visibility: 'org' | 'private'`** to the `Project` entity, **default `'org'`**. So every
  existing project + all current behaviour is unchanged (no migration, no surprise); `'private'`
  is purely opt-in. This is the same shape as `AdvisoryBoard.visibility` (`private`/`shared`) — a
  resource read-ACL, NOT an RBAC scope.
- **The two axes stay orthogonal:**
  - **WRITE** (mutate the project + any owned surface) = `workspace:write` in the project's org,
    ALWAYS. Membership never grants write. (ADR 0045 boundary — untouched.)
  - **READ** (see the project + any owned surface) = `subjectAccess(...)` resolves to `read` when
    the caller has org-write, OR `visibility === 'org'` && org-read, OR
    `visibility === 'private'` && caller ∈ `members[]` (people). Agents in `members[]` are a cohort
    list, never callers (ADR 0045) — they never gate a human's read.
- **Generalize the seam, don't scatter gates.** `host/subjectOrgScope.ts` (the ADR 0046 seam that
  already derives a board's owning org from its `ownerSubject`) becomes a single
  `subjectAccess(tenantId, subject, caller) → 'none' | 'read' | 'write'` resolver. **Every
  project-owned surface read** — board cards, memory, knowledge, schedules, AND the group chat —
  routes its read gate through this ONE seam. So a `private` project cannot leak through any
  surface *by construction* (this closes, structurally, the exact class of gap PR #325 fixed for
  org-scoped boards). The projects feature fills the seam (it owns `members`/`visibility`);
  `accessControl` remains the sole owner of authority; the seam *composes* them — no second owner.
- **Sequenced into Phase 2 (membership), NOT deferred.** Membership is the input the read gate
  consumes; shipping descriptive-only membership first and retrofitting visibility later would be a
  behaviour migration (org-visible projects silently becoming private). Because the field defaults
  to `'org'`, landing it WITH membership is fully additive and avoids that retrofit.
- **Replay/fork:** visibility is a read-time filter, never stamped on a run (like the twin grants,
  ADR 0044 §4) — no replay concern.

### D4 — Frontend
- **Project detail** gains an **Overview** tab (charter: goal/objectives/dates/health/milestones,
  editable for writers) — becomes the default tab — and a **Members** tab (add/remove people +
  agents, set project role, **+ the `org`/`private` visibility control**). Composes the shared
  `ui/` primitives.
- A **"Open project chat"** affordance on the project deep-links the project's group conversation
  (create-or-resume), pre-populating the lineup with the project's agent members. The conversation
  surfaces in `ConversationsRail` under the existing **Groups** section (or a new **Projects**
  section) — reusing the one chat UI; no second chat surface.

### D6 — Moderator + turn policy (Phase 4): reuse the cadence primitive, don't fork it

**Decision (2026-06-16, `/architect`). The project chat gains structured multi-agent turns by
REUSING the ADR 0040 boardroom-cadence primitive verbatim — a project supplies a cohort + policy
to the SAME planner + driver. No parallel cadence system, no second turn-policy validator.**

The cadence machinery is already subject-agnostic:
- `frontend/.../conversations/boardroomCadence.ts:planBoardroomTurns(cohort, policy)` is **pure**:
  `{chairAgentId, advisorAgentIds[]}` + `{rounds, order, synthesize}` → an ordered `BoardroomTurn[]`.
  Nothing board-specific.
- `useBoardroomCadence.ts` consumes a *pre-planned* `BoardroomTurn[]` and self-clocks one turn at a
  time on the existing `send()` path. Its "only from a board summon" comment is a usage convention,
  not a coupling.
- The only board-coupled code is the glue at `ChatSidebar.tsx:375–419` (`@@<handle>` → `getBoardByHandle`
  → `planBoardroomTurns` → `cadence.start`). Phase 4 adds a **sibling project branch** to that glue;
  the planner + driver are reused 1:1. (Per the *no-parallel-architecture* law: extend the primitive,
  don't shadow it.)

Decisions on the three forks:

1. **Trigger — EXPLICIT convene, not auto-on-every-message.** A project chat does NOT fan out on every
   user turn. A deliberate **"Convene" affordance** (mirroring the deliberate `@@` summon) runs ONE
   cadence pass. Forces: blast-radius/cost + consistency with the advisory precedent (which is already
   an explicit `@@` trigger). Auto-on-broadcast is rejected — surprise cost, hard to stop.

2. **Convened-cohort CAP — bound it; do NOT convene all members.** Projects cap membership at
   `MAX_MEMBERS = 100` (`projectsService.ts:71`); advisory caps the cohort at `8`
   (`service.ts:26`) precisely for cadence cost. Convening 100 agents × up to 3 rounds = ~300
   sequential turns from one click — a fan-out hazard the scale introduces. The convened cohort
   therefore reuses the advisory `8` cap (first N agent members, or an explicit chat-lineup subset).
   This is the one place the project's larger membership model and the cadence's cost model must be
   reconciled, and it is reconciled in favour of the cost cap.

3. **Moderator — MUST be a project agent member** (with the workspace-assistant fallback when unset),
   validated via `getRosterEntry` (in-tenant) AND `members` containment. This is **stricter than
   advisory** (which allows any in-tenant roster agent as `moderatorRosterId`): a moderator who speaks
   in the project room but isn't "on" the project is incoherent, and it keeps `members[]` the single
   source of truth for who is in the room. The divergence is deliberate.

4. **Policy SOURCE — read from the project at convene time; do NOT denormalize onto `ConversationMeta`.**
   The board reads `turnPolicy` from the board each time (the meta carries only `boardId`); the project
   mirrors this — the conversation carries `ownerSubject` (already), and the cadence reads
   `moderatorRosterId` + `turnPolicy` from the project. Copying the policy onto the meta would create a
   second owner that drifts (single-source-of-truth).

**Boundaries / single-source-of-truth:** the `turnPolicy` VALIDATOR (advisory `readTurnPolicy`,
clamp rounds∈[1,3], order default `declared`, synthesize default `true`) is **extracted to one shared
host helper** (`host/turnPolicy.ts`) consumed by BOTH advisory and projects — two callers, one
validator (avoids the orgs↔accessControl second-owner trap). The `turnPolicy` *value* living on both
`AdvisoryBoard` and `Project` is fine (two entities each carry a policy); only the validator + planner
must be single-sourced — and both are. If a THIRD convener ever appears, extract a shared `CohortPolicy`
type then (YAGNI until then).

**Wire / RFC verdict:** host-extension only. No OpenWOP wire surface (no run-event field, capability
flag, or event type); the cadence is host-orchestrated client-side over the existing `chat.turn` /
messages path, so `:fork`/replay are unaffected. **No new RFC.** Rides the existing `project-collab`
toggle (no new toggle). No new route — the two fields ride the existing additive `PATCH /projects/:id`.

## Phased plan

| Phase | Scope | Surface | Gate |
|---|---|---|---|
| 1 — Charter | `Project.charter` + `updateProject` validation + caps; Overview tab (read/edit) | host-ext `PATCH /projects/:id`; FE Overview tab | `npm test` + build |
| 2 — Membership **+ visibility (D5)** | `Project.members[]` + `Project.visibility` (default `'org'`) + add/remove/set-role routes (validate user∈org, agent∈roster); **generalize `subjectOrgScope` → `subjectAccess`** and route EVERY project-owned-surface read (board / memory / knowledge / schedules) through it; Members tab + a private/org visibility control | host-ext `/projects/:id/members*` + `PATCH …/visibility`; the `subjectAccess` seam; FE Members tab | route tests: write always org-scoped (membership never grants write); a `private` project is 404 for a non-member on the project AND its board/memory/knowledge/schedules (no surface leak); an `org` project unchanged; can't add a stranger |
| 3 — Group chat | `ConversationMeta.ownerSubject`; `bindConversationToSubject` (advisory wrapper preserved); project-chat ensure/open route gated via `subjectAccess`; deep-link + rail surfacing; convene project agents via the ADR 0040 lineup | host-ext chat-session binding; FE deep-link | route test: project chat bound to `project:<id>`, members seeded, read-gated by `subjectAccess`; convene fires existing exchange |
| 4 — moderator + turn policy (D6) | optional `Project.{moderatorRosterId, turnPolicy}` (additive on `PATCH /projects/:id`); **extract** advisory's turn-policy validator → shared `host/turnPolicy.ts`; a **project branch** in the `ChatSidebar` cadence glue reusing `planBoardroomTurns`/`useBoardroomCadence` (no fork); explicit **Convene** affordance; convened cohort capped at 8; moderator MUST be a project agent member; FE chat-policy controls (mirror advisory) | host-ext `PATCH /projects/:id`; FE cadence glue + controls | route tests: turnPolicy validation/caps, moderator∈members (else 422/404), write-gated; cadence test: a project group plans the same turns as the board planner |

**Core-app extension surface:** `ctx.features.projects` could later expose read-only project
context (charter/members) to workflows; node/agent packs — **none** day-1 (this is a
collaboration surface, not an AI-authoring surface). Honestly stated, not deferred-by-omission.

## Alternatives weighed

- **Project-scoped RBAC roles (membership confers WRITE/authority).** Rejected — a second
  authorization surface beside `accessControl` (the orgs↔accessControl collision class); violates
  ADR 0045's "no authority of its own" + single-source-of-truth. Note the careful line (D5):
  member-scoped **READ visibility** is adopted (a read-ACL, precedented by `AdvisoryBoard.visibility`)
  — member-scoped **WRITE authority** is NOT. Write stays org-scoped; only read gains a membership
  dimension, resolved by the one `subjectAccess` seam.
- **Defer privacy / ship descriptive-membership-only first (the original v1).** Rejected by the
  `/architect` pass: "every org member sees every project" is the wrong default for a *collaborative
  environment* and the exception across the category (Linear/Asana/Notion/Jira/Basecamp default
  projects to member/team-scope with an org-wide opt-in). Deferring would force a behaviour
  migration later; an additive `visibility` field (default `'org'`) gets it now at zero migration
  cost. So D5 lands WITH membership (Phase 2).
- **A new project-chat / project-message entity.** Rejected — duplicates ADR 0043; conversations
  already model group + participants + persistence + read-state. Bind, don't fork.
- **A new project-members table in `accessControl`.** Rejected — accessControl owns *authority*;
  project membership is descriptive (Team-like) and belongs on the project entity (the single
  owner of "who's on this project").
- **Reuse an accessControl `Group` as the project's member set.** Tempting (Groups carry members),
  but Groups carry *roles* (authority) — coupling project membership to a Group would re-introduce
  project-scoped authority. Keep them orthogonal: membership on the project, authority in the org.

## Open questions

1. **Read-privacy model — DECIDED (2026-06-16, `/architect`), see D5.** Projects get an additive
   `visibility: 'org' | 'private'` (default `'org'` → no behaviour change). READ visibility gains a
   membership dimension via the generalized `subjectAccess` seam (org-write OR org-visible-org-read
   OR private-and-member); WRITE authority stays org-scoped and is never membership-derived (ADR
   0045 intact). Lands in Phase 2 with membership (additive ⇒ no later migration). *Residual sub-
   question:* should `'private'` be the DEFAULT for new projects (vs `'org'`)? Default `'org'`
   chosen for back-compat; revisit as a product call once the UI ships (a per-project toggle either way).
2. **Default visibility for NEW projects.** Field default is `'org'` (back-compat). Whether the
   *create* UI defaults a new project to `'private'` (the PM-tool norm) or `'org'` is a product
   choice, independent of the data model — flip without a migration.
3. **Agent membership vs board `advisors`/roster binding.** A project's agents live in
   `members[]` (roster ids). Should board-card runs / schedules fired by the project auto-attribute
   to project agents? Out of scope; the existing `ownerScope` run attribution (ADR 0046) already
   marks `project:<id>`.
4. **Moderator + turn policy.** DECIDED (2026-06-16, `/architect`) — see **D6**. Phase 4 reuses the
   ADR 0040 cadence primitive (shared planner/driver + extracted validator), explicit Convene, cohort
   cap 8, moderator-must-be-a-member, policy read from the project. Host-extension; no RFC.

## RFC gate

**Host-extension — NO new RFC.** Every surface is host-internal and non-normative: the
conversation system + chat sessions live under `/v1/host/openwop-app/chat/*`; `accessControl` and
project data are host-owned; `ConversationMeta.ownerSubject` and `Project.{charter,members}` are
host types, not wire shapes. No run-event field, capability flag, event type, or endpoint contract
on the OpenWOP `/v1` wire changes. Agent *replies* still run over existing dispatch (no new run
semantics). **Re-test trigger:** only if a project's membership/convene is ever made a capability a
*remote* OpenWOP client negotiates (rather than host config) does this flip to needs-an-RFC — flag
loudly then.

## Implementation status

| Phase | Status |
|---|---|
| 1 — charter | **implemented** — `Project.charter` (+ `parseCharter` validate/cap) on the existing always-on `PATCH /projects/:id`; `ProjectOverviewTab` (default tab); `projects-route.test.ts` charter block. (Charter is benign metadata → rides the always-on projects surface, consistent with the other project tabs; the `project-collab` toggle is reserved for Phase 2/3, which actually change visibility/auth/chat.) |
| 2 — membership + visibility (`subjectAccess` seam) | **implemented** — `Project.{members,visibility}`; `resolveProjectAccess` (the visibility ≠ authority rule); the new `host/subjectAccess.ts` seam (projects fills it) consumed by kanban `authorizeBoard`/list/claim/assigned so a `private` project is read-gated to members across board + memory + knowledge + schedules; `requireProject` gates the project routes the same; `/:id/members*` + `/:id/visibility` writes gated on the new `project-collab` toggle (OFF); `ProjectMembersTab` (toggle-gated). `projects-route.test.ts` membership + private-gating blocks — 15/15. |
| 3 — group chat | **implemented** — `ConversationMeta.ownerSubject` + a deterministic `subjectConversationId(tenantId, subject)` (idempotent bind, no second chat) in `host/conversationStore.ts`; `POST /projects/:id/chat` (gated on `project-collab`) ensures the `type:'group'` conversation bound to `project:<id>`, **reconciles** the lineup to the project's CURRENT agent members (add + prune) via `addParticipant`/`removeParticipant`; the chat DATA path (`chat/sessions/:id(/messages)`) is membership-gated via `requireVisibleAsync`/`requireManageAsync` → `resolveSubjectAccess` for any `ownerSubject`-bound conversation (see the D3 correction — members read, non-members + removed owners denied, manage needs org write); FE `ProjectChatTab` (toggle-gated tab) → `ensureProjectChat` → deep-links `/chat?conversation=<id>`; `ChatSidebar` honors the `?conversation=` param (mirrors `?agent=`). `projects-route.test.ts` group-chat block (idempotent sessionId, `ownerSubject={kind:'project'}`, `type:'group'`, foreign-tenant 404, **membership-gated chat history**) — 17/17. |
| 4 — moderator + turn policy (D6) | **implemented** — shared `host/turnPolicy.ts` validator (advisory repointed to it — one validator, no drift); `Project.{moderatorRosterId,turnPolicy}` on the additive `PATCH /projects/:id` (moderator MUST be a project agent member → 422 else; removing the moderator member clears the chair); FE reuses the cadence primitive 1:1 — a project branch in the `ChatSidebar` glue (`planBoardroomTurns` + `useBoardroomCadence`, unchanged) triggered by an explicit **Convene** button or a leading `@@` in the project chat, cohort capped at 8 (`CONVENE_COHORT_CAP`); `ProjectChatTab` gains the moderator/rounds/order/synthesis controls (`updateChatCadence`); `toConversation` surfaces `ownerSubject` so the chat knows it's a project group. `projects-route.test.ts` cadence block (turnPolicy clamp, moderator∈members 422/404, remove-clears-chair, write-gated 403) — 18/18; advisory suite green after the extraction (8/8). |
