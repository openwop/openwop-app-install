# Analytics + BI (unit D6) — chat-first port review

Scope: backend `features/{analytics, usage-analytics, bi}` + frontend
`features/{analytics, usage-analytics, bi}`. Context: BI copilot v1 (semantic
metrics, ADR 0417). Read-only audit.

**Headline verdict: this unit already rides the engine.** The BI copilot is a
pair of `registerFeatureAgentTool` tools allowlisted onto the ONE assistant
agent; analytics ships a real agent pack + node pack + consent-gated beacon;
usage-analytics is an honest read-only dashboard whose ingest is wired at the
dispatch path. There is **no parallel architecture and no orphaned workflow** in
the unit. Findings are two honesty-loop nuances on page surfaces, not ports.

---

## Step 1 — Contract scouting (pinned)

**BI — the copilot IS chat-native, not a bespoke panel.**
- Two chat-time tools registered through the ADR 0308 seam:
  `openwop:bi.list-metrics` + `openwop:bi.run-metric`
  (`backend/typescript/src/features/bi/agentTools.ts:24-85`). Access mirrors the
  route predicate: toggle-gated via `resolveOne('bi', …)` and **fails EMPTY
  without an acting user** (`agentTools.ts:35-37,65-67`) — the read-tool/action-tool
  contract. `run-metric` returns a **typed error** as model feedback, never
  success-with-empty (`agentTools.ts:77-82`).
- **Igniter confirmed:** both tools are allowlisted onto the assistant persona
  (`packs/feature.assistant.agents/pack.json:61-62`), so a user asks a business
  question in the one chat and the chief-of-staff discovers + runs metrics. No
  separate BI chat, no "ask AI" textarea.
- Route + tool share ONE predicate: routes call `authorizeOrgScope` +
  `resolveOne('bi')` (`bi/routes.ts:31-33,95-101`); the tool calls the same
  `biEnabled` toggle check — the shared-helper rule.
- No `WorkflowDefinition` and no `startWorkflowRun` anywhere in `features/bi`
  (grep empty). The node pack emits an `interactive.chart` artifact envelope so a
  workflow/scheduled-agent run renders the numbers
  (`packs/feature.bi.nodes/index.mjs:32-63`); the ADR's "weekly digest = a
  scheduled agent chat calling these — zero new plumbing" is honored, not faked.
- Write-time closed-world validation against the entities registry
  (`bi/biService.ts:63-138`): unknown entityType/field/filter → typed 422, never
  a stored-then-failing metric. The model NEVER passes a filter AST — only a
  metricId + bounded params (`biService.ts:221-306`). System metrics are an
  in-code const merged at read time, never stored (`bi/systemMetrics.ts:70-83`),
  so no seed/fold machinery can duplicate them.

**Analytics — measurement leg already rides three lanes.**
- Public consent-gated beacon (append-only store) + authed org-scoped reporting
  (`analytics/routes.ts:49-71`); the beacon returns an honest `202
  {recorded:false, reason:'consent'}` when unconsented (`routes.ts:56`).
- Real agent pack: `feature.analytics.agents.insights`, RESEARCH persona,
  read-only, tool-allowlisted to `feature.analytics.nodes.query`
  (`packs/feature.analytics.agents/pack.json`); loaded via `requiredPacks`
  (`analytics/feature.ts:36`). Node pack reads over the `ctx.features.analytics`
  thin adapter (`analytics/surface.ts:19-28`).
- Erasure + retention seams both registered (`analytics/analyticsService.ts:231,236-245`);
  identity-link owns the session↔contact floor with a bipartite subject-key
  resolver + namespace guard (`analytics/identityLinkService.ts:87,105-116`).

**Usage-analytics — honest read-only dashboard, ingest wired.**
- `recordUsage` is called from the dispatch path
  (`backend/typescript/src/host/exchange/dispatchTurn.ts:103`) — the store is not
  a dead sink. Dashboard reads `getUsageRollupWithCost(tenantId)`
  (`usage-analytics/routes.ts:15`), token COUNTS + estimated cost only, no prompt
  content. Cost comes from the ONE cost source `computeCostUsd`, unpriced → 0
  (`usageRollupService.ts:59-64`).

---

## Step 2/3 — Verdict table (per capability, ten port tests applied)

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Ask a business question / run a metric in chat | `bi.list-metrics` + `bi.run-metric` on the assistant agent (`agentTools.ts:24-85`, `assistant.agents/pack.json:61-62`) | **RIDES** | leave — chat-first copilot already |
| Run a metric + render a chart in a workflow/scheduled run | `feature.bi.nodes.run-metric` emits `interactive.chart` envelope (`bi.nodes/index.mjs:32-63`) | **RIDES** | leave |
| Discover the governed metric catalog (prompt feed) | `getCatalog` projection, SSoT-parity-tested (`bi/surface.ts:16-37`) | **RIDES** | leave |
| System (CRM/commerce) metrics | in-code const merged at read (`systemMetrics.ts`) | **RIDES** | leave |
| Define / edit / delete a governed metric (admin) | `MetricsPage` form → CRUD routes w/ closed-world validation (`MetricsPage.tsx`, `bi/biService.ts:142-177`) | **PAGE-LEGIT** | keep as admin/governance page; metric CRUD is deliberately a human/admin route (`surface.ts:4-5`) |
| Preview a metric inline on the admin page | `runOne` → run route (`MetricsPage.tsx:72-78`) | **PAGE-LEGIT** | keep |
| Public analytics ingest (pageview/event/conversion/web-vital) | consent-gated append-only beacon (`analytics/routes.ts:49-60`) | **RIDES** | leave |
| Analytics reporting (summary, top paths, UTM, CWV, recent events) | `AnalyticsPage` over authed `summarize`/`listEvents` (`AnalyticsPage.tsx`, `analyticsService.ts:175-213`) | **PAGE-LEGIT** | keep — every tile has a real read; honesty loop closes |
| Analytics insights in chat | `feature.analytics.agents.insights` RESEARCH agent, read-only (`analytics.agents/pack.json`) | **RIDES** | leave — deep-link/scope the one chat to this agent if surfacing |
| Analytics reads inside a workflow | `feature.analytics.nodes.{query,events}` over `ctx.features.analytics` (`analytics/surface.ts`) | **RIDES** | leave |
| Session↔contact identity floor + subject erasure/retention | deterministic writers + erasure/resolver seams (`identityLinkService.ts`, `analyticsService.ts:231-245`) | **ADAPTER** | leave; thin honest owner of the session concept |
| LLM usage/cost admin dashboard | `UsageDashboardPage` over `recordUsage` ingest wired at `dispatchTurn.ts:103` | **PAGE-LEGIT** | keep — but close the org-picker honesty gap (below) |

**Tally: RIDES = 8, ADAPTER = 1, PARALLEL = 0, THEATER = 0, PAGE-LEGIT = 3.**

Port-test spot checks that PASS: Agency (BI tools fail EMPTY w/o acting user,
typed error on failure); Ignition (no orphaned workflow — chart rides the node
+ scheduled-agent chat); Composition (metrics read via entities service, no
parallel query engine — closed-world params, never a filter AST); SSoT
(`getCatalog` is the one projection backing tools AND node prompts,
parity-tested); Authority-parity (route + tool + surface share the toggle/org
predicate); Lifecycle (`bi:metric` store carries the tenant-teardown reaper
`metricStore.ts:10-15`; analytics events + identity-links carry subject-erasure,
retention purge, and the bipartite key resolver).

---

## Blockers (from scouting) — with honest alternatives

**None.** No scouting assumption failed in a way that blocks a port, because
there is essentially nothing to port — the intelligence surfaces already run
through agents + tools + nodes. The two findings below are honesty-loop repairs
on existing PAGE-LEGIT surfaces, filed as fixes, not blockers.

### Finding 1 (honesty loop) — usage dashboard org picker is cosmetic
`usage-analytics/routes.ts:15` calls `getUsageRollupWithCost(user.tenantId)` and
**ignores `req.params.orgId`**; the rollup key is
`${tenantId}:${provider}:${model}` (`usageRollupService.ts:26`) with no org
dimension. The UI renders a multi-org `SelectField`
(`UsageDashboardPage.tsx:78-82`) that implies per-org data, but every org shows
the identical tenant-wide totals. The manual-test even asserts "Per-org — no
cross-org leak" (`manual-tests/suites.ts:1079`), which the data model cannot
honor. **Honest fix (small):** either (a) drop the org picker and label the
surface "workspace-wide usage," or (b) add an `orgId` dimension to the rollup key
+ `recordUsage` call site. (a) is the truthful minimum; (b) is the real feature.
Do NOT leave a picker that filters nothing.

### Finding 2 (capability nuance) — "BI copilot renders charts in chat"
The chart artifact is emitted by the **node** path
(`bi.nodes/index.mjs:47-61`), not by the **agent tool** (`bi.run-metric` returns
`{ result }` JSON — `agentTools.ts:76`). So a chat metric ask returns numbers the
assistant narrates in prose; a rendered chart requires the node in a
workflow/scheduled run. This is honest today (the ADR scopes the tool as a
numeric read), but if the roadmap claims "charts in chat," the truthful path is
to have `bi.run-metric` ALSO return the same `interactive.chart` envelope shape
(reuse the node's builder) so the chat workbench renders it — an additive change,
not a new surface.

---

## Demolition list (with regression pins)

**Empty.** No bespoke "talk to AI" panel, no second chat, no duplicate approvals
button, no orphaned workflow, no parallel query engine exists in this unit to
demolish. The MetricsPage form and the two reporting pages are legitimately
page-shaped (admin config + read-only reporting) and stay.

If Finding 1 is fixed by removing the org picker, pin a test asserting the usage
route is documented/tested as workspace-scoped (kill the misleading per-org
manual-test assertion at `suites.ts:1079`).

---

## New-code inventory (should be SMALL)

- **Finding 1:** either remove ~5 lines of picker UI + fix the manual-test copy,
  OR add an `orgId` field to `UsageRollup` + the `recordUsage` call site + key.
- **Finding 2 (only if "charts in chat" is a goal):** factor the node's
  `interactive.chart` envelope builder into a shared helper and return it from
  `bi.run-metric` as well. Zero new tools, zero new surfaces.

No new agents, workflows, stores, or chat panels are warranted.

---

## Phased plan (gated on real gates)

The unit needs no chat-first port, so this is a short honesty-hardening pass, not
a migration:

1. **Phase 1 (honesty):** resolve Finding 1 — pick (a) truthful label or (b) org
   dimension; update the manual-test suite; close with `/code-review` + a build
   gate. Compliance-safe first: this is a display-honesty repair on a live page.
2. **Phase 2 (optional, roadmap-gated):** if "charts in chat" is promised,
   implement Finding 2's shared envelope builder; `/code-review` + parity test so
   the tool + node chart shapes cannot drift.

No demolition phase (nothing to demolish).

---

## Deferred honestly

- **Metric authoring by describing intent in chat** is deliberately NOT built —
  metric CRUD is a governed human/admin route (`bi/surface.ts:4-5`, "metric CRUD
  stays a human/admin route concern"). This is a defensible governance boundary
  (metrics are closed-world governance objects), not an omission. If a future ADR
  wants NL metric authoring, it must ride the app-builder-style
  `catalog → validate → repair → human-gate` pattern, not a free-form textarea.
- **BI chart in the agent-tool path** is deferred (Finding 2) — honest today
  because the tool is scoped as a numeric read; only becomes a gap if the product
  claims chart rendering in the conversation.
- **Per-org usage attribution** is deferred until the rollup carries an org key
  (Finding 1b) — must not be implied by UI before the data supports it.
