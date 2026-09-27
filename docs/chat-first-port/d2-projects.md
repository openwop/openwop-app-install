# Projects (unit D2) — chat-first port review

**Scope:** `backend/typescript/src/features/projects/*` + `frontend/react/src/features/projects/*`
(ADR 0046 project subject, ADR 0054 collaborative projects, ADR 0043 project chat,
ADR 0040 `@@` convene, ADR 0063 `canWrite` projection).

**Headline verdict:** Projects is a **near-model RIDES citizen** — it instantiates
*every* owned primitive it touches (kanban, subject-memory, subject-knowledge, the
ONE scheduler, the ONE conversation, the shared convene cadence, the real run
igniter) and reuses every shared renderer, exactly as ADR 0046/0054 promise ("adds
no new infrastructure"). There is **no PARALLEL and no THEATER** in the existing
surface. The one real chat-first gap is an **absence, not a lie**: the feature has
**zero authoring agency** — the sole agent tool is read-only
`openwop:projects.list` (`agentTools.ts:12`) and there is no Project Manager agent
anywhere — so nothing about a project (create, charter, milestones, membership,
visibility, workflow assignment, schedule, convene cadence) can be accomplished by
*describing intent*; each is a bespoke form. That is the port.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Read the portfolio (`openwop:projects.list` tool) | `agentTools.ts:14-47` — access mirrors the route (`resolveProjectAccess` per project, fails empty w/o acting user) | **RIDES** | Leave. Model-facing read is honest + authz-parity clean |
| Board tab | `ProjectDetailPage.tsx:150` → `ensureSubjectBoard` (`projectsService.ts:138`) + shared `<AgentBoardPanel>` | **RIDES** | Leave — the ONE kanban owner |
| Memory tab | `ProjectDetailPage.tsx:151` → `subjectMemory` (`project:<id>` scope) + shared `<MemoryBrowser>` | **RIDES** | Leave — the ONE memory owner |
| Knowledge tab | `projectKnowledgeService.ts` → generic `host/subjectKnowledge` binding + shared `resolveSubjectKnowledgeRetrieve` (`:158`) + `<SubjectKnowledgePanel>` | **RIDES** | Leave — no project-specific retrieval; self-heals dangling bindings (`:78`) |
| Schedules (rows) | `projectScheduleService.ts:78` → `registerJob` on the ONE `schedulingService`, `ownerSubject=project:<id>` | **RIDES** | Leave — no parallel scheduler; IDOR fail-closed (`ownedJob :92`) |
| Run a workflow now | `ProjectWorkflowsTab.tsx:60` → `createRun` (the real igniter) w/ `metadata.manual.source:'project'` | **RIDES** | Leave — real run creation, RunInputs contract honored |
| Project group chat launch | `ProjectChatTab.tsx:42` → `ensureProjectChat` → deep-link `/chat?conversation=<id>`; backend binds ONE `type:'group'` conv to `project:<id>` (`routes.ts:348-386`) | **RIDES** | Leave — the sanctioned "open the ONE chat scoped to a conversation" precedent ("No second chat system") |
| `@@` cohort convene + cadence | consumed by shared `chat/conversations/convene.ts:56-88` (`orderConveneCohort`, `planBoardroomTurns`, `activeAgents.activateAgent`, `send`) using `project.turnPolicy`/`moderatorRosterId` | **RIDES** | Leave — drives a real multi-agent boardroom turn through the ONE chat loop; same `TurnPolicy` primitive as the advisory board |
| Access / visibility gating | `resolveProjectAccess` (`projectsService.ts:214`) is the ONE predicate; route (`requireProject :86`), tool (`agentTools.ts:32`), kanban (`subjectAccess` seam `feature.ts:45`), and shared-KB provider (`projectKnowledgeService.ts:180`) all call it | **RIDES** | Leave — textbook authority-parity |
| Projects list page + create form | `ProjectsPage.tsx` (list + `createProject` form) | **PAGE-LEGIT** (list) + form is a port candidate | Keep list as page; add a chat create lane |
| Charter dossier (read) | `ProjectOverviewTab.tsx:77-147` (goal/status/timeline/objectives/brief/milestones + progress meter) | **PAGE-LEGIT** | Keep — read-only, honest, every meter backed by real charter data |
| Members roster (read) | `ProjectMembersTab.tsx:118-150` | **PAGE-LEGIT** | Keep — read view |
| Workflow-portfolio *assign* UI | `ProjectWorkflowsTab.tsx:20` — the third sibling copy of Profile/Agent portfolio | **ADAPTER** (drift-watch) | Honest (real `updateWorkflows`/`createRun`); triplication is a platform-shape smell, not projects-introduced. Watch |
| Convene cadence editor form | `ProjectChatTab.tsx:102` `CadenceEditor` — moderator + turn-policy config | **ADAPTER** | Honest config over the shared `parseTurnPolicy` primitive; keep, add chat lane |
| **Author a project by describing intent** (create / charter / milestones / members / visibility / assign workflow / schedule / cadence) | **does not exist** — every one is a form; the only agent tool is read-only | **THE PORT (absence)** | Ship a Project Manager agent pack + a projects tool pack (below). Not THEATER (nothing claims it), not PARALLEL (only writer) |

**Counts:** R=9 · A=2 · P=0 · T=0 · PL=3.

---

## Blockers (from scouting) — each with the honest alternative

1. **No authoring agent, and the one tool is read-only.**
   `openwop:projects.list` (`agentTools.ts:12`) is the *entire* model-facing write
   capability — i.e. none. Confirmed by grep: no `projects.create/update/member/
   schedule` tool exists anywhere in the backend. Every mutation lives in a form:
   create (`ProjectsPage.tsx:57`), charter/milestones (`ProjectOverviewTab.tsx:150`
   `CharterEditor`), membership + visibility (`ProjectMembersTab.tsx:111,75`),
   workflow assign (`ProjectWorkflowsTab.tsx:152`), schedule create
   (`ProjectSchedulesTab.tsx` → `createProjectSchedule`), cadence
   (`ProjectChatTab.tsx:112`).
   *Alternative:* a **Project Manager** agent (capability at core, activated via
   `agentProfile`) + a projects tool pack whose ACTION tools each call the SAME
   `resolveProjectAccess` / `requireOrgScope` predicate the routes call (one helper,
   route + tool both call it; read tools fail EMPTY, action tools fail typed). This
   is exactly the ADR 0308 `registerFeatureAgentTool` pattern the list tool already
   follows — extend it write-ward.

2. **Charter is a full-replace PATCH — a naive "update charter" tool would silently
   drop fields.** `parseCharter` (`projectsService.ts:91`) + `updateProject :169`
   overwrite the whole `charter` object; `{charter:null}` clears it. A chat tool that
   sends only `{goal:'…'}` would wipe objectives/milestones/dates.
   *Alternative:* the charter tool must **read-before-write** (`get` the project,
   merge, then PATCH) — the app's "agents read before they write" invariant. Model it
   as field-level ops (`set-goal`, `add-milestone`, `mark-milestone-done`) that the
   tool composes onto the current charter, never a blind full replace.

3. **`moderatorRosterId` has a membership precondition (422).** `updateProject :195`
   rejects a moderator that is not already an `agent:` member. A cadence tool must
   add the agent as a member first (or surface the typed 422 verbatim), not fail
   opaque.
   *Alternative:* the tool orders the two writes (add-member → set-cadence) or returns
   the 422 message unedited as a repair signal.

4. **Convene is a FE interceptor, not a backend orchestration.** `runProjectConvene`
   (`convene.ts:56`) runs client-side (activates agents, plans turns, sends the
   opener). There is no backend "convene this project" run.
   *Alternative:* fine — the port drives convene the way a user does, via the ONE
   chat surface (deep-link + `@@`), not a new backend workflow. Do **not** invent a
   backend convene run (that would shadow the FE cadence owner).

---

## Demolition list (with regression pins)

The forms are honest and several stay as PAGE-LEGIT read/decision surfaces or
escape hatches. **Demolish nothing until the chat lane works.** After the port,
the candidates to retire (or demote to a fallback "advanced" affordance) and pin:

- `CharterEditor` (`ProjectOverviewTab.tsx:150`) → once the PM agent can author a
  charter in chat, the inline editor becomes the manual escape hatch. *Pin:* a test
  asserting the charter tool does a read-merge-write (never a blind full replace) so
  a resurrected "replace whole charter" path fails.
- `CadenceEditor` (`ProjectChatTab.tsx:102`) → after a `set-convene-cadence` tool
  lands. *Pin:* a test asserting the tool enforces `moderator ∈ agent members`
  (the `:195` 422) so the invariant can't regress into the tool layer.
- The create form (`ProjectsPage.tsx:71`) and member add-form
  (`ProjectMembersTab.tsx:100`) **stay** as PAGE-LEGIT — a portfolio page with a
  first-run create affordance is legitimately page-shaped; chat becomes an
  additional lane, not a replacement.

---

## New-code inventory (small)

- **1 agent pack** — a `Project Manager` persona (core capability + `agentProfile`
  activation), scoped so the chat can be deep-linked to it (`/?agent=<id>`), mirroring
  the Workflow Architect / Strategy Analyst precedent.
- **1 projects tool pack** (pack-allowlisted, NOT added to the ADR 0315 default-on
  baseline), each ACTION tool sharing the route predicate via one helper:
  `projects.create`, `projects.set-charter` (read-merge-write field ops),
  `projects.add-member` / `remove-member`, `projects.set-visibility`,
  `projects.assign-workflow`, `projects.create-schedule`, `projects.set-cadence`.
  Reuse the existing service functions verbatim (`createProject`, `updateProject`,
  `addProjectMember`, `setProjectVisibility`, `createProjectSchedule`) — the writes
  already exist; the tools are thin authz-shared wrappers.
- **1 promptCatalogParity test** for the new pack (repo invariant) + the
  `agent-prompt-tool-ids` row.
- **No new workflow, no new node beyond the tool wrappers, no new store, no new
  conversation, no new scheduler** — the owners all exist.

---

## Phased plan (gated on real gates)

1. **Compliance seam first (no user-facing change):** add the projects tool pack
   (write tools) sharing `resolveProjectAccess`/`requireOrgScope`; charter tool does
   read-merge-write; each tool pack-allowlisted. Gate: `npm run ci` + a
   `promptCatalogParity`/`agent-prompt-tool-ids` test. Close with `/code-review`.
2. **Project Manager agent pack + deep-link:** persona at core, `/?agent=<id>` opens
   the ONE chat scoped to it; the existing `projects.list` read tool grounds it.
   Gate: `npm run ci`. Close with `/code-review` + `/ux-review`.
3. **Migrate authoring to chat, keep forms as fallback:** wire the detail-page
   authoring affordances to also offer "ask the Project Manager"; the forms remain.
   No demolition yet.
4. **Demolish/demote per the pin list** once each chat lane is proven; land the
   regression pins in the same phase. Close with `/code-review` + `/ux-review`.

Each phase closes green on `npm run ci` (backend vitest + frontend build/token
gates) before the next.

---

## Deferred honestly

- **Lifecycle / DSAR gap (pre-existing, not port-introduced):** the
  `projects:project` store is **absent from the subject-erasure boot list**
  (`subjectErasure.ts`) — no eraser strips a DSAR-erased person's `user:<id>` member
  ref (`projectsService.ts:207,245`) or charter free-text from projects they belong
  to. `deleteProject` (`:277`) cascades a *whole-project* delete (board + memory +
  knowledge + schedules) but there is no per-subject membership eraser. This is a
  filed cross-layer TODO for the erasure-completeness owner (ref
  `adr0464-subject-erasure-completeness`), NOT a local workaround and NOT a blocker
  to the agency port. Any NEW durable row the port added would need boot-list
  coverage — but the port adds no new store.
- **Workflow-portfolio UI triplication** (`ProjectWorkflowsTab` vs Profile/Agent
  siblings) is a platform-wide consolidation question, out of scope for this unit —
  noted as drift-watch, not demolished here.
- **Sources / Podcast / Strategy tabs** (`ProjectDetailPage.tsx:171-177,143`) are
  owned by the notebooks / podcasts / strategy features (one-directional composition)
  and graded under those units, not here.
