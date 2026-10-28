# ADR 0943 — Campaign agent team and per-node agent assignment

Status: Accepted (P0, P1, P4 implemented; P2, P3 wait on ADR 0942 P1)

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 0 foundation. Net-new plan
(feature-refinement), not a MyndHyve port. Depends on ADR 0941 (canonical
campaign + the one run tag on every campaign run) and ADR 0942 (autonomy
policy, the one gate primitive). Feeds 0944 (client memory), 0945–0961 (every
node an agent executes) and 0962 (external agents).

## Context

The product ask is "workflows with dedicated agents executing work per node,
active collaboration between humans, agents and sub-agents in workspaces". The
market has nothing equivalent: GoHighLevel's AI step times out at 60 s with
free-text output and no approval node; HubSpot "Run Agent" is a private beta;
Adobe Workfront ships "AI collaborators" as assignable resources but on a closed
task model with no replay. OpenWOP already has the parts: a named agent pin per
node, durable chains, kanban stacks, a roster, handoffs and eval suites. What is
missing is a **team** that is data (packs), a **binding** that a client can
override without forking a chain, and the few seams where the parts do not yet
meet.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths under `backend/typescript/src/` unless noted.

**Exists and is reused:**

- **Node agent pin.** `WorkflowNode.agent?: AgentRef` (`executor/types.ts:1015-1027`,
  `AgentRef` at `:372-385`); the executor surfaces it as `ctx.nodeAgent`
  (`executor/executor.ts:844`, `executor/types.ts:443`).
- **The agent-runner node** `local.openwop-app.agent-runner`
  (`host/agentRunnerNode.ts:58`) resolves `agentId` from inputs → config →
  `run.configurable` (`:65-98`), applies the autonomous-dispatch verdict
  (paused / never / approval, `:145-165`, `host/autonomousDispatchPolicy.ts:40`),
  takes `provider/model/credentialRef` per run (`:333-337`), fences a handoff
  note (`:285-287`), pulls ADR 0831 run-context blocks (`:288-290`) and records
  eval capture (`:291-297`).
- **Agent policy.** `host/agentPolicyResolver.ts:1-40` — most-restrictive verdict
  over profile `permissions` / `hitl` / readiness; owns no store.
- **Model resolution.** `host/modelClassResolver.ts:9-17` — explicit pin →
  managed tier → per-class default.
- **Kanban.** `KanbanCard.assigneeId` is a **userId only** (ADR 0049,
  `host/kanbanService.ts:134-142`); agent ownership exists only per **board**
  (`rosterId` / `ownerSubject`, `:166-184`). Work items run their workflow through
  `startWorkflowRun` via the outbox daemon (`host/kanbanWorkItemDaemon.ts:1-10`;
  `KanbanWorkItem` `:262-300`). Card handoff note = ADR 0829 `HandoffRecordV1`
  (`:120-130`, `host/handoff/handoffRecord.ts:45`).
- **Delegation.** `core.dispatch` spawns child workflows per decision
  (`bootstrap/nodes.ts:225-245`); the chat lane runs a saved workflow as a
  sub-run via `subruns/subRunDispatcher.ts:1-8`. Campaign orchestration already
  fans out 5 channels this way (`features/campaign-orchestration/orchestrationWorkflow.ts:14-20`).
- **Evals.** ADR 0889 pack suites resolve from `evalSuiteRef` like
  `systemPromptRef` (`docs/adr/0889-…md:72`); precedent
  `packs/vendor.openwop-app.workflow-author.agents/evals/workflow-architect.json`.
- **Run-start freeze.** `host/runStartContext.ts:1-15` (merge-never-overwrite;
  `derivedFromRun` ⇒ contribute nothing, `:24-45`).
- **Presence.** `features/channels/channelPresenceTracker.ts:1-10` — ephemeral,
  never on the event log.
- **Activity.** `host/agentActivity.ts:1-25` (heartbeat/schedule/kanban/approval
  attribution feed).

**Findings that shape the decision:**

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | The agent runner **ignores the node pin** | `agentRunnerNode.ts:65-98` reads inputs/config/configurable only; `ctx.nodeAgent` is read only by conformance mocks (`bootstrap/nodes.ts:137`, `bootstrap/conformanceMockAgent.ts:106`) | "per-node agent via `nodes[].agent.agentId`" is not true today for real agents |
| F2 | `core.orchestrator.supervisor` **runs no model** | `SUPERVISOR_CALLS_LIVE_MODEL = false` (`bootstrap/nodes.ts:186`); it echoes `mockDispatchPlan` (`:157-170`) | "Producer delegates via the supervisor" cannot mean an LLM supervisor; flipping the flag changes a conformance advert (ADR 0858 P3) |
| F3 | **Two Campaign Strategists** already | `vendor.openwop-app.campaign-studio.agents.default` (canvas, ADR 0153) and `vendor.openwop-app.campaign-orchestration.agents.campaign-strategist` (drives the chain, ADR 0158) | adding a third is the parallel-agent trap |
| F4 | A **Creative Director persona already exists** | `packs/vendor.myndhyve.ads-crew/pack.json` agent `vendor.myndhyve.ads-crew.creative-director` over 14 `vendor.myndhyve.ads-*` nodes | collides with the new role; David archived MyndHyve agents (2026-10-18) |
| F5 | Roster, profiles and BYOK have **no org** | `AgentProfile` has no `orgId` (`types.ts:595-615`); `SecretScope` is `{tenantId, actorId}` (`byok/secretResolver.ts:126-132`) | per-client agent config needs a client-keyed home; per-client AI keys do not exist |
| F6 | ADR 0923's `change-planner` is planned in the same pack but not yet in it | `packs/vendor.openwop-app.campaign-studio.agents/pack.json` has one agent; `docs/adr/0923-…md:207` | the team extends the pack beside it, does not replace it |

## Decision

### D1 — The team is data: ten roles as agent manifests, zero role code

The team ships as agent manifests (persona + `systemPromptRef` + `modelClass` +
`toolAllowlist` + `evalSuiteRef` + `memoryShape`) in the existing
`vendor.openwop-app.campaign-studio.agents` pack (version bump; install
decoupled from toggles). **No source file keys on a team agentId** (David's law,
"agent capability core, not named"): a capability is a tool in a node pack,
activated per agent by its allowlist. A ratchet test fails if any of the ten ids
appears in `backend/typescript/src/**` outside tests.

| Role | agentId (`…campaign-studio.agents.<x>`) | Capabilities = tools from | Never allowlisted |
|---|---|---|---|
| Strategist | **reuse** `campaign-orchestration.agents.campaign-strategist` (F3) | campaign-orchestration, campaign-brief | any publish/send/spend |
| Creative Director | `creative-director` | creative-briefs render, media, 0945 fidelity, 0946 variant set, `vendor.myndhyve.ads-*` generate/validate | ads publish |
| Copywriter | `copywriter` | campaign-channels generate, brand voice resolve, 0933 check-content | publish, send |
| Media Buyer | **reuse** `campaign-intel.agents.intelligence-analyst` (F3 rule; ADR 0952 D8 widens its allowlist) | campaign-intel (budget/pacing/forecast), 0952 propose-reallocation, 0956 reads | direct unpause / raise cap (gated node only) |
| CRO Analyst | `cro-analyst` | 0949 experiments, 0951 behaviour summaries, cms page read | promote (0950 node only) |
| Lifecycle Marketer | `lifecycle-marketer` | email (0905) drafts, 0955 journeys | send |
| Lead Qualifier | `lead-qualifier` (in-run grader; the public widget persona stays `core.openwop.agents.lead-concierge`, ADR 0954 D7) | crm lead read/score, 0954 lead-evidence + assessment | contact a lead (gated), set a grade |
| Compliance Reviewer | `compliance-reviewer` | 0933 `check-content`, brand scoring, ads-policy | every write tool |
| Reporting Analyst | `reporting-analyst` | campaign-intel attribution, 0956, dashboard reads, 0957 narrative | every write tool |
| Producer | `producer` | kanban add-todo / assign, campaign status, handoff, 0958 assign-vendor-task, 0959 playbook reads + changelog drafts, 0960 command summary | every channel write tool; inviting or granting access |

Two roles reuse an existing persona (Strategist, Media Buyer), so eight manifests
are new. Other ADRs add tools to these roles; they add no new role (0953's
posting tools go to the Copywriter and Producer, 0959's playbook tools to the
Producer). The canvas `default` Strategist stays the canvas author (rename its label to
"Campaign Canvas Author" — Q2). The 0923 `change-planner` stays a tool-less
planner beside the team. Tools a role needs that do not exist yet ship **in the
owning feature's node pack** by the ADR that owns the capability (0945–0956),
never in this pack. Allowlists are not added to the ADR 0315 default-on baseline.

> **Correction (2026-10-20, P1 build, architect review).**
> - **Allowlists hold only tools that exist today.** The "Capabilities" column
>   names several tools that are not yet registered: ADR 0933 `check-content`,
>   creative render, the `vendor.myndhyve.ads-*` nodes (nodes, not agent tools),
>   experiments, journeys, kanban assign and handoff. An allowlist entry that no
>   tool registers fails `agent-allowlist-resolution`. Each role starts with the
>   registered tools of its families (pinned in
>   `test/adr0943-team-pack-suites.test.ts`). The ADR that ships a missing tool
>   adds it to the role's allowlist in the same PR, together with a suite task
>   and that test's pin.
> - **Labels.** The team is labelled "Campaign &lt;Role&gt;" (Campaign Creative
>   Director, Campaign Copywriter and so on), because `ads-crew.creative-director`
>   ("Creative Director"), `email.agents.copywriter` and
>   `podcasts.agents.producer` already exist. The campaign Copywriter is not a
>   second email agent: it writes for every channel and uses the same email
>   tools. Retiring the MyndHyve persona stays Q1.
> - **"Never allowlisted" binds the manifest, not the platform baseline.** Every
>   agent also receives the ADR 0315 default-on draft tools (`documents.draft`,
>   `email.draft`, `kanban.add-todo`, `notifications.notify-me`,
>   `tasks.schedule-*`, `walkthroughs.register-draft`). None of them publishes,
>   sends or spends, and each needs an acting user. A manifest cannot opt out
>   without a new agent-manifest field, which is RFC 0003 wire, so none is
>   added. Two things hold the line instead:
>   1. Every suite forbids those tools for every role that does not hold them.
>      A role that reaches for one fails its suite.
>   2. A chain node that runs a read-only role confines it with `offerTools`
>      (ADR 0458 P2). That obligation goes to P3 (`AGTWF-1`).
> - **`modelClass`.** The values come from the closed RFC 0002 enum in
>   `schemas/agent-manifest.schema.json`: `reasoning | writing | coding |
>   research | classification | general`. CRO Analyst, Lead Qualifier and
>   Compliance Reviewer use `reasoning`; the other five new roles use `general`.
>   The Strategist and the Media Buyer keep their existing `research`. Changing a
>   reused agent's class is out of P1 scope.
>   - The host's `modelClassResolver` knows only `chat | reasoning | coding |
>     extraction` and resolves any other value to its `chat` default. So
>     `general` and `research` run on the chat-class model today, and only
>     `reasoning` changes the model. That is pre-existing resolver behaviour.
>   - *(Corrected the same day: the first draft of this note said "general is not
>     a class" and set the roles to `chat`. `chat` is not in the wire enum, so
>     those manifests were schema-invalid. Found while building P4; the pack test
>     now checks every team manifest against the enum.)*

### D2 — Per-node binding: the pin is the default, the client override is frozen

1. **Close F1.** `resolveParams` gains a last fallback: `ctx.nodeAgent?.agentId`.
   Order: `inputs` → frozen client binding (below) → `config.agentId` →
   `nodeAgent`. A chain node is therefore authored as
   `{ typeId: 'local.openwop-app.agent-runner', agent: { agentId: '<default>' } }`.

   > **Correction (2026-10-20, P0 build):** that authoring shape holds for a
   > builder or API definition only. `expandChain`
   > (`host/workflowChainPackLoader.ts`) emits no node `agent` field, and a chain
   > pack cannot author one until the RFC 0013 revision ADR 0941 D9 owns. Until
   > then a **chain pack pins through `config.agentId`**. The run-start
   > contributor treats `node.agent?.agentId ?? config.agentId` as the pin, so a
   > binding works for both shapes. The runner order as built is `inputs` →
   > frozen binding → `config` → `configurable` (the existing autonomous-dispatch
   > rung) → `nodeAgent`. The binding's `model` takes the same position for
   > `provider` / `model` / `credentialRef`. Only an explicit input outranks a
   > client binding, so a chain that threads `agentId` through
   > `{{params.agentId}}` inputs cannot be overridden by a client. Campaign chains
   > must not do that.
2. **Client override store** (campaign-ops owns client config, ADR 0921 D1):
   `DurableCollection('campaign-ops:agent-binding')`, key `tenant::orgId::bindingId`.

   ```ts
   interface ClientAgentBinding {
     tenantId: string; orgId: string;           // the client — the only isolation key
     pinnedAgentId: string;                     // the chain's default pin it replaces
     workflowId?: string; nodeId?: string;      // optional narrowing (one chain / one node)
     agentId: string;                           // the replacement (pack or tenant agent)
     model?: { provider: string; model: string; credentialRef?: string };
     updatedAt: string; updatedBy: string;
   }
   ```
   Keyed by **pinned agentId**, not by a role name, so no role vocabulary enters
   code. Validated closed-world on write: the replacement resolves in the tenant
   (`resolveAgentIdentity`), is not paused, and its effective allowlist covers the
   pinned agent's tools that the node offers; else `agent_binding_invalid` (422).
3. **Freeze at run start.** A run-start contributor reads the run tag (ADR 0941 D2b)
   (0941) and writes `run.metadata['openwop-app.agentBindings'] =
   { [nodeId]: { agentId, model? } }` for every agent-runner node in the
   definition. It contributes nothing when `derivedFromRun` (fork/replay reads
   the source's bindings verbatim). The runner reads only the frozen map.

   > **Correction (2026-10-20, P0 build, architect review):**
   > - **Which org.** ADR 0941 P0 (the `orgId` on the run tag) is not merged
   >   yet. The contributor reads `campaignOrchestration.orgId` and falls back to
   >   the ADR 0921 stamp `openwop-app.campaignOps.orgId`. When both are present
   >   and name different clients, it binds nothing and logs
   >   `agent_binding_wrong_client`. Both stamps are caller-stripped
   >   (`CAMPAIGN_ATTRIBUTION_KEYS`). The stamp only selects which of this
   >   tenant's bindings apply; it authorizes nothing.
   > - **Contract.** The frozen map lives at `run.metadata['openwop-app.agentBindings']`
   >   and is added to `RESERVED_RUN_METADATA_KEYS`. The reader is the host module
   >   `host/runAgentBindings.ts`; the runner never imports the feature.
   >   `RunStartContext` gains a read-only `definition`, which `insertRunWithStartContext`
   >   forwards from every catalog-resolved start.
   > - **Cost.** The contributor returns before any read when a run has no client
   >   stamp or no pinned agent-runner node. The binding read is a bounded prefix
   >   read of one client's slice.
   > - **Missing agent.** A binding whose agent was uninstalled after the run
>   started fails the node with the typed `agent_not_found`. The runner never
>   falls back to the pin (witnessed).
> - **Fail-closed reads.** If the runner cannot read its run, the node fails
   >   retryable (`storage_unavailable`). Running the chain's default agent for a
   >   client who replaced it would run the wrong agent. Contributors may not
   >   fail run creation, so when the contributor cannot read the toggle (a
   >   `blockedBy: 'unresolved'` fault) or the bindings, it freezes
   >   `{ unresolved: true }` for each pinned node. The runner then refuses that
   >   node with `agent_binding_unresolved`, which is not retryable. A fork copies
   >   the marker and behaves as its source did.
   > - **Key pairing.** A binding that pins a model also pins its key. The node's
   >   own `credentialRef` is never paired with the binding's provider, since it
   >   may be another vendor's key. A binding model with no key uses the run's
   >   default for that provider (code-review finding, 2026-10-20).
   > - **Node ids.** `expandChain` prefixes each node id per expansion
   >   (`<chain slug>_<expansionId>_<id>`), so a node-narrowed binding names
   >   the id the chain authored. The contributor matches either the expanded id
   >   or that authored id (`/grade-workflows` `AGBWF-1`).
   > - **Child runs (P0 limitation).** `subWorkflowDispatcher` does not copy the
   >   parent's campaign stamp, so an agent-runner inside a child run uses its
   >   default pin in P0. That fails safe: never the wrong client's agent.
   >   Inheritance lands with delegation in P3 (D4).
   > - **Lifecycle.** The store registers an ADR 0499 credential-ref consumer, so
   >   deleting a key that a binding pins answers 409. The ADR 0464 eraser
   >   re-attributes `updatedBy`. The demo agency seed's clear removes the
   >   bindings of the clients it removes.

> **D6 addendum (2026-10-20, P0 build, architect review): pinning a key needs
> the BYOK predicate.** A binding that pins a stored, non-managed `credentialRef`
> spends the agency's key. So beyond `workspace:write` on the client org, the
> route requires `host:byok:manage` through ONE shared helper,
> `requireByokManage` (`features/featureRoute.ts`). The BYOK routes
> (`routes/byok.ts`) and the binding route both call it; it is not copied.
> Otherwise any client-org editor could point agents at any agency key. A binding that pins only the agent, or
> the agent plus a managed model, stays `workspace:write` (matrix row 8).

### D3 — Agents as assignable cards (Workfront "AI collaborator" parity)

- `KanbanCard` gains additive `assigneeSubject?: Subject` (`kind:'agent'|'user'`).
  `assigneeId` stays the human field (ADR 0049, unchanged readers); setting an
  agent subject clears it and vice versa (one CAS write, `version`).
- Assigning a card to an agent creates/links a `KanbanWorkItem` whose
  `workflowId` is the card's chain (or the agent-runner turn chain) and whose
  `execution.mode` comes from the frozen 0942 policy: `auto` ⇒ the outbox
  daemon starts it; otherwise `manual` and the card waits for a human "Run".
- The run is attributed `kanban` (`agentActivity.ts` attribution keys), stamped
  with the campaign's client, and carries the card's `handoff` note into the
  prompt (fenced, 0829 D5). When an agent finishes or hits a gate, it hands
  back with a `HandoffRecordV1` and the card moves to the role-routed human
  (`assigneeRole`, ADR 0049).
- The agent must be a roster member of the workspace (board/run attribution
  needs a `rosterId`); the Producer's `add-todo`/assign tools are the only agent
  path to create cards for other agents (ADR 0311 pattern).

### D4 — Delegation: deterministic graphs, not an LLM supervisor

- **In a chain:** fan-out is `core.dispatch` over a plan. The Producer may
  *author* the plan: an agent-runner node whose output is a closed-world
  `OrchestratorDecision[]` validated against the chain's declared worker set
  (unknown worker ⇒ typed failure, one repair turn), consumed by `core.dispatch`.
  `SUPERVISOR_CALLS_LIVE_MODEL` stays `false` (F2) — this ADR does not change a
  conformance advert.
- **In chat:** the Producer runs a chain through the existing workflow-run tool
  (`subRunDispatcher`); it never chats agent-to-agent off the record.
- Every child run inherits the run tag, the frozen autonomy policy and the
  frozen bindings. Every delegation is a run edge, so it replays and forks.

### D5 — Evals per role (ADR 0889)

Each manifest carries `evalSuiteRef: evals/<role>.json` in this pack. Each suite
holds ≥10 tasks with RFC 0244 trajectory checks — `forbidden` lists mirror the
"never allowlisted" column; gate-respect cases (the agent stops at an approval
interrupt rather than routing around it); fidelity cases (0945) for the Creative
Director. A pack bump that changes a prompt or model class is refused by the
pack pipeline unless the suite's regression verdict is not `regressed` (ADR 0889
§F sign test). Run-lane capture stays opt-in (ADR 0889 D9).

> **Correction (2026-10-20, P1 build).** How each suite tests its role:
> - Each suite has 10 tasks. They are replay-only (`onMiss:"fail"`) trajectory
>   tasks: read-before-write order, gate respect (a fixture answers
>   `awaiting_approval` and the agent must stop), refusals, typed tool errors,
>   and prompt-injection in a fixture.
> - A tool outside the role's allowlist is never offered, so it cannot be
>   called. The forbidden lists therefore bite on the default-on writes (see the
>   D1 correction).
> - The mock-seam test proves each suite can fail: a scripted follower passes
>   every task and a scripted violator fails every task.
> - **"Every suite runs green on the managed tier" is OPEN.** It needs a host
>   with a provider key (or a prod bearer token) for
>   `backend/typescript/scripts/eval-agent-suite.mts --suite <ref> --agent <id>`,
>   and this build environment has neither.
> - The fixture responses are hand-written shapes. Once the roles run in chains,
>   real runs should be promoted into the suites (ADR 0889 P7 "Add to eval
>   suite").
> - The D5 pack-pipeline refusal on a regressed verdict rides the ADR 0889 D10
>   `--changed` hook. P1 adds no new pipeline.

### D6 — Model and BYOK

`modelClass` per role (reasoning: Strategist, Media Buyer, CRO, Compliance;
general elsewhere). A client binding may pin `{provider, model, credentialRef}`;
the ref must already be a tenant secret (`chatByokConfig.ts` IDOR rule). Absent
⇒ managed tier. Per-client AI keys are not built (F5, Q4).

> **P4 decisions (2026-10-20, architect review).**
> - **Which agents are the team.** The team is every agent that ships an eval
>   suite in one of three packs: `vendor.openwop-app.campaign-studio.agents`,
>   `vendor.openwop-app.campaign-orchestration.agents` and
>   `vendor.openwop-app.campaign-intel.agents` (`TEAM_PACKS`,
>   `features/campaign-ops/teamService.ts`). Code names packs, never a role id.
>   A role added to one of those packs with its suite appears without a code
>   change, and `adr0943-team-ids-ratchet` stays honest. A pinned agent that a
>   client has bound but that is not a team role still gets a row, so an
>   override is never invisible. Rejected alternatives:
>   - "agents the client's chains pin": no campaign chain pins an agent-runner
>     node until P3, so the tab would be empty;
>   - a `team.json` pack file: loader and pack-trust work for one list.
> - **One read.** `GET …/campaign-ops/clients/:orgId/team` returns roles,
>   bindings and scores in one call. A frontend fan-out per role would spend
>   the per-IP read budget. The cost is about one indexed eval-history read per
>   role plus one suite lookup per override.
> - **Scores ride the ONE evals access predicate** (`agentEvalsRefusal`). When
>   it refuses, the view says why once and shows no score. Scores are
>   workspace-wide, and the copy says so.
> - **`canEdit` comes from the server**, using the write predicate that the
>   binding `PUT`/`DELETE` routes use.
> - **Where it lives.** It is a lazy-loaded "Team" view of the Operations tab
>   for the selected client, at `?view=team` (the hub owns `?tab=`). ADR 0941
>   D5's `/campaign-studio/clients/:orgId/*` agency shell does not exist yet, and
>   inventing it here would pre-empt 0941.
> - **Q5 (refuse an override unless it passes the role's suite) is not built.**
>   A pack suite is bound to its `targetAgentId`, and running it against another
>   agent is refused (ADR 0889, #4847). Enforcing Q5 needs a "role suite, any
>   agent" contract, which belongs to an ADR 0889 follow-up. Until then the
>   Team view shows the replacement's own last check beside the role.

### D7 — Humans and agents in one workspace

No new surface. The campaign's linked project (ADR 0852) is the container: its
board holds human and agent cards; its channel holds discussion (agents appear
through run activity, never fake presence — presence stays connection-truth);
the ONE chat is deep-linked `/?agent=<id>` or embedded via `EmbeddedChatPanel`
scoped to a role; handoffs ride 0829; pending gates ride the 0926 inbox and the
0960 command center.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | No new package. Binding store + routes in `features/campaign-ops/`; runner fallback in `host/agentRunnerNode.ts`; card subject in `host/kanbanService.ts` (core, additive). |
| 2 | Toggle | None new. Bindings ride `campaign-ops`; team agents are pack data, usable wherever `campaign-orchestration` chains run. |
| 3 | Workflow surface | `ctx.features.campaignOps.bindings.get(orgId)` (read only; org-checked against the run stamp). |
| 4 | Node pack | None new here; role tools land in owning packs (0945–0956). |
| 5 | Envelopes | None. Producer plan = agent output validated closed-world (D4). |
| 6 | Agent pack | Eight new manifests + prompts + evals in `vendor.openwop-app.campaign-studio.agents`; Strategist and Media Buyer reused. |
| 7 | Public surface | None. |
| 8 | RBAC | Binding writes: `workspace:write` on the client org via `authorizeOrgScope`; card assignment to an agent: write on the board's project; Producer tools share the board routes' predicate. |
| 9 | Replay / fork | Bindings + model frozen at run start, read verbatim on `:fork`; delegation is run edges. |
| 10 | Frontend | "Team" tab in the campaign-ops client page (role → agent, model, eval score); agent avatars in the card assignee picker; no new nav group. |

## Why this is our advantage

- **Primitives used:** named agent per node (`nodes[].agent`), durable chains
  (RFC 0013/ADR 0163), kanban work items (ADR 0311/0738), human gates (0942),
  replay/fork, eval suites (RFC 0081/0244).
- **Gap closed:** Workfront treats agents as task assignees but cannot replay a
  task; GHL/HubSpot run one generic AI step. Here every role is a governed,
  evaluated, per-client-swappable agent whose every action replays.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | F1 fix (`nodeAgent` fallback) + run-start binding contributor + `campaign-ops:agent-binding` store/routes | Route test: client B's override never applies to client A's run; fork reads source bindings after the override changes |
| P1 | Eight manifests + prompts + eval suites (plus eval suites for the two reused personas); ratchet (no team id in src) | Every suite runs green on the managed tier; ratchet red when an id is planted |
| P2 | `assigneeSubject` on cards + work-item dispatch by policy | Assigning a card to Copywriter starts a stamped run under `auto`; under `approve` it waits; handoff back lands on the role |
| P3 | Producer plan → `core.dispatch` | Unknown worker ⇒ typed failure; replay of a delegated run re-serves children |
| P4 | Team tab UI + eval scores | `npm run build` green; 4-locale parity |

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | #5054 (`feat/campaign-agent-binding-0943-p0`) | `test/adr0943-agent-bindings.test.ts` (23): runner pin fallback, binding precedence and key pairing, the bare and expanded node-id match, closed-world writes (unknown and paused agents, tools not covered, unknown key, BYOK-manage gate), client B never binds client A's run, the reserved key cannot be supplied through `POST /runs`, `:fork` keeps source bindings after the override changes and never gains them, a redrive-shaped derived run contributes nothing, a toggle or bindings fault is frozen as `unresolved` and the runner refuses it, the client-bound surface read, the runner dispatches the frozen replacement. Sabotage-witnessed (notes in the file header). `adr0499-credential-ref-integrity` names the new consumer. |
| P1 | `feat/campaign-agent-team-0943-p1` (PR pending; stacked on P0 for this ADR file only) | `test/adr0943-team-pack-suites.test.ts` (30): each role's allowlist pinned and callable, no never-allowlisted tool, each suite closed-world valid with ≥10 tasks, replay-only, forbidding at least one OFFERED tool and never an allowed one; a follower passes and a violator fails every task through `POST /runs {mode:"eval"}`. `test/adr0943-team-ids-ratchet.test.ts` (3): no team agentId in `backend/typescript/src` outside one pinned, shrink-only allowance (the ADR 0158 Strategist fallback speaker). Sabotage-witnessed: a planted id and a stale allowance both go red. **OPEN:** the live managed-tier run (D5 correction). |

| P4 | `feat/campaign-team-tab-0943-p4` (PR pending; stacked on P1) | `test/adr0943-team-tab.test.ts` (5): the team is every suite-carrying agent of the team packs; a client sees only its own override; a bound non-team pin gets a row; `canEdit` follows the write predicate (a client-org reader cannot edit, and another client is a 404); evals off ⇒ unavailable with null scores, evals on ⇒ the latest completed run. Sabotage-witnessed: `canEdit` from the read predicate goes red, and so does reading evals without the predicate. Frontend: `teamPanel.test.tsx` (8) and `operationsPage.test.tsx` (+1, the Team view loads on demand); `npm run build` green (entry chunk 128.5 kB, 475 B headroom); 4-locale parity; `/ux-review` fixes applied (`?view=` URL state, the danger chip for a failed check, a DESIGN.md §5 row). |

## Alternatives

- **One generic "campaign agent" with a role parameter** — rejected: one eval
  suite cannot test ten jobs; allowlists cannot differ.
- **Role keys in code (`if role === 'media-buyer'`)** — rejected (David's law).
- **Override by editing the chain per client** — rejected: forks the blueprint
  (the GHL snapshot breakage 0959 exists to avoid).
- **Turn on a live LLM supervisor** — rejected here: changes a conformance
  advert and makes delegation non-deterministic; revisit in an RFC 0022 follow-up.

## RFC verdict

**Host extension — no RFC.** `nodes[].agent` is on the wire already; the binding
map lives in host `run.metadata` under a reserved key; card subjects and bindings
are host-ext routes. Authoring the agent in a chain pack (rather than binding it
after expansion) needs the RFC 0013 revision for a node `agent` field that ADR
0941 D9 owns: recommended, not blocking.

## Open questions

1. **(David)** Retire `vendor.myndhyve.ads-crew.creative-director` (and
   `market-intel-crew.research-director`) as superseded by the team, consistent
   with the 2026-10-18 archive decision? Recommended: yes, keep their nodes.
2. **(David)** Rename the canvas `default` agent to "Campaign Canvas Author" so
   only one agent is called Strategist?
3. Does `core.dispatch` accept a decision list from a non-supervisor upstream as
   is, or does it need an input-mapping tweak? Verify in P3.
4. **(David)** Per-client AI keys (org-scoped BYOK `SecretScope`)? Default: no;
   agency keys, per-client model pin only.
5. Should a client override be refused unless the replacement passes the role's
   eval suite? Recommended: warn in P0, enforce in P4.
   **(2026-10-20, P0 build):** no suites exist until P1, so P0 emits no warning
   and ships no empty `warnings` field. The warning lands with the P1 suites.

## Planning rows

- **ROADMAP** (Campaign Studio program, Tier 0, after 0942): `| 3 | **Campaign
  agent team + per-node assignment** (ADR 0943) | `campaign-ops` (bindings) |
  0941, 0942, 0889, 0829, 0311 | `vendor.openwop-app.campaign-studio.agents` |
  Host extension | 🔵 Proposed |`
- **FEATURES Future features:** "**Campaign agent team (ADR 0943, Proposed)** —
  ten roles as agent manifests with eval suites in
  `vendor.openwop-app.campaign-studio.agents` (Strategist and Media Buyer reused); the agent
  runner honours `nodes[].agent`; per-client agent/model overrides frozen at run
  start; agents assignable as kanban card owners; Producer plans dispatched
  through `core.dispatch`. No new toggle; no RFC."


### Recovery correction — 2026-10-21 (nested client scope)

Fresh subworkflow and canvas-invoke children project the parent campaign-ops stamp
to `{orgId}` only. Approval IDs, change-set hashes and request authority are not
delegated. The existing inherited-metadata registry now supports feature-owned
projectors; existing identity registrations retain their behavior. Parent node-keyed
agent bindings are never inherited: child contributors freeze their own definition's
bindings, including when node IDs overlap. Malformed present client stamps refuse
child creation; conflicting campaign/client stamps remain conflicting. Subworkflow
ancestor reads also enforce the requested tenant. Fork copy semantics are unchanged.

This depends on ADR 0941's canonical-campaign/inheritance prerequisite, now merged
into this branch, and includes the narrow canvas copy formerly present only on the
unsubmitted autonomy P2 branch. Actual-constructor witnesses are authored; execution
pending the next serialized validation slot. Client-memory isolation is validated
with ADR 0944 in the same integration component.


### Recovery composition — 2026-10-25 (validation pending)

The original P1/P4 histories are retained in the recovery candidate. The team
continues to use the existing chat, role bindings, eval runner and key resolver.
New role agents explicitly disable outside-agent exposure. The Strategist keeps
the current campaign/status/autonomy read contract, the three existing safety
eval tasks and the ten recovered tasks; its passing threshold remains 1.
The Team panel binds chat links to both agent and selected client, ignores
obsolete loads, and cancels a pending reset after that client unmounts.
The recovered code is not qualified until focused checks and canonical CI pass.


Recovery harness correction — 2026-10-25 (validation pending): the three
existing Strategist safety cases are golden-output cases with exact tool
arguments, and may forbid a generally offered run tool for a particular task.
The recovered generic role harness now retains those expectations: it scripts
exact arguments and golden text for the follower, and breaks an offered
forbidden call or the golden output for the negative run. It rejects a task
that both requires and forbids the same call, rather than rejecting legitimate
context-specific refusal tests. All thirteen Strategist tasks and threshold1
remain. The composed focused suite still must prove both sides.


Recovery backend qualification — 2026-10-25: native typechecking and the
18-file team/memory suite pass (279 cases). The real eval runner accepts the
scripted follower and rejects the violating run for every recovered role suite,
including all thirteen Strategist cases at threshold 1. The full canonical
gate remains required before merge; no live vendor call was made.

Recovery frontend qualification — 2026-10-25: lint, the canonical frontend
build (token/CSS/branding/bundle gates), unit-test types, and ten focused suites
(77 cases) pass. Entry gzip is 128.0 kB against the existing 129.0 kB budget
(988 bytes of headroom). The full canonical gate remains required.


Recovery suite-version correction — 2026-10-25: the first full canonical run
found the older ADR 0942 P6 regression still requesting suite 1.0.0 after this
change ships 1.1.0. It now resolves the installed pack suite. Its three original
safety scripts and distinct negative axes stay explicit; the ten added tasks
remain passing controls. The generic team-suite test separately discriminates
every task. Both eval test files (33 cases) and native typechecking pass. The
full gate must be repeated; the first run's three failures were not waived.
