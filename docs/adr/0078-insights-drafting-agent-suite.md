# ADR 0078 - Insights & Drafting Agent Suite

**Status:** Superseded by ADR 0082 (the dashboard/read-model parts) — 2026-06-20. The bespoke
dashboard + `VarianceReport`/`TalentSnapshot` read model + demo seeder + mock-ai workflows this
ADR shipped were a parallel solution beside the workflow engine; ADR 0082 rebuilds the feature
ON the engine (real Workday/BigQuery/LLM nodes; workflows surfaced through runs/chat/
notifications) and DELETES the parallel surface. KEPT from 0078/0080/0081: the compute nodes,
agents, schedule/trigger reconciliation, and classification/retention/erasure.
(Originally: Accepted, implemented 2026-06-19 Phases 1–4.)
**Date:** 2026-06-19
**PRD:** a supplied product brief for a role-scoped agent suite — automated financial variance analysis, "in-voice" communication drafting, and talent/succession insight, surfaced through one trusted interface for a designated principal (e.g. an org leader).
**Depends on / composes:** ADR 0001 (feature-package architecture), ADR 0006 (RBAC), ADR 0015 (workspace-as-tenant), ADR 0002 (SSO/OIDC AuthN), ADR 0011 (KB/RAG — "voice" exemplars), ADR 0034 (external-event trigger ingestion), ADR 0050 (per-recipient notifications), ADR 0052 (versioned releases / **scheduler**, RFC 0052), ADR 0057 (document rendering → PDF), ADR 0070 (quorum review policies — the red-team gate), ADR 0072 (AI workflow authoring — the agent+nodes pattern), ADR 0073 (`EmbeddedChatPanel` seam). **Hard prerequisites:** ADR 0076 (BigQuery connector + email-draft node) and ADR 0077 (PII masking / classification / retention).
**Surface:** host-extension under `/v1/host/openwop-app/insights-suite/*` (a new `insights-suite` feature-package) + three agent packs, a node pack, and scheduled/triggered meta-workflows. No wire change.
**RFC gate:** **no new RFC** — all routes are non-normative host-extension; the three agents ride the **already-Accepted** RFC 0070 (agent manifests) the same way ADR 0002's SSO rides RFC 0050. **One conditional:** the "Verify Source" provenance (§Decision 6) is designable as host-extension run metadata; *if* a future iteration wants query-provenance as a **portable, cross-host run-event field**, that single piece needs an OpenWOP RFC — flagged, not assumed.

## Why this exists

A designated principal (an org leader) has no single, trusted surface that (a) tells them *where the business is off-plan this week*, (b) drafts authentic recognition messages without ghost-writing effort, and (c) shows *who is ready for what* across the org — all with the governance a person at that altitude requires (never auto-send, always cite the source, never leak PII). Today this is disparate manual reports and fragmented comms.

The strategic point for *this* app: the suite is **not new infrastructure**. openwop-app already ships the scheduler, trigger ingestion, agent runtime, KB/RAG, quorum review, notifications, PDF rendering, and the embeddable chat. The suite is the **assembly** of those primitives into one principal-scoped surface — the ADR 0072 / ADR 0058 "chat-drivability = agent + nodes" pattern applied to three operational workflows. Building it as a feature-package proves the platform's composability and avoids a parallel system.

## Feature-refinement audit (prove nothing is "new" that already ships)

| Concept the brief asks for | Existing owner (`file:line`) | Decision |
|---|---|---|
| Scheduled weekly run (e.g. "Tuesday 06:00") | RFC 0052 scheduler — `host/schedulingService.ts`, `host/scheduleDaemon.ts` (cron + IANA tz, fire-once/missed-window collapse, multi-instance lease) | **Compose.** Register a `ScheduledJob` that starts the variance meta-workflow. No new scheduler. |
| External trigger → list scan | RFC 0099 trigger ingestion — `host/triggerIngestionService.ts` (webhook/email/form → run, signature verify, SSRF guard) (ADR 0034) | **Compose.** A trigger subscription drives the anniversary meta-workflow. Source→trigger mapping is a connector concern (ADR 0076). |
| 3 agents (Financial / Communication / Talent) | Agent packs + registry + dispatch — `executor/agentRegistry.ts`, `host/agentDispatch.ts` (tool-allowlist **enforced** at `:110`); `GET /v1/agents` | **Author 3 agent packs.** No new agent runtime. |
| Two-model "red-team" cross-check | Quorum gate `host/approvalService.ts` + `host/reviewDecisionLedger.ts` (ADR 0070); DAG fan-in + arbiter pattern proven by the `Triple-AI review board` premade template (`builder/templates/premadeWorkflows.ts`) | **Compose into a template** (`tmpl.insights.variance-dual-critic`): Model A ∥ Model B → arbiter → `core.approvalGate`. No new node type. |
| HITL "always draft for approval" | Governance default `approval-required` + approval inbox + quorum (ADR 0028/0050/0070) | **Compose.** Comms + financial outputs gate on approval before any side effect. |
| "in-voice" style retrieval | KB/RAG + cited retrieval + content-trust — `features/kb/kbService.ts`, host vector surface `ctx.db.vector` (ADR 0011); agent memory `host/subjectMemory.ts` | **Compose.** A KB collection of the principal's past messages = the voice exemplars the Communication agent retrieves. |
| RBAC + principal-scoped context | `host/accessControlService.ts` (per-`(subject,org)` scopes, fail-closed) (ADR 0006); runs stamp `run.metadata.actingUserId` | **Compose.** Suite routes gate on a new `insights-suite:view` scope; runs act as the configured principal. Context is scoped to that identity to prevent cross-leakage of sensitive talent data. |
| SSO/OIDC corporate login | SAML/SCIM/OIDC/TOTP (ADR 0002) | **Compose.** No auth work. |
| Notify the principal | `getNotificationEmitter()` + web-push, `recipientUserId` targeting (ADR 0050) | **Compose** via `ctx.notification.emit`. |
| Summary PDF | Markdown→PDF render node + route (ADR 0057) | **Compose** a render step into the variance workflow. |
| Cost/token per invocation | `observability/costEmitter.ts` per-node + per-run rollup | **Compose** — already emitted; surface in the dashboard. |
| Dashboard page + nav | Feature-package frontend pattern (`features/registry.ts`); `DataTable`, `.surface-card`, `KeyFigureBand`, Kanban | **New page**, reusing primitives. No core nav edits (manifest-driven). |
| Chat interface for the principal | `EmbeddedChatPanel` seam (ADR 0073) | **Compose** — embed scoped to a router agent. |

**No route collision** (`grep insights-suite` → none). **No concept duplication** — the feature *composes* `accessControl`, `connections`, `kbService`, `governanceService`, the scheduler, and the chat; it owns only its dashboard, its 3 agents, and its meta-workflows. Data warehouse/HRIS access + email drafting + PII/retention are deliberately **factored out** to ADR 0076/0077 because they are reusable beyond this suite.

## Decision

Add an `insights-suite` feature-package that assembles existing primitives into one principal-scoped operational surface. Deliverables:

1. **Three agent packs** (`feature.insights-suite.agents.{financial,communication,talent}`), each a manifest agent (RFC 0070) with a hardcoded `systemPromptRef` (boundary + refusal), a `toolAllowlist` (enforced at dispatch), and `modelClass`:
   - **Financial** — tools: `bigquery.query` (read-only, ADR 0076), `variance.compute`, `documents.render`. Forbidden: any write tool.
   - **Communication** — tools: KB retrieve (voice exemplars), `email.draft` (ADR 0076 — draft only, never send). Style rule in prompt: humble/gratitude tone, ban "rockstar"/buzzwords.
   - **Talent** — tools: `workday.read` (read-only), `talent.score` (9-box), KB retrieve. Read-only HRIS.

2. **Node pack** (`feature.insights-suite.nodes`): `variance.compute` (Actual vs Plan for sales/margin/labor/shrink per BU), `talent.score` (9-box readiness from development-plan logs). Pure compute nodes; data arrives via the ADR 0076 connectors.

3. **Scheduled + triggered meta-workflows** (pinned built-ins, ADR 0072 pattern):
   - `openwop-app.insights.weekly-variance` — scheduled (cron, principal's tz) → BigQuery read → `variance.compute` → **red-team gate** → `documents.render` (PDF) → `notification.emit`. Each output stamps `report.dataAsOf` (data-freshness, mitigating the brief's stale-data risk).
   - `openwop-app.insights.anniversary-draft` — trigger (work-anniversary event) → list scan → KB voice retrieve → draft → `email.draft` (to Drafts) → approval. Never sends.
   - `openwop-app.insights.talent-prep` — on-demand/scheduled → development-plan scan → `talent.score` → dashboard projection (talent-review preparation).

4. **Red-team governance gate** — a reusable template `tmpl.insights.variance-dual-critic`: two AI nodes (distinct `modelClass`/provider) analyze the same variance in parallel; an arbiter node compares; a `core.approvalGate` (ADR 0070) blocks surfacing until consensus + (optionally) human sign-off. Mitigates the brief's "model sycophancy/hallucinated figures" risk.

5. **Dashboard + chat** — a feature page (`/insights-suite`) with three zones: a **financial variance** view (`DataTable` + `KeyFigureBand`, status chips never color-alone), a **9-box talent matrix** (custom CSS-grid, token-only — no charting lib needed; see Open Questions), and the principal's chat (`EmbeddedChatPanel` scoped to a router agent that can hand off to the three specialists). Notifications surface via the existing inbox.

6. **"Verify Source" provenance** — the Financial agent's `bigquery.query` node records the exact SQL + `dataAsOf` in node-output provenance (reusing the artifact-provenance shape, ADR 0069). The dashboard renders a "Verify Source" affordance that reveals the query + timestamp. *(Host-extension metadata; the RFC conditional in the header applies only if this becomes a portable run-event field.)*

**Data model (feature-owned, `DurableCollection`):** `InsightsSuiteConfig` (per-tenant: principal userId, BU scope, schedule cron+tz, plan-source binding), `VarianceReport` (runId, BU, metrics, dataAsOf, sourceQuery, verdict), `TalentSnapshot` (subjectId, performance, potential, readiness, asOf). All Confidential/PII rows classified per ADR 0077; entities `Employee`/`BusinessUnit`/`SalesMetric`/`DevelopmentPlan`/`SuccessionScore` from the brief map onto these + existing org/accessControl identities (no new "employee" store — reuse `accessControl` members + a Workday-sourced read model).

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | `src/features/insights-suite/` (service + `routes.ts` + `feature.ts`); appended to `BACKEND_FEATURES`/`FRONTEND_FEATURES`; composes core, never edits core nav/routes. |
| 2 | **Toggle + admin UI** | `insights-suite` toggle, **default off**, `bucketUnit: tenant` (a shared, role-scoped surface). Manageable in `FeatureTogglePanel`. |
| 3 | **Workflow surface (ADR 0014)** | `ctx.features['insights-suite']` exposes read ops (`getVariance`, `getTalentSnapshot`) behind the toggle + RBAC; advertised at `/.well-known/openwop` only when enabled + honored. |
| 4 | **Node pack** | `feature.insights-suite.nodes` (`variance.compute`, `talent.score`) — signed via the registry pipeline; `requiredPacks` includes the ADR 0076 connectors. |
| 5 | **AI-chat + envelopes** | Drives through the existing chat scoped to the agents (no new envelope type needed for v1; the agents' tool calls carry intent). |
| 6 | **Agent pack** | `feature.insights-suite.agents.{financial,communication,talent}` — three personas with enforced allowlists + hardcoded boundary prompts (prompt-injection control). |
| 7 | **Public surface** | **None.** Strictly internal/authenticated; not added to `PUBLIC_PATH_PREFIXES`. |
| 8 | **RBAC + isolation** | New `insights-suite:view` scope (principal/admin only); every route toggle+scope gated, tenant+org IDOR-guarded, fail-closed. Read=view; the connectors are read-only (ADR 0076). |
| 9 | **Replay/fork** | Scheduled-run variant + `dataAsOf` stamped in `run.metadata` at creation, read verbatim on `:fork`; packs decoupled from toggle state. |
| 10 | **Frontend** | `insightsSuiteClient.ts` + `InsightsSuitePage.tsx` + `routes.tsx` (nav via menu registry); `ui/` primitives + a11y + tokens (DESIGN.md). |

## Phased plan

1. **Agents + node pack + read model** — author the 3 agent packs, the `variance.compute`/`talent.score` nodes, and the feature service/routes (read-only). *Gate:* backend vitest; `GET /v1/agents` lists the three; route-level RBAC test.
2. **Meta-workflows + red-team template** — pin the three built-ins; author `tmpl.insights.variance-dual-critic`; wire scheduler + trigger subscriptions. *Gate:* a scheduled-fire test + a dual-critic arbiter test.
3. **Dashboard + chat embed** — the feature page (variance view, 9-box, notifications) + `EmbeddedChatPanel` scoped to the router agent + "Verify Source". *Gate:* `npm run build` + chat/builder vitest + `/ux-review`.
4. **Governance binding** — classify all feature rows (ADR 0077), confirm PII masking on logs, approval-required defaults on comms/financial side effects. *Gate:* a no-PII-in-logs test + an approval-required test.

## Alternatives weighed

- **One bespoke system (the brief's implicit GKE/MCP/A2A build).** Rejected — duplicates the scheduler, agent runtime, KB, governance the app already has; fights ADR 0001. The feature-package assembly is strictly more maintainable.
- **A second chat panel for the principal.** Rejected per the "reuse, never recreate" rule (CLAUDE.md) — embed `EmbeddedChatPanel` (ADR 0073).
- **Bundle connectors + governance into this ADR.** Rejected — BigQuery/email-draft and PII/retention are reusable platform work; factoring them (0076/0077) keeps single-source-of-truth and lets them serve other features.

## Open questions

1. **9-box rendering** — custom token-only CSS-grid (recommended, no dependency) vs adding a charting lib (Recharts) for variance trend lines. Lean CSS-grid for the matrix; defer charts.
2. **Workday read model** — sync via scheduled BigQuery/Workday pull into a feature read model vs live per-request connector calls (latency vs freshness). Lean cached read model with `asOf`.
3. **Router agent vs three @-mentionable agents** — a single router that delegates (orchestration pack) vs the principal @-picking each specialist. Lean router-with-handoff for a single pane.
4. **"Verify Source" portability** — keep as host-ext metadata (v1) vs propose an OpenWOP run-event field (needs `/prd` + RFC). Lean host-ext for v1.

## Brief-vs-architecture corrections

- **GKE / A2A / MCP-as-the-architecture** → the app is a Cloud Run host; the orchestration substrate already exists. MCP is available (client+server) if a source is only reachable via MCP, but BigQuery/Workday are better as **connection packs** (ADR 0076). A2A auth exists at the HTTP layer; mutual-auth is a later hardening item, not a v1 blocker for an internal tool.
- **"Voice cloning"** → reframed as **RAG over the principal's past messages** (KB exemplars), not model fine-tuning.
- **Employee/BusinessUnit as new entities** → reuse `accessControl` identities + a Workday-sourced read model; do not stand up a parallel HR store.
- **Persona scoping** → the suite is scoped to a *configured principal* (a userId/role in `InsightsSuiteConfig`), not hardwired to any one title; any leader/role the operator assigns can own it.

## Implementation corrections (Phase 1 — architect review 2026-06-19)

1. **RBAC: use `workspace:read`, NOT a new `insights-suite:view` scope (CRITICAL).** Decision /
   Matrix-row-8's proposed `insights-suite:view` would have to be added to the RFC 0049
   `PROTOCOL_SCOPES` wire vocabulary — a **wire change requiring an OpenWOP RFC**, contradicting
   this ADR's own "no new RFC" verdict. Every existing feature (priority-matrix, analytics, crm)
   gates reads on the existing **`workspace:read`**. So the suite gates reads on `workspace:read`
   (in the configured BU/org) + the feature toggle + a principal check against
   `InsightsSuiteConfig.principalUserId` for principal-only views. Finer admin gating, if ever
   needed, uses a `host:`-prefixed MANAGEMENT scope (host-local, no RFC) — never a new protocol scope.
2. **Phase-1 agents are LISTED, not yet live-executable (C1).** The 3 agents are authored + appear
   in `GET /v1/agents` with their `toolAllowlist`, but live-chat tool *execution* of
   `core.bigquery.query` / `feature.insights-suite.nodes.*` requires them to run as **meta-workflow
   nodes** (Phase 2, the workflow-author precedent) — the live agent tool loop only wires
   `openwop:knowledge.search` today. KB-retrieve works live now; the data/draft tools execute via
   P2 workflows. `toolAllowlist` entries are `openwop:<toolId>`; node typeIds themselves are bare
   (`core.bigquery.query`).
3. **Node typeIds are hyphen-segmented under the feature namespace (C3):**
   `feature.insights-suite.nodes.variance-compute` + `...talent-score` (not bare `variance.compute`,
   which would sit in the `core.*` dotted convention outside the feature namespace). Shipped as a
   signed node pack `packs/feature.insights-suite.nodes/` (pure compute; host-native is reserved for
   connector/host-surface nodes like ADR 0076's).
4. **PII classification done in P1, not deferred to P4:** `declarePiiFields('insights.talentSnapshot',
   [...])` at service module load (ADR 0077) — `TalentSnapshot` is confidential-pii; `VarianceReport`
   is internal (no person fields); `InsightsSuiteConfig.principalUserId` is an opaque id, not declared.

## Implementation corrections (Phase 2 — architect review 2026-06-19)

1. **Real typeIds (C4).** The Decision §3 node names were aspirational; the meta-workflows
   use the actual registered typeIds: `core.bigquery.query`, `feature.insights-suite.nodes.
   {variance-compute,talent-score}`, `core.approvalGate`, **`feature.documents.nodes.render`**
   (not `documents.render`), **`core.openwop.integration.notification-push`** (not
   `notification.emit` — that's a ctx surface, not a node), `core.email.draft`,
   `knowledge.retrieve`, `local.sample.demo.mock-ai`.
2. **No workflow-level trigger (C1); per-edge `triggerRule`.** Fan-in/sequencing is on
   `EdgeDef.triggerRule` (`all_success`), not a top-level field.
3. **Red-team arbiter IS the `core.approvalGate` (C3).** Two critic nodes fan in
   (`all_success`) to a single approvalGate that bundles them as consensus options (the
   Triple-AI-review-board precedent) — not a separate arbiter-then-gate pair.
4. **The dual-critic template ships as a feature BUILTIN, not the core
   `host/workflowTemplates.ts` catalog** — a core file importing the feature's definition
   would break the ADR 0001 boundary (core must not import features). It resolves by its
   `tmpl.insights.*` id via catalog source A (`getBuiltinWorkflow`) just the same.
5. **Closed-world validity is the P2 gate.** `builtinWorkflows` registration does NOT
   validate typeIds; a test asserts `findUnknownTypeIds(def)` finds no invented typeIds for
   all four definitions (catching the gap that also existed for the workflow-author builtin).
6. **Stable schedule job id.** The config→schedule reconcile id is
   `insights-weekly:<tenant>:<principal>` — deliberately NOT `personalScheduleId` (which bakes
   the cron into the hash, so a changed/removed cron would orphan the prior job instead of
   replacing/deleting it). `applyConfig` registers on cron-set, deletes on cron-absent.
7. **Scope:** P2 ships loadable/validatable artifacts (3 builtins + the dual-critic) + the
   scheduler-registration seam at config-set (`PUT .../config`, `workspace:write`). Live
   end-to-end execution (BigQuery/BYOK/PDF/email) is deferred — the nodes fail closed at
   execute without credentials; `runnableNodeTypeIds()` gates on advertised surfaces, not live
   creds, so the definitions validate without them.

## Implementation corrections (Phase 3 — architect review 2026-06-19)

1. **Embed scoped to the Financial agent + @-mention, NOT a router agent (C1).** No
   orchestrator agent exists in the pack (P1 authored exactly three specialists, and
   `EmbeddedChatPanel` takes a single `agentId`). The dashboard embeds scoped to
   `feature.insights-suite.agents.financial` (the primary surface); the principal reaches
   `@communication` / `@talent` via the existing composer @-mention. Building a 4th router
   agent is backend work, out of P3 scope — Open Q #3 resolved this way.
2. **9-box is a token-only CSS grid (C2).** No charting lib; a new `.insights-9box` 3×3
   `grid` block in `global.css` using only `--space-*`/`--radius-lg`/`--color-surface-2`/
   `--color-border`/`--clay-*` (passes check-css-tokens + check-tsx-color-literals).
3. **Reused primitives:** `PageHeader` (the editorial title), `DataTable` (variance),
   `KeyFigureBand` (key figures, `tone:'attention'` on off-plan), `.chip--success/--danger`
   (status carries a TEXT label, never color alone), native `<details>` for "Verify Source"
   (a11y by default). The first real consumer of the `EmbeddedChatPanel` seam (ADR 0073).
4. **i18n auto-registers** by directory glob (`insights-suite` namespace); en + pt-BR at
   parity (check-i18n fatal). One-line append to `FRONTEND_FEATURES`; nav manifest-driven
   (no core nav edit).

## Implementation corrections (Phase 4 — architect review 2026-06-19)

P4 is **verification, not new binding code** — the prior phases already satisfy the gate:

1. **Approval-required is STRUCTURAL, not `governanceService.actionPolicyOf`.** The
   action-policy gate (ADR 0028) is consumed only at the *assistant* action loop
   (`features/assistant/action{Approval,Execution}.ts`); the suite's side effects are
   *workflow nodes* (`core.email.draft`, `core.openwop.integration.notification-push`),
   which do not consult it. The suite's approval-required guarantee is instead enforced by
   (a) an in-workflow `core.approvalGate` upstream of every surfacing/egress node
   (weekly-variance: gate → render → notify; anniversary-draft: an approvalGate + a
   draft-only email node) and (b) `core.email.draft`'s structural never-send (fixed
   create-draft URL, `Mail.ReadWrite` not `Mail.Send`). **The suite registers nothing with
   `governanceService`.**
2. **Classification was done in P1** (`declarePiiFields('insights.talentSnapshot',
   ['subjectId'])`); P4 verifies it. `VarianceReport` = internal (no person fields),
   `InsightsSuiteConfig.principalUserId` = opaque (RFC 0048, undeclared), `TalentSnapshot`
   = confidential-pii. `subjectId` is in the PII union, so it is masked in logs
   automatically (inherited from ADR 0077 P2).
3. **Deliverable:** a governance-binding test asserting (a) classification + union
   membership, (b) a talent `subjectId` masked in logs (no over-masking of the 9-box
   numbers), (c) the STRUCTURAL no-auto-side-effect invariant (approvalGate upstream of
   render/notify; no send-capable node typeId in any meta-workflow). No new surface.

## RFC verdict

**Host-extension — no new RFC.** Agents ride Accepted RFC 0070; scheduler RFC 0052; triggers RFC 0099; all routes under `/v1/host/openwop-app/insights-suite/*`; RBAC reuses `workspace:read` (no new protocol scope — see Phase-1 correction §1). **Conditional:** portable query-provenance ("Verify Source" as a cross-host run-event field) would need a new OpenWOP RFC — out of scope for v1; flagged in Open Questions.
