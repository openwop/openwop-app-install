# ADR 0943 — Campaign agent team and per-node agent assignment

Status: Proposed

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

### D2 — Per-node binding: the pin is the default, the client override is frozen

1. **Close F1.** `resolveParams` gains a last fallback: `ctx.nodeAgent?.agentId`.
   Order: `inputs` → frozen client binding (below) → `config.agentId` →
   `nodeAgent`. A chain node is therefore authored as
   `{ typeId: 'local.openwop-app.agent-runner', agent: { agentId: '<default>' } }`.
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

### D6 — Model and BYOK

`modelClass` per role (reasoning: Strategist, Media Buyer, CRO, Compliance;
general elsewhere). A client binding may pin `{provider, model, credentialRef}`;
the ref must already be a tenant secret (`chatByokConfig.ts` IDOR rule). Absent
⇒ managed tier. Per-client AI keys are not built (F5, Q4).

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
