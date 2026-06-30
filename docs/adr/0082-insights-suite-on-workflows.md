# ADR 0082 - Insights & Drafting Suite, rebuilt ON the workflow engine

**Status:** implemented (2026-06-20)
**Date:** 2026-06-20
**Supersedes:** the dashboard/read-model parts of **ADR 0078** (Insights & Drafting Agent
Suite) and **ADR 0081** (its completion). The compute nodes, agents, schedule/trigger
reconciliation, BigQuery/Gmail connectors, retention/erasure, and data-classification work
from 0078/0080/0081 are KEPT and composed; only the parallel surface is removed.
**Surface:** host-extension only — a new connector provider + a connector node + rewired
built-in workflows + deletion of a bespoke page/store/seed. No wire change, no new RFC.

## Why this exists (the correction)

ADR 0078 shipped the suite as a **bespoke dashboard** (`InsightsSuitePage`) over a **parallel
read model** (`VarianceReport`/`TalentSnapshot` `DurableCollection`s) populated by a **demo
seeder** (`demoSeed.ts`, hardcoded rows), with **fake analysis** (`talent-prep` /
`anniversary-draft` used `local.sample.demo.mock-ai`) and **no Workday source at all**. That
is a parallel solution beside the workflow engine — exactly the anti-pattern the repo forbids
("ONE chat, never a parallel panel"; generalized: never build a parallel surface/store for
what the orchestration + run/chat/notification surfaces already do).

The value of an insight/draft feature IS the orchestration: **source → analyze → act →
notify**. This ADR rebuilds it that way: real source/analysis/draft/notify **nodes**,
composed as real **workflows**, surfaced through the **existing** runs / artifacts / chat /
notification surfaces. The "insight" is the LIVE output of a run against a real
(BYOK-connected) source — not a seeded table.

## Decision

**Build on the engine; delete the parallel surface.**

### Build
1. **A `workday` BUILTIN provider** (`features/connections/providerRegistry.ts`) — apiHosts
   pinned to `workday.com` / `myworkday.com` (the per-tenant `{instance}.workday.com/{tenant}`
   is supplied at connection time via the existing connection pack's `instanceUrlTemplate`),
   `oauth2`/`pkce`, `readOnly` (HCM/succession read — no write scope group). Mirrors the
   `bigquery` / `microsoft-graph` / `gmail` dedicated builtins (a connection pack carries no
   `apiHosts`, so it fails closed at `brokeredFetch` — the P2/P6 learning).
2. **A `core.workday.query` connector node** (`bootstrap/nodes.ts`, beside `bigquery.query` /
   `email.draft` — the proven connector-node location with guaranteed `ctx.connectors`).
   Pulls workers / performanceReviews / serviceDates via the broker (apiHosts pin + acting-
   human BYOK + `connections:use` + RFC 0079 provenance). Output carries `{ rows, rowCount,
   resource, baseUrl }` (the deterministic "Verify Source" provenance).
3. **Rewire the 3 built-in workflows to real nodes** (drop every `mock-ai`).

### The 3 workflows (real typeIds)
- **Financial variance** (weekly, scheduled): `core.bigquery.query` → `variance-compute`
  (KEEP — this IS the financial-analysis node) → `core.approvalGate` → `documents.render`
  (secondary) → `notification-push` (primary).
- **Talent readiness** (on-demand/scheduled): `core.workday.query` (replaces mock-ai `scan`)
  → `talent-score` (KEEP) → `notification-push`.
- **Recognition drafting** (Workday-anniversary triggered): `core.workday.query` (milestones)
  → `knowledge.retrieve` → `core.email.draft` (KEEP — Gmail/Graph, NEVER sends) →
  `core.approvalGate` ("Approve draft" — relabeled; the node only drafts) → `notification-push`
  ("you have N drafts to review").

### Delete (the parallel surface)
`InsightsSuitePage.tsx`, the FE feature route + nav entry, `insightsSuiteClient.ts`, FE i18n;
the backend read routes (`GET /variance`, `/variance/:id`, `/talent`); the `VarianceReport` /
`TalentSnapshot` collections + their service fns + `declarePiiFields('insights.talentSnapshot')`;
`demoSeed.ts` + its `index.ts` wiring + the showcase fallback; `varianceDualCriticDefinition`
(3 mock-ai nodes).

### Keep (load-bearing, NOT a parallel store)
The `variance-compute` + `talent-score` compute nodes (real, reused, still projected as agent
tools); the 3 agents (financial/talent/communication — drive the workflows via the EXISTING
chat, ADR 0058); the `builtinWorkflows` seam; **`InsightsSuiteConfig` + `applyConfig` + GET/PUT
`/config`** — this is feature CONFIG (which BUs, the cron, the anniversary-trigger toggle) that
reconciles the schedule (P4) + trigger (P6) onto the workflows; it is workflow-engine
integration, not a result store. Only the *result* collections are deleted.

### Surface insights as RUN OUTPUTS
Runs list + run detail/artifacts, the one chat (`WorkflowRunBubble` / completion card, agent-
driven), notifications (`run.completed` + the `notification-push` "drafts to review"). No
bespoke page. Launch via chat / builder / scheduler (RFC 0052) / trigger (RFC 0099) — all exist.

## Boundaries

No parallel store (config kept as legitimate config; result collections deleted), no bespoke
page, no demo seed. New node → core node registry (where bigquery/email live); new provider →
`providerRegistry`; workflows → `builtinWorkflows`; results → existing surfaces. The
`insights-suite` BACKEND feature shrinks to {packs + toggle + config/reconciliation + builtin
workflows}; the FRONTEND feature is removed (no page).

## Phased plan (each phase: build → test → /code-review)

1. **Workday source** — `workday` builtin provider + `core.workday.query` node + tests
   (apiHosts pin, readOnly consistency, fail-closed, URL construction, mock-broker rows).
   *Must precede Phase 2 (closed-world validation needs the typeId registered).*
2. **Rewire workflows** — replace mock-ai in `metaWorkflows.ts`; delete the dual-critic;
   relabel the draft gate; tests (closed-world valid, edge port-mapping, reconciliation).
3. **Agent drivability** — add `core.workday.query` to the Talent (+Financial) allowlists; tests.
4. **Delete the parallel surface** — page/route/nav/client/i18n + read routes + result
   collections + demoSeed + index wiring; grep-prove zero dangling imports; `npm run ci`.
5. **Docs** — mark 0078/0081 `Superseded by 0082`; FEATURES.md (feature shrank to
   config+packs+workflows, no dashboard); phase→commit/test ledger here.

## Live-creds caveat (honest)

The Workday provider + node ship **code + mock tests**; true end-to-end needs a live Workday
tenant + API Client (integration-system-user). Interactive (chat) runs use OAuth2 PKCE;
unattended (scheduled) runs ride a refreshable OAuth connection — the ISU refresh-token mint
(Workday's analog of P2's BigQuery SA-JWT) is a deferred sub-phase. Same posture as ADR 0076
P2/P3 for BigQuery/Graph.

> **Operator gate (INS-2):** because the connector's only automated coverage is the mock
> broker, the **first live deploy is the first real exercise** of ISU auth + URL construction.
> Stage the Workday node against a live (sandbox) tenant before enabling the `insights-suite`
> toggle in production — see DEPLOY.md § "Insights Suite — Workday connector (stage before
> enabling in prod)".

## RFC verdict

**Host-extension — no new RFC.** A `providerRegistry` entry + a node-pack typeId on the
non-normative `connectorInvoker`/`brokeredFetch` path + host catalog workflows + surfacing on
the existing runs/chat/notification wire. No run-event field, capability, or endpoint contract
changes. Rides accepted RFC 0095 (connection packs) + RFC 0093 (SSRF egress), like bigquery/gmail.

## Phase → commit / test ledger (implemented 2026-06-20)

| Phase | What landed | Tests |
|---|---|---|
| P1 | `workday` builtin provider + `core.workday.query` connector node | `workday-connector.test.ts` |
| P2 | 3 workflows rewired to real nodes (workday/bigquery/LLM); mock-ai + dual-critic deleted | `insights-suite-meta.test.ts` |
| P3 | `core.workday.query` added to Talent + Communication agent allowlists | `insights-suite.test.ts` (agent list) |
| P4 | DELETED: dashboard page, FE route/nav, client, i18n, read routes, result collections, demo seeder | full backend vitest + FE build (no dangling imports) |
| P5 | ADR 0078/0081 marked superseded; FEATURES.md updated; this ledger | — |

Verification at completion: backend `tsc` clean + full vitest **2205 passed / 0 failed**;
frontend `npm run build` green (tsc + token/CSS/i18n/bundle gates). Live-creds caveat (Workday)
per the section above.

## Implementation corrections (from the architect review)

- **No separate "financial-analysis node"** — `variance-compute` already is it.
- **Keep `InsightsSuiteConfig` + `applyConfig` + `/config`** (reconciliation seam, not a result store).
- **`core.workday.query` goes in core `bootstrap/nodes.ts`** (the connector-node precedent: bigquery/email), not the `.mjs` pack (pack nodes don't receive `ctx.connectors`).
- **Relabel the anniversary "send" gate to "Approve draft"** — `core.email.draft` never sends.
