# ADR 0961 — Brief-to-launch autopilot

Status: Proposed

Date: 2026-10-19. Program: Campaign Studio (ADRs 0941–0962), Tier 5 capstone.
Source: the program brief (session 66) and David's original ask: "all as
workflows with dedicated agents executing work per node … as much or as little
HITL as each campaign needs." Net-new feature, not a MyndHyve port.

## Context

Every other ADR in the program builds a block: the canonical campaign (0941),
the autonomy policy (0942), the agent team (0943), client memory (0944),
grounded creative (0945), variants (0946), proofing (0947), funnels (0948),
experiments (0949), promotion (0950), behavior analytics (0951), paid media and
caps (0952), social (0953), leads (0954), lifecycle (0955), attribution (0956),
reporting (0957), external collaborators (0958), playbooks (0959) and the command center (0960).
This ADR composes them into **one campaign workflow**:

brief → research → plan → creative → proof → funnel → channels → launch →
experiments → optimize → report → learn

Each step is a sub-chain owned by its block, run by a named agent, at the
autonomy level the campaign sets — from "review everything" to "full autopilot"
— toward an outcome goal inside a budget. Human-led work drops onto the
campaign's kanban board instead of stalling.

Competitors are converging on the same promise. Meta tests end-to-end "give us a
product image and a budget"; Salesforce ships a Campaign Creation agent (brief →
audience → content → journey) with plan approval; HubSpot Breeze lets a play
"review before send" or "send automatically". Each is a black box inside one
vendor's channel. Ours is **transparent** (every step is a visible graph node
with an owner), **gated** (per action class, by role, per campaign), **replayable**
(every decision can be re-run deterministically), and **multi-client** (one
agency, many isolated clients, one playbook).

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths under `backend/typescript/src/` unless they start with `docs/`,
`examples/`, `schemas/` or `../openwop/`.

**What exists and is reused:**

| Need | Existing owner | Evidence |
|---|---|---|
| Today's campaign spine | chain pack `core.openwop.workflows.campaign-orchestration` 1.1.0, chainId `campaign-studio.campaign-orchestration` (`examples/workflow-chain-packs/campaign-orchestration/pack.json`) | validate → kernel → `core.approvalGate` → supervisor + `core.dispatch` fan-out of 5 channels → production plan → consistency → finalize (`features/campaign-orchestration/orchestrationWorkflow.ts:1-35`); registered chain-backed, `features/index.ts:382` |
| Existing block chains | packs `campaign-brief` (`campaign-studio.messaging-kernel`, `campaign-studio.market-intel`), `campaign-channels` (5 channel chains), `funnels` (`funnels.optimize-step`), `campaign-journeys` (3), `market-intel-digest`, `production-plan` | `examples/workflow-chain-packs/*/pack.json` |
| Sub-chain composition | RFC 0133 **Accepted** (`../openwop/RFCS/0133-workflow-chain-composition.md`) | `subChains[]` + `config.subChainRef`, `host/workflowChainPackLoader.ts:166-192`; `coRegisterSubChains` `:1932`; depth 8 `:1877`; a fragment must NOT pin `config.workflowId` (`chain_fragment_pins_workflow_id`, `:451-453`) |
| Produced variables between stages | RFC 0133 §2 | `producedVariables[]` `:191`, `ProducedVariable` `:178` |
| Parallel fan-out + join | RFC 0118 | `core.dispatch` `fanOutPolicy:'parallel'`, `orchestrationWorkflow.ts:14-19` |
| Per-node named agent at runtime | executor | `AgentRef` `executor/types.ts:373-380`; `nodeAgent` "so node modules can honor `nodes[].agent.agentId`" `:440-443`; `executor/agentRegistry.ts`; `subruns/subRunDispatcher.ts` |
| Human gates | `core.approvalGate`, `host/approvalService.ts` (`'campaign-spend'` `:44`), `approvalSla.ts`, `escalationNotify.ts` | |
| Decision freezing at run start | ADR 0099 `host/runStartContext.ts:66-73` | |
| Run definition pinning | ADR 0474 `host/resolveRunDefinition.ts:58` | |
| Replay never re-fires effects | `executor/sideEffects.ts:1-25` (ADR 0341/0572) | |
| Kanban stacks | ADR 0311 `openwop:kanban.add-todo` (`host/agentToolProvider.ts:399-412`, allowlisted `host/agentToolAllowlistService.ts:69`); ADR 0313 executable todos; campaign board via ADR 0852 `campaignProject.ts` | |
| Schedules | `host/schedulingService.ts`, `host/scheduleDaemon.ts`, `host/cronSchedule.ts` | |
| Budget recommendations | `features/campaign-intel/intelligence.ts:12-41` (`BudgetReallocation`, `optimizeBudget`); pacing bands `pacing.ts:24` | |
| Eval gate | ADR 0889 (implemented); chain `agents.eval-regression-gate` (`examples/workflow-chain-packs/agent-eval-regression-gate/pack.json`); ADR 0927 scenario pack | |

**Gaps (measured):**

| Gap | Evidence | Consequence |
|---|---|---|
| A-G1 **A chain cannot say which agent runs a node.** `FragmentNode` has `id, typeId, name, position, config, inputs, compensation, irreversibleEffect` only, and both manifest schemas are closed (`additionalProperties:false`, `schemas/workflow-chain-pack-manifest.schema.json` and `schemas/v2/…`; `workflowChainPackLoader.ts:131-147`) | The "named agent per node" thesis is not expressible in a portable chain today; it exists only on the expanded `WorkflowDefinition` |
| A-G2 Version-pinned external sub-chains are not resolved | from-chain passes no `resolveExternal` (`routes/workflows.ts:1148-1156`); string refs resolve the GLOBAL registry by id (`workflowChainPackLoader.ts:1914-1922`) | Closed by ADR 0959 D2; this ADR depends on it |
| A-G3 The spine pins children by id | `orchestrationWorkflow.ts:80-86` channel nodes carry `config.workflowId` (runtime dispatch by id, a chain-backed host workflow, legal there) | The autopilot must compose the spine via `subChainRef`, not copy its pinned ids |
| A-G4 No "wait for a kanban card" step | the todo seam creates cards (ADR 0311) and runs bare todos (ADR 0313); no node suspends a run until a card is done (grep: none) | Human-led stages cannot be resumed by finishing the card |
| A-G5 No campaign goal object | `MarketingCampaign` has `objective` (free text), `budget`, `utm` (`features/campaign-orchestration/types.ts:14-36`) | No machine-checkable target for optimize/report. Closed by ADR 0941 D1/D2b (`CampaignGoal`), which this ADR consumes |
| A-G6 Doc rot | `orchestrationWorkflow.ts:2-5` still says "Registered via `BackendFeature.builtinWorkflows`"; the toggle description says "Channels run sequentially today; parallel fan-out is a planned upgrade" (`features/campaign-orchestration/feature.ts:50-52`) while parallel is the default (`orchestrationWorkflow.ts:12-19`) | Misleads readers; fix in P0 |

## Decision

### D1 — The autopilot is one chain pack of sub-chains, not code

A new chain pack `core.openwop.workflows.campaign-autopilot`
(`examples/workflow-chain-packs/campaign-autopilot/`), chainId
`campaign-studio.autopilot`. Each stage is a node with `config.subChainRef` to
a chain owned by its block ADR, declared in `subChains[]` with a pinned version
(external refs, resolved by ADR 0959 D2):

| Stage | Sub-chain (owner) | Lead agent role (0943) |
|---|---|---|
| preflight | `campaign-studio.autopilot.preflight` (this ADR) | Producer |
| research | `campaign-studio.market-intel` (existing) + 0954 ICP read | Strategist |
| plan | `campaign-studio.messaging-kernel` (existing) + plan node; 0952 budget split | Strategist, Media Buyer |
| creative | 0945 grounded creative → 0946 variant factory | Creative Director, Copywriter |
| proof | 0947 staged review (internal → compliance → client) | Compliance Reviewer |
| funnel | 0948 funnel blueprint | Copywriter (step copy), CRO Analyst |
| channels | parallel `core.dispatch`: 0952 paid, 0953 social, 0955 lifecycle, 0954 lead routing | Media Buyer, Lifecycle Marketer, Lead Qualifier |
| launch | 0952 governed unpause + 0953 schedule + 0955 enable, each behind the 0942 gate | Media Buyer |
| experiments | 0949 register + lock pre-registration | CRO Analyst |
| optimize | 0950 promotion + 0952 reallocation — **cadence runs**, D4 | CRO Analyst, Media Buyer |
| report | 0957 report narrative — cadence runs | Reporting Analyst |
| learn | 0944 per-client memory write, 0853 decision capture, 0889 promote-run-to-case | Strategist |

The existing `campaign-studio.campaign-orchestration` chain is not replaced: it
remains the "draft every channel from a brief" chain and becomes the default
`channels`-draft sub-chain for tenants without 0952/0953/0955 (graceful
composition). Stages exchange ids (briefId, planId, variantSetId, funnelId,
experimentIds) through RFC 0133 produced variables, never through shared mutable
state.

A tenant never edits this pack. A campaign is launched from an **installation**
(ADR 0959 D4): the agency's playbook pins `campaign-autopilot@x.y.z` and its
sub-chain versions, supplies config layers, and may bind its own chain into a
stage slot. That is how "as much or as little" varies per client without forking
the spine.

### D2 — Named agent per node: host binding now, RFC later (A-G1)

v1 binds agents **after expansion, host-side**: the playbook version (0959
`agentBindings`) maps `nodeId → default agentId`, and ADR 0943 D2's client
binding (keyed by that pinned agentId, never a role name) may replace it at run
start. The binder writes `nodes[].agent = {agentId}` onto the
owned expanded definition before `registerWorkflow` (the field is legal there,
`executor/types.ts:373-380`). The binding is part of the content hash, so a run
pins the agents it ran with (ADR 0474). A node with no binding runs as its
node type's default (no implied agent).

**RFC flag (non-blocking, recommended; owned by ADR 0941 D9):** to make "which agent role runs this
step" portable across hosts, propose an **additive RFC 0013 revision** that
lets a `FragmentNode` carry an `agent` (an `agent-ref.schema.json` role/ref,
copied onto the expanded node) — the same "mirror a WorkflowNode field onto
FragmentNode" move RFC 0013 already made for `condition` and RFC 0125 for
`triggerRule` (`workflowChainPackLoader.ts:150-164`). Until it lands we do
NOT put agent ids in `config` (node modules would see an undeclared key, and it
would be a second, host-only spelling of the same fact). Author via `/prd`.

### D3 — Autonomy: one dial, frozen at launch, enforced per action

The campaign's autonomy is ADR 0942's policy (presets *Review everything*,
*Guarded*, *Full autopilot*, plus per-action-class overrides). It is resolved
and frozen into the run at launch (0942's run-start contributor), copied
verbatim on every stage child and `:fork`. Every external-effect node in every
sub-chain passes 0942's single gate primitive; the autopilot adds no gate
logic of its own. **Full autopilot is never unbounded:** hard caps (0952), content
rules (0933), consent (0951/0955), product fidelity (0945) and the client's
approval setting (ADR 0924 D4, folded into ADR 0942 D9) are refusals, not approvals, and still apply.

### D4 — Long campaigns are a launch run plus cadence runs

One run that lives for weeks would hold a growing event log, block playbook
upgrades and make replay coarse. So:

- **Launch run** (`role:'spine'`): preflight → … → experiments, ends when the
  campaign is live.
- **Cadence runs** (`role:'optimizer'` / `'report'`): the `optimize` and `report`
  sub-chains are scheduled per campaign through `schedulingService` (daily
  optimize, weekly report by default), each a short run carrying the
  ADR 0941 D2b run tag (indexed in 0941's per-campaign run index) and pinned to the installation's version at fire time.
  A playbook upgrade (0959) therefore lands between cycles, never mid-cycle.
- **Close-out run** on the end date or goal reached: final report + `learn`.

Each run is independently replayable; the command center (0960) shows them as
one campaign.

### D5 — Goals and budget are first-class and frozen

`CampaignGoal` is ADR 0941's (D1): an `outcome` (metric, target, `by`), a
`mediaBudget` (`totalMinor`, `currency`, `dailyCapMinor?`) and `guardrails`, with a
`version` bumped on every edit. This ADR does not redefine it; it asked 0941 to
include `purchases`, `qualified_leads` and `cpl` in the metric list, which 0941
now does. A goal edit takes effect at the next cycle's run start.

Frozen into each run's metadata at start as `campaignGoal` by ADR 0941's
run-start contributor (nothing on `derivedFromRun`). A `goal-check` node (this ADR's node pack) reads progress
from 0956 attribution and emits `on-track | at-risk | off-track` with the
numbers; the optimizer acts on it only through 0950/0952 actions, each gated by
0942. Budget caps are enforced by 0952, not by this ADR (one owner of money).

### D6 — Kanban-stack fallback for human-led work (A-G4)

A stage runs **agent-led** or **human-led** (per stage, from the 0942 policy or
the playbook). Human-led, an agent failure, or a typed refusal (missing
connection, missing product image) does not fail the campaign: the stage's
`handoff` node creates a card on the campaign project's board (ADR 0852) via
the ADR 0311 seam, carrying a structured handoff note (ADR 0829), and suspends
on a **card interrupt** — a new interrupt kind resolved when the card reaches
Done (or the card's assignee submits its result form). This is new host work
(P3). The reverse also holds: a person can **stack** a stage chain onto the
board as a card, and an agent or person picks it up (CLAUDE.md "a chain can be
stacked").

### D7 — Preflight: honest about what is not configured

The first stage is a read-only check that returns a typed result, never a
silent skip: required connections bound for the client org (pinned per ADR
0921 D4), caps set, sending domains verified (0905/0906), consent topics
present (0951/0955), product linked to the catalog with images (0945), agent
team bound (0943), and **eval status** (D8). Missing items surface as one
checklist card; the run suspends on it (D6) instead of failing late.

### D8 — Evals are the release gate for autonomy

An autonomy level above *Guarded* can be selected for a client only when the
playbook version's agent suites (ADR 0889) and the ADR 0927 campaign scenario
pack pass for that version. ADR 0959 uses the same check as a rollout-ring
health gate (`agents.eval-regression-gate`). A failing or regressed suite drops
the effective level to *Guarded* at the next run start (recorded in the stamp,
shown in 0960), and never mid-run.

### D9 — Entry points: the one chat and the hub

- **Chat:** the Strategist agent (0943) drives launch through the one chat
  (`navigate('/?agent=<strategist>')`): it reads the brief, proposes goal,
  budget and autonomy, and calls a `campaign.launch-autopilot` tool that creates
  a *launch proposal* a person approves (ADR 0942 class `plan.approve`). No new chat panel.
- **Hub:** "Launch" on a confirmed brief in `/campaign-studio`; opens the 0960
  command view.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | New `features/campaign-autopilot/` (launch service, cadence scheduler wiring, card interrupt resolver, `routes.ts`, `surface.ts`, `feature.ts`). Fixes A-G6 doc rot in `campaign-orchestration` in P0. |
| 2 | Toggle | `campaign-autopilot`, default **OFF**, `bucketUnit: 'tenant'`, `dependsOn: ['campaign-orchestration', 'projects']`, `recommends` every block toggle. Launch also requires the sub-toggle `campaign-orchestration.autonomy` (ADR 0942) ON, checked in code, because `dependsOn` names features, not sub-toggles (ADR 0194). Separate from `campaign-orchestration` so an operator can kill autonomous launches without losing drafting. |
| 3 | Workflow surface | `ctx.features.campaignAutopilot`: `getGoal({orgId, campaignId})`, `goalProgress(...)`, `preflight(...)` (read); `requestLaunch(...)` (write → proposal, gated). Every op takes `orgId` and checks the run tag's client (ADR 0941 D2b; the ADR 0921 D3 check). |
| 4 | Node pack | `feature.campaign-autopilot.nodes`: `preflight` (read), `goal-check` (read), `stage-handoff` (creates card + card interrupt; `role:"side-effect"`), `stage-outcome` (writes produced variables). |
| 5 | Envelopes | None. Model output reaches state only through each block's closed-world validation and 0942 gates. |
| 6 | Agent pack | No new agent; the 0943 roster runs the stages. The Strategist gains `campaign.launch-autopilot` (pack-allowlisted, not default-on, ADR 0315). |
| 7 | Public surface | None. Client approvals ride 0924; client reports ride 0957. |
| 8 | RBAC | Launch: `workspace:write` on the client org + the approver of the launch proposal's 0942 `plan.approve` rule. Autonomy above *Guarded*: client-org admin, and only with D8 green. Cadence runs act as the launching user's delegated authority re-checked per fire (the ADR 0886/0887 "grants checked once" lesson). |
| 9 | Replay / fork | Definition pinned (ADR 0474); policy, goal, playbook and agent bindings frozen at start; side-effect nodes never re-fire on replay; stage children are RFC 0133 child runs. Branch forks follow 0942's fork posture (ADR 0942 D10.4). |
| 10 | Frontend | Launch wizard on the brief (goal, budget, autonomy preset with a plain-language summary of what will need approval), then the 0960 Command tab. No new graph viewer, no new chat. |

## Why this is our advantage

- **OpenWOP primitives used:** chain packs + RFC 0133 sub-chains and produced
  variables, RFC 0118 parallel fan-out, named agents per node, role-routed gates
  with SLA, run-start freezing, revision pinning, deterministic replay/fork,
  kanban stacks, eval suites, client-org isolation.
- **Competitor gap:** Meta's and Google's automation is opaque and per-channel
  (silent creative swaps, AI Max rewrites); Salesforce's agent is single-vendor
  and heavy; HubSpot's approval mode is per play, not per action class and
  audience; GoHighLevel's Agent Studio has no approval node. None can replay a
  campaign decision, run per client with isolated agents and memory, or fall
  back to a human board without breaking the run.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0** | Package + toggle; A-G6 doc fixes; consume 0941's `CampaignGoal` and goal stamp; chain pack v0.1 = preflight → existing kernel chain → existing channel-draft chain (drafts only, no external effect) | Route test: launch from an installation stamps goal + campaign + playbook; replay fork reproduces; all four locales |
| P1 | Preflight node (D7) with typed checklist; agent binding post-expansion (D2) | A client with no ad connection gets a checklist card, not a failure |
| P2 | Creative, proof, funnel stages as 0945–0948 ship; produced-variable hand-offs | Each stage witness runs under *Review everything* with every effect gated |
| P3 | Card interrupt + `stage-handoff` (D6) | Moving the card to Done resumes the run exactly once (CAS on the interrupt) |
| P4 | Launch stage + cadence runs (D4) with 0949/0950/0952 | Daily optimizer run pinned to the installation version; upgrade lands between cycles |
| P5 | Eval release gate (D8) + autonomy above *Guarded* | Failing suite downgrades effective level at next run start (test) |
| P6 | Report + learn stages (0957, 0944, 0853, 0889 promote) | Close-out run writes per-client memory only (isolation test from 0944) |

## Alternatives weighed

- **One giant run per campaign.** Simplest mental model; rejected for event-log
  growth, mid-campaign upgrade impossibility and coarse replay (D4).
- **A supervisor agent that improvises the plan (pure agentic).** Flexible, but
  not reviewable or replayable as a plan, and it is the black box we compete
  against. We keep supervisors inside stages (RFC 0006), not as the spine.
- **Extend `campaign-orchestration` instead of a new toggle.** Fewer packages,
  but no separate kill switch for autonomous spend. Rejected.
- **Agent ids in node `config` (no RFC).** Rejected in D2: an undeclared key and
  a second spelling of `nodes[].agent`.

## RFC verdict

**Host extension for v1; one recommended additive RFC, flagged loudly but not
blocking.** Sub-chain nesting already landed (RFC 0133 Accepted 2026-07-23), so
composition needs no new RFC. The gap is A-G1: a chain fragment cannot carry
`agent`. v1 binds agents host-side on the expanded definition (wire-legal). A
portable agent-per-node chain needs an **RFC 0013 revision adding
`FragmentNode.agent`** (additive, mirrors `WorkflowNode.agent`); next step `/prd`
in `../openwop`. The card interrupt (D6) is a host interrupt kind surfaced
through existing run states; if it must be visible as a distinct wire interrupt
type to other clients, that would be a further RFC — v1 keeps it host-only.

**Doc rot to correct with this program:** CLAUDE.md says sub-chain nesting and
a run-produced variable bag are not yet expressible; RFC 0133 expresses both.

## Open questions

1. **(David)** Default autonomy preset for a new client: *Review everything*
   (proposed) or *Guarded*?
2. **(David)** May *Full autopilot* ever launch paid spend for a client without
   a client-side approval, if the client's 0924 policy is `agency`? Proposed:
   only under a 0952 hard cap, and with a notify-after digest.
3. **(David)** Should we author the RFC 0013 `FragmentNode.agent` revision now
   (portable agent intent) or wait until a second host needs it?
4. Default cadence (daily optimize, weekly report) — per playbook or per client?
5. *Resolved in program review:* `CampaignGoal` lives on `MarketingCampaign`,
   owned by ADR 0941 D1.
6. Card interrupt: a new interrupt kind in this package, or a generic
   "wait for todo" seam owned by ADR 0311's kanban code? Proposed: generic seam
   in core, used here.

## Planning rows

- **ROADMAP:** `| 0961 | Brief-to-launch autopilot | campaign-autopilot (feature.campaign-autopilot.*, chain pack core.openwop.workflows.campaign-autopilot) | top-level campaign chain of block sub-chains (RFC 0133), named agent per node, 0942 autonomy dial, goals + budget, cadence optimize/report runs, kanban fallback, eval release gate | deps 0941–0959, 0960, 0889, 0927, 0311, 0852; recommended RFC 0013 rev (FragmentNode.agent) | Tier 5 | 🔵 Proposed |`
- **FEATURES (Future features):** `| campaign-autopilot | Campaign autopilot | Turn a brief into a running campaign: research, plan, creative, funnel, channels, experiments and optimization as one visible workflow, each step run by a named agent, with as much or as little human review as you choose, inside a budget and toward a goal. | OFF | tenant | ADR 0961 |`
