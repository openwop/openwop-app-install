# Strategy suite (unit D3) — chat-first port review

Scope: `backend/typescript/src/features/{strategy, priority-matrix, insights-suite}`
plus `frontend/react/src/features/{strategy, priority-matrix}` (insights-suite has
no SPA surface — see below). Read-only audit; the only file written is this one.

## Headline

This unit is one of the app's **strongest chat-first citizens already** — the
backends were built (or rebuilt) on the engine deliberately: chat-drivable agents
over feature nodes (ADR 0058), scheduled/triggered workflow chains for the
autonomous loops, the shared `ApprovalsInbox` for governance gates, `host.kanban`
for the board, `documents` for agendas/memos, and **no** bespoke "talk to AI"
panel, **no** hidden LLM-behind-a-button route, **no** parallel result store
(insights ADR 0082 deleted its dashboard). The overwhelming majority of surfaces
are RIDES or legitimate structural-editing/reporting pages.

There are exactly **two** real chat-first defects, both the same shape: an
**agent-proposed item whose human decision happens on a bespoke page control that
is invisible to the reviews inbox and to the conversation the agent proposed
from** — strategy check-in confirm/dismiss and priority-matrix scenario
"select as plan of record." The proposal *safety* is structurally correct
(proposals are inert `proposed`/`agent`-stamped rows); the *decision surface* is a
second decision queue outside the owned one. Plus one discoverability gap: neither
feature page bridges to its own chat-drivable agent.

---

## Contract scouting (pinned)

**Strategy**
- Workflow surface is deliberately **read-only + one proposal-write** (`checkIn`);
  `strategyService` CRUD is a human/admin act, never a run write —
  `surface.ts:14-21,100-122`. `user`-scoped private drafts are excluded from the
  subjectless run surface (no cross-tenant draft leak) — `surface.ts:31-32,54-56`.
- Strategy Analyst agent tool-allowlist = 4 reads + `create-board-memo`
  (writes a Document, not strategy) — `packs/feature.strategy.agents/pack.json`
  `toolAllowlist`. The node pack declares more nodes (`check-in`, `sync-metrics`,
  `list-stale-krs`, `record-decision`) but the *agent* is NOT granted the write
  ones — those are for the cadence **workflow chains**, not the free-form agent.
  Toothless-persona test: **passes** (it has a real Documents write + is honestly
  scoped to "recommend/draft, human authors").
- Activation gate RIDES the owner: `registerStrategyActivationApprovalHandler`,
  `kind:'strategy-activation'` `PendingApproval`, resolved from the same
  `ApprovalsInbox` as every other proposal — `activationApproval.ts:22-30,112-114`;
  org-role + IDOR enforced in the handler because the generic route can't —
  `activationApproval.ts:63-74`; CAS-flip-then-compensate on failed transition —
  `activationApproval.ts:82-107`.
- Cadence loops RIDE the scheduler (RFC 0052): `applyCadenceConfig` expands the
  **real** chain packs `strategy.weekly-checkin` / `strategy.metric-sync` /
  `strategy.board-pack` (present at `examples/workflow-chain-packs/strategy/pack.json`,
  covered by `test/strategy-chain-execution.test.ts`) to deterministic per-tenant
  workflow ids and `registerJob`s them — `cadence.ts:42-51,95-122`. Igniter is
  real; **not** theater. Config throws a typed 409 if the chain pack is missing
  (`cadence.ts:102-105`) — honest.

**Priority Matrix**
- An idea IS a `host.kanban` card; the feature owns only criteria sets, score
  overlays, planning sessions, scenarios — `feature.ts:6-11`. Surface reads are
  replay-safe; writes (`submitIdea`, `scoreIdea`, `proposeScenario`) are
  `role:action` proposal-safe — `surface.ts:17-136`. `proposeScenario` stamps
  `proposedBy:'agent'`, inert until a human selects — `surface.ts:116-136`.
  **No `promote` verb** on the surface (promotion grants authority ⇒ human/route
  only, architect ruling) — `surface.ts:149-151`.
- Prioritization Analyst agent = 6 reads + `submit-idea`/`score-idea`/
  `generate-agenda` (all proposal-safe surface writes) — `packs/feature.priority-matrix.agents/pack.json`.
- Federated portfolio = fail-soft SSRF-guarded read-merge of peer portfolios, no
  secrets at rest — `federationService.ts:1-18`. Read-only reporting.

**Insights-suite** (ADR 0082 — the reference "rebuilt ON the engine")
- Pure composition: 3 agents + node pack + **3 builtin meta-workflows** wired to
  REAL nodes (`core.bigquery.query`, `core.workday.query`, `core.ai.chatCompletion`,
  `core.email.draft` (never-sends), `core.approvalGate`, `notification-push`) —
  `metaWorkflows.ts:26-121`. Ignition: scheduler (weekly-variance) + RFC 0099
  trigger (anniversary) + chat/builder — `insightsSuiteService.ts:92-139`. The
  only durable row is `insights:config`; **no dashboard, no result store, no seed**
  (routes 93-95 note the deleted read routes) — `routes.ts:93-96`. Toggle-OFF
  tears down every armed schedule/subscription — `insightsSuiteService.ts:150-164`.
  No SPA surface (`grep insights-suite frontend/react/src` = only `manual-tests`).
  Workflows fail-closed at execute without BYOK connectors — honest deferral, not
  theater.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| **Strategy** |
| Author/edit strategy (narrative + OKR objectives/KRs + initiatives + links) | bespoke editor pages (`StrategyDetailPage.tsx`) | **PAGE-LEGIT** (structural editing; ADR says CRUD is a human/admin act) | keep |
| Portfolio / list / alignment / health / timeline reads | `StrategyPage`, `StrategyAlignment`, `StrategyViews` | **PAGE-LEGIT** (reporting/projection) | keep; reads back-canonical (no denormalized `strategyIds[]`) |
| Version list / snapshot / content-only restore | `routes.ts:426-476` + page | **PAGE-LEGIT** (provenance) | keep |
| Strategy Analyst agent (audit gaps, draft memo) | agent pack over nodes, main chat | **RIDES** (ADR 0058 agent+nodes) | keep; add page→chat deep-link (below) |
| Board-memo authoring → `documents` | `create-board-memo` node | **RIDES** (documents owner; strategy surface stays read-only) | keep |
| Activation gate (draft→active) | `strategy-approval-gate` toggle | **RIDES** (shared `ApprovalsInbox`, `activationApproval.ts`) | keep — reference implementation |
| Cadence: weekly-checkin / metric-sync / board-pack | scheduled chain packs | **RIDES** (RFC 0052 scheduler + real chains) | keep |
| Metric sync (sourced-KR confirmed writes) | `syncMetrics` surface verb | **RIDES** (write only against human-configured `measure.source`, fail-closed) | keep |
| Human check-in entry (KR value/note) | inline form, `routes.ts:393-419` | **PAGE-LEGIT** (structural data entry ⇒ confirmed) | keep |
| **Agent-PROPOSED check-in confirm/dismiss** | bespoke buttons `StrategyDetailPage.tsx:556,584-589` | **PARALLEL** (2nd decision queue, off-inbox, off-chat) | project proposed check-ins into the reviews inbox as a decision kind AND/OR render as an in-chat interrupt card when the agent proposed one |
| Decisions log (`record-decision`) | `routes.ts:587` + node | **ADAPTER** (durable decision record; honest) | keep |
| Planning KB reindex/retrieve | `strategyKnowledgeService` over `kbService` | **RIDES** (knowledge owner) | keep |
| **Priority Matrix** |
| Idea capture / intake overlay / evidence | `IdeaIntakePanel`, forms | **PAGE-LEGIT** (structural; also agent `submit-idea`) | keep (dual lane is fine) |
| Score ideas vs weighted criteria | scoring table/matrix/grid | **PAGE-LEGIT** (structural; also agent `score-idea`) | keep |
| Rank / portfolio / vote-breakdown / score-history reads | `PriorityListPage`, `PriorityListViews` | **PAGE-LEGIT** (projection) | keep |
| Status board | `host.kanban` (idea = card) | **RIDES** (no parallel board) | keep |
| Planning-session agenda | `generateAgenda` → `documents` board-agenda | **ADAPTER/PAGE-LEGIT** (composes documents; agent `generate-agenda`; degrades to inline md) | keep |
| Prioritization Analyst agent | agent pack over nodes, main chat | **RIDES** (ADR 0058) | keep; add page→chat deep-link |
| Scenario propose (agent) | `proposeScenario` stamps `agent`, inert | **RIDES** (proposal-safe surface) | keep |
| **Scenario "select as plan of record"** | bespoke button `ScenarioPanel.tsx:75-77,123` | **PARALLEL** (same off-inbox/off-chat decision surface) | same as check-in: inbox projection / interrupt card for agent-proposed scenarios |
| Promote idea → project / initiative | `promoteIdeaToProject` route, human-only | **PAGE-LEGIT** (authority-granting ⇒ deliberately no surface verb) | keep — correct posture |
| Federated portfolio merge | `federationService` | **PAGE-LEGIT/ADAPTER** (fail-soft SSRF-guarded read-merge) | keep |
| **Insights-suite** |
| 3 domain agents (Financial/Talent/Communication) | agent pack | **RIDES** (ADR 0058) | keep |
| 3 meta-workflows (variance/anniversary/talent) | builtinWorkflows, real nodes | **RIDES** | keep |
| Ignition (scheduler + trigger + chat/builder) | `applyConfig` reconcile seam | **RIDES** (RFC 0052 + RFC 0099) | keep |
| In-workflow gates (variance red-team, draft approval) | `core.approvalGate` nodes | **RIDES** (shared gate primitive, inline in run) | keep |
| Result surfacing (runs/artifacts/notifications) | no dashboard/store | **PAGE-LEGIT** (deliberate non-ship, ADR 0082) | keep |

Aggregate: **R=15, A=1, P=2, T=0, PL=13** (a handful of rows carry a dual
verdict — counted by their primary classification).

---

## Blockers (from scouting) — with the honest alternative

1. **Agent-proposed decisions have no home in the shared decision surface.** When
   the Strategy Analyst (in chat) or a cadence run proposes a check-in, or the
   Prioritization Analyst proposes a scenario, the durable `proposed` row lands
   silently. The *only* way a human learns of it is to open that specific strategy
   detail page (`StrategyDetailPage.tsx:584-589`) or scenario panel
   (`ScenarioPanel.tsx:123`). The activation gate already shows the right pattern
   (`activationApproval.ts` → `ApprovalsInbox`). **Alternative:** register a
   reviews-inbox decision kind (`strategy-checkin`, `pm-scenario`) whose
   claim/reject reuses the existing `approvalDecision` core and calls the same
   `decideCheckIn` / `selectScenario` owner method — the page controls become a
   second *renderer* of one owned queue, not a second queue. Where the proposal
   originated in a conversation, additionally surface it as an
   `interrupt`/typed-renderer card in that conversation (the app-known,
   i18n-critical, trusted-producer shape ⇒ typed registered renderer per the
   card-mechanism test, NOT A2UI).

2. **No page→chat bridge for either analyst agent.** Both features ship
   chat-drivable agents (ADR 0058) but neither `StrategyDetailPage` /
   `PriorityListPage` deep-links `navigate('/?agent=…')` nor embeds
   `EmbeddedChatPanel` (grep: zero hits). The intelligence is reachable only if
   the user already knows to open the main chat and pick the agent. **Alternative:**
   the ProjectChatTab / `CreateWithAiPanel` precedent — a "Ask the Strategy
   Analyst" affordance that deep-links the main chat scoped to the agent (or drops
   in `EmbeddedChatPanel` with `agentId`), no second chat.

Neither blocker is theater and neither is a wire change — both are host-side
completions of an already-correct backend.

---

## Demolition list (with regression pins)

Small, because little is bespoke-that-shadows-a-primitive. After the inbox
projection lands:
- **Do NOT delete** the check-in / scenario page controls — they are legitimate
  *renderers* on the working surface. Demolish only the assumption that they are
  the *sole* decision path: pin a test asserting a proposed check-in / agent
  scenario appears in the reviews-inbox enumerator and that claim/reject there and
  on the page resolve the *same* row (CAS, no double-decide).
- Pin: no new "talk to AI" surface or LLM-behind-a-button route may be added to
  either feature (there is none today — grep for `chatCompletion`/`core.ai` in
  `strategy`/`priority-matrix` routes/services = zero; keep it zero).

---

## New-code inventory (should be SMALL)

- 2 reviews-inbox decision kinds (`strategy-checkin`, `pm-scenario`) + their
  handler registration, reusing `approvalDecision` core and the existing
  `decideCheckIn` / `selectScenario` owner methods (no new decision logic).
- Optional: 1 typed registered renderer per kind for the in-conversation card
  (display) + reuse of the `interrupt.<kind>` capture path.
- 2 page→chat deep-link affordances (or `EmbeddedChatPanel` drop-ins) — pure
  frontend, zero backend.
- Reads/seams: an enumerator that lists a tenant's open agent-proposed check-ins /
  scenarios for the inbox (a projection over existing `proposed` rows — prefer a
  projection over a new store).

No new workflow, no new node pack node, no new agent, no wire/RFC surface.

---

## Phased plan (gated on real gates)

- **P1 — inbox projection (compliance/honesty first).** Add the two reviews-inbox
  decision kinds as *additional renderers* over the existing `proposed` rows;
  page controls unchanged. Gate: `npm run ci` + a test pinning
  page↔inbox same-row CAS. Close with `/code-review`.
- **P2 — in-conversation cards.** For proposals that originated in a conversation,
  render the typed card inline (display) + interrupt capture. Gate: build +
  4-locale parity. Close with `/code-review` + `/ux-review`.
- **P3 — page→chat bridge.** Deep-link/embed the analyst agent from each feature
  page. Gate: frontend build (token/CSS integrity) + `/ux-review`.
- No demolition phase — nothing is being removed, only completed.

---

## Deferred honestly

- **Insights-suite live output** is real but requires BYOK BigQuery/Workday
  connectors; workflows validate but fail-closed at execute without them
  (`metaWorkflows.ts` header). Feature is OFF by default. This is honest
  deferral, not a gap to "fix."
- **Federation peer tokens** ride deploy-time env secrets, not BYOK refs
  (`federationService.ts:1-18`) — out of chat-first scope; noted, not ported.
- **Insights config UI** — there is no SPA surface; config is set via the
  host-extension route only. Whether it needs a settings page is a product call,
  not a chat-first defect (results already surface through runs/notifications).
