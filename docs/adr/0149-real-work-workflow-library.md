# ADR 0149 — Real-Work Workflow Library (20 substantive workflows over existing primitives)

**Status:** Accepted (decision record) — connection packs landed; the workflow definitions await a **workflow-pack loader (RFC 0013)**, the correct home (2026-06-27)
**Date:** 2026-06-27

## Implementation record

| What | Status |
|---|---|
| 3 RFC 0095 **connection packs** (`google-ads`, `meta-ads`, `netsuite` under `examples/connection-packs/`; OAuth2 `reach:openapi`, no secret; loaded by the existing `connectionPackLoader`) | ✅ landed |
| The 20-workflow catalog (this ADR's tables) — the product intent | ✅ recorded (design) |
| **Workflow-pack loader (RFC 0013)** — peer to node/agent/connection loaders | ✅ landed (ADR 0152 / `host/workflowChainPackLoader.ts`) |
| First workflow-chain pack published to packs.openwop.dev (`core.openwop.workflows.market-intel`) | ✅ landed |
| **Lighthouse 5 authored as a chain pack** (`examples/workflow-chain-packs/lighthouse/` — Lead Triage, Account Brief, Renewal/Churn-Risk Digest, RFP Response, Post-Meeting Follow-up) over this host's shipped `feature.crm/kb/analytics` + `core.ai.chatCompletion` + `core.chat.approvalGate` + `core.openwop.integration.*` typeIds; feeds the ADR 0163 builder gallery | ✅ landed (ADR 0163 follow-on) |
| **Exec/Chief-of-Staff cluster authored** (`examples/workflow-chain-packs/exec-ops/` — Daily Executive Briefing, Meeting Prep & Attendee Dossier, Board/Investor Update Pack) over the shipped feature + `core.ai.chatCompletion` + `core.chat.approvalGate` + `core.openwop.integration.*` typeIds; connector-touching steps (#2 M365 calendar, #4 NetSuite finance) bind a connection pack via `core.openwop.http.openapi-call` `connectionRef` (configured under Access & data → Connections; unconfigured ⇒ connect prompt) | ✅ landed |
| **People/HR + Finance + Marketing + IT/Support clusters authored** (`examples/workflow-chain-packs/{people-hr,finance,marketing,it-support}/` — the remaining 11: #5,6,7,8,11,12,13,14,15,16,20) over host-resolvable typeIds (feature.crm/kb/cms/email + `core.ai.chatCompletion` + `core.chat.approvalGate` + `core.flow.if` + `core.openwop.integration.*`); connector steps bind Workday/M365/Jira/NetSuite/Google-Meta-Ads via `core.openwop.http.openapi-call` `connectionRef`. #6's auto-apply-within-guardrail is a `core.flow.if` conditional branch (open-question resolution: a flow conditional, **not** a new primitive). | ✅ landed |
| **All 20 ADR 0149 workflows now authored as RFC 0013 chain packs.** | ✅ catalog complete |

> ### §Correction (2026-06-27) — the implementation deviated; it was reverted
> An initial build shipped the 20 workflows as a **new pinned `host/workflowLibrary.ts`
> module with a `lib.*` namespace, a catalog-resolver branch, and a bespoke
> `GET …/workflow-library` route**. That was an **architecture deviation**: a fourth,
> parallel pinned-catalog path alongside `workflowTemplates.ts` (`tmpl.*`),
> `exampleWorkflows.ts`, and the builder registry — and a parallel discovery route.
> It was **reverted**. The reasoning trail below (boundaries audit, the 20-workflow
> catalog, the connector analysis) is retained because it is still correct; only the
> *home* was wrong. The decisive facts:
> - The established in-host homes for shared workflows are **deterministic-stub-only**:
>   `workflowTemplates.ts` enforces `ALLOWED_TYPE_IDS = {mock-ai, approvalGate,
>   subWorkflow}` (test-pinned, "no new I/O node"); the frontend `PREMADE_WORKFLOWS` is
>   restricted to 5 executable nodes. Neither accepts real feature/connector I/O.
> - The OpenWOP protocol **already defines a workflow(-chain) pack kind**
>   (`schemas/workflow-chain-pack-manifest.schema.json`, RFC 0013) — peer to node,
>   agent, prompt, connection, and artifact-type packs — but **this host has no
>   workflow-pack loader** (it has `connectionPackLoader`, `promptPackLoader`,
>   `artifactTypePackLoader`). That missing loader is the correct, protocol-aligned
>   home; standing up a pinned module beside the catalog was the wrong shortcut.
> **Decision:** build a **workflow-pack loader** (next ADR) implementing the existing
> RFC 0013 manifest, register it as a catalog source like the others, then ship these
> 20 workflows as a **signed workflow pack** whose connector-bound entries bind the
> connection packs landed here. The boundaries/connector/replay analysis in this ADR
> feeds that work directly.

> **Origin.** The demo app seeds *shape* demos, not *work*: `lead-triage`
> (summarize → approve → notify) and `doc-summary` (extract → summarize), plus the
> ADR 0032 44-template library — almost all 2–4 node `local.sample.demo.mock-ai` +
> `core.approvalGate` stubs. They prove the engine runs HITL DAGs; they do not
> represent a job anyone is paid to do. The MyndHyve corpus (`src/seeds/workflows/`)
> had the opposite — deep, multi-phase, parallel-branching pipelines (Vibe Marketing's
> 13 phases, AI-First Research → Research-to-Action, the document-RAG ingestion
> pipeline) — but skewed almost entirely marketing-vertical. This ADR catalogs **20
> real-work workflows** spanning exec/CoS, marketing/advertising, people, finance,
> sales/customer, and IT/support, and records the decision to ship them as
> **workflow packs composing the primitives we already have** — not a new surface.

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a workflows feature" — a new authoring surface, a new run model,
a curated dashboard of canned runs. That is exactly the
[[build-on-orchestration-not-parallel-surfaces]] anti-pattern (the `/insights-suite`
failure): a parallel surface + parallel read model + demo-seed. **Rejected.**

The decisive finding of the pre-ADR seam audit is that **every primitive these
workflows need already exists and is accepted.** A "real workflow" here is a
`WorkflowDefinition` (a graph of already-registered trigger / feature / integration /
flow nodes) authored once and pinned — the same shape as `workflowTemplates.ts`
(ADR 0032) and `workflowAuthorSeed.ts`. Nothing net-new on the wire, no new surface.

| Concern | Existing owner (file / pack) | How this library reuses it |
|---|---|---|
| Time triggers (cron / cadence) | `core.trigger.schedule`, `core.trigger.cron-advanced` + the fleet scheduler daemon (`host/scheduleDaemon.ts`, `host/schedulingService.ts`; RFC 0052) | Ambient workflows (daily briefing, ad-optimization loop, renewal digest) register a `ScheduledJob` that fires `POST /v1/runs`. No new scheduler. |
| Event / inbound triggers | `core.trigger.webhook`, `core.trigger.event`, `core.trigger.form`, `core.trigger.mailhook` (`packs/core.openwop.triggers`) | Lead-intake, ticket-intake, invoice-arrival, RFP-arrival fire from a webhook / form / mailhook. No new ingress. |
| App-feature reads | `feature.crm.nodes.*`, `feature.kb.nodes.{search,rag}`, `feature.cms.nodes.*`, `feature.email.nodes.*`, `feature.forms.nodes.*`, `feature.analytics.nodes.*` | Workflows read live tenant data through the shipped feature node packs (ADR 0008/0009/0011/0014/0018) — not mock data. |
| Outbound actions | `core.openwop.integration.{email-send,slack-message,sms-send,notification-push,chat-message-generic}` | Drafts/notifications go out through the existing integration pack, every side-effect behind a `core.approvalGate` (ADR 0032 draft/recommend autonomy). |
| External systems (CRM/HRIS/tickets/calendar/ads) | Connection packs (RFC 0095) — `examples/connection-packs/{salesforce,workday,jira,microsoft365,notion,github}` + `core.openwop.http.fetch` + `core.openwop.mcp.invoke-tool` | Workflows that touch an external system bind a connection pack via the MCP/HTTP consumer nodes. Missing connectors degrade to `mock-ai` in demo mode (see "Connector readiness"). |
| Composition / fan-out / HITL | `core.subWorkflow`, parallel edges + edge `condition`, `core.approvalGate` | Multi-phase workflows compose sub-workflows; fan-outs use parallel edges; every external send waits on an approval gate. |
| LLM reasoning | the BYOK-backed LLM/prompt node (`mock-ai` deterministic fallback in demo) | Summarize / classify / draft steps use the real LLM node when a provider is configured; `mock-ai` when not — same dual-mode the templates already rely on. |

**Net new (bounded):** a pinned `feature.workflows-library.*` pack of **20
`WorkflowDefinition`s** (+ the `ScheduledJob`/trigger registrations for the ambient
ones) + the connector-gap connection packs we choose to author (Google Ads / Meta Ads
are the only genuinely-absent providers). **No new run model, no new authoring surface,
no new queue, no new dashboard, no new wire field.** They surface through the
**existing** run/chat/notification surfaces (ADR 0058 chat-drivability, ADR 0133 task
deck, ADR 0010 notifications) and the existing builder/run UI.

---

## Decision

> **Superseded by §Correction (2026-06-27).** The original decision below — "pin
> in-tree as a `feature.workflows-library` pack" — was the deviation. The decision now
> is: ship these 20 as a **workflow(-chain) pack (RFC 0013)** loaded by a new host
> **workflow-pack loader** (next ADR), NOT a pinned in-tree module. The product
> definition of the 20 workflows (below) stands unchanged; only the delivery vehicle
> moved from "another pinned catalog" to "the protocol's workflow-pack mechanism."

Author a **Real-Work Workflow Library** — 20 substantive, multi-step
`WorkflowDefinition`s that compose existing trigger + feature + integration + flow
nodes — ~~pinned in-tree as a `feature.workflows-library` pack~~ **shipped as an RFC 0013
workflow pack** (same restart-safe, replay-deterministic discipline as a node/connection
pack). Each workflow has:

1. a **real trigger** (cron, webhook, form, or mailhook — not "click run"),
2. **multi-source reads/writes** through shipped feature node packs and/or connection
   packs (real data, not `mock-ai`, wherever a connector exists),
3. **human-on-the-loop** gating — the agent runs within guardrails and a
   `core.approvalGate` fronts every external send / money / HR / prod-changing action,
4. a **deliverable** a person uses (a brief, a draft, a routed ticket, a posted change).

In `OPENWOP_DEMO_MODE`, workflows whose connectors are unconfigured fall back to
`mock-ai` + seeded data so the demo runs end-to-end without secrets — the badged,
illustrative behavior `workflowAuthorSeed.ts` already establishes.

### The 20 workflows

Legend — **Connector readiness:**
✅ buildable today (only core triggers + shipped feature packs + integration nodes) ·
🔌 needs an RFC 0095 connection pack (named) · 🧪 demo-mockable (degrades to `mock-ai`/seed when the connector is absent).

#### A. Executive / Chief of Staff

| # | Workflow | Trigger | Step graph (→ = edge, ∥ = parallel) | HITL gate | Deliverable | Readiness |
|---|---|---|---|---|---|---|
| 1 | **Daily Executive Briefing** | `core.trigger.schedule` (06:30 tz) | (∥ read: `feature.crm` pipeline + `feature.analytics.query` + Slack/M365 mail + Jira issues) → LLM rank/summarize → draft talking points for today's meetings → `integration.notification-push` / `slack-message` | none (read-only digest) | One briefing: priorities, risks, revenue deltas, blockers, next actions | 🔌 M365 (mail/cal), Slack, Jira · 🧪 |
| 2 | **Meeting Prep & Attendee Dossier** | `core.trigger.schedule` (N h before event) | M365 calendar read → ∥ (`feature.crm.get-company` + recent-thread fetch) → LLM dossier+agenda → `notification-push` to organizer | none | Attendee dossier + agenda + suggested objectives | 🔌 M365 calendar · 🧪 |
| 3 | **Post-Meeting Follow-up** | `core.trigger.event` (transcript ready) | LLM extract decisions+actions+owners → draft follow-up email + `feature.crm` task drafts → `core.approvalGate` → `integration.email-send` + create tasks | approve before send | Sent follow-up + created tasks | ✅ (CRM tasks) · 🔌 transcript source · 🧪 |
| 4 | **Board / Investor Update Pack** | `core.trigger.schedule` (monthly) | ∥ pull (`feature.analytics` KPIs + `feature.crm` pipeline + finance figures) → LLM draft narrative+variance → `core.approvalGate` (exec) → assemble memo/deck | exec review | Board memo / update pack | ✅ analytics/CRM · 🔌 finance source · 🧪 |

#### B. Marketing & Advertising

| # | Workflow | Trigger | Step graph | HITL gate | Deliverable | Readiness |
|---|---|---|---|---|---|---|
| 5 | **Full Campaign Launch** (MyndHyve flagship) | `core.trigger.manual`/`form` (brief) | brief → persona/`feature.crm` audience select → `core.subWorkflow` ∥ {landing-page (`feature.cms`) · ad copy · creative variants · tracking setup} → consolidated review → `core.approvalGate` → launch + monitor | approve before launch | Live campaign: page + ads + tracking | ✅ CMS/CRM core · 🔌 ad platforms (#6) · 🧪 |
| 6 | **Ad Performance Optimization Loop** | `core.trigger.cron-advanced` (hourly) | fetch ad metrics (Google/Meta) → LLM detect anomaly vs thresholds → diagnose → recommend bid/budget shift → edge `condition`: within-guardrail → auto-apply · else → `core.approvalGate` → log learnings | only beyond guardrail | Applied/queued budget changes + learnings log | 🔌 **Google Ads / Meta Ads (new packs)** · 🧪 |
| 7 | **Content Brief Generator** | `core.trigger.form` (topic/keyword) | competitor scan (`http.fetch`/MCP) ∥ trend research ∥ `feature.kb.rag` source gather → LLM structured SEO brief → deliver | none | SEO content brief | ✅ KB · 🔌 web-research connector · 🧪 |
| 8 | **Content Repurposing** (MyndHyve) | `core.trigger.event` (doc published) | extract → LLM outline → ∥ generate {LinkedIn carousel · X thread · newsletter · short-video script} → `core.approvalGate` → schedule via `feature.email`/`integration` | approve before publish | Channel-ready content set | ✅ KB/email · 🔌 social schedulers · 🧪 |
| 9 | **Competitive / Market-Intel Digest** | `core.trigger.schedule` (weekly) | discover sources (`http.fetch`/MCP) → ∥ extract → VoC + ad-angle mining → opportunity scoring → LLM synthesize → `notification-push` | none | Weekly intel digest + recommended actions | ✅ core · 🔌 web-research/social listening · 🧪 |
| 10 | **Inbound Lead Triage & Routing** | `core.trigger.form`/`webhook` | `feature.crm.triage-enriched` (enrich+score) → edge `condition` route to owner → LLM draft first-touch → `core.approvalGate` (high-value only) → `integration.email-send` + CRM log | high-value sends | Routed lead + first-touch draft + CRM entry | ✅ CRM (live today) · 🧪 |

#### C. People / HR

| # | Workflow | Trigger | Step graph | HITL gate | Deliverable | Readiness |
|---|---|---|---|---|---|---|
| 11 | **Employee Onboarding Orchestrator** | `core.trigger.event` (offer accepted) | `core.subWorkflow` ∥ multi-dept w/ SLAs {IT provision (Jira/M365) · payroll (Workday) · role-based training assign · manager day-one checklist · pre-boarding tasks} → completion tracker | exceptions only | Provisioned new hire across depts | 🔌 Workday + M365 + Jira · 🧪 |
| 12 | **Offboarding & Access Revocation** | `core.trigger.event` (termination) | ∥ {deprovision M365/Jira accounts · revoke SaaS access · asset-retrieval task · final-pay checklist (Workday) · knowledge-handoff capture (`feature.kb`)} → compliance attestation `core.approvalGate` | attestation | Revoked access + attested offboarding | 🔌 Workday + M365 + Jira · 🧪 |
| 13 | **Leave / PTO Request Routing** | `core.trigger.form` | policy check → coverage analysis (M365 calendar) → route to manager `core.approvalGate` → update HRIS (Workday) + calendar + `slack-message` team | manager approve | Approved PTO + updated HRIS/calendar | 🔌 Workday + M365 · 🧪 |

#### D. Finance

| # | Workflow | Trigger | Step graph | HITL gate | Deliverable | Readiness |
|---|---|---|---|---|---|---|
| 14 | **Invoice → AP Processing** | `core.trigger.mailhook`/`event` (invoice PDF) | extract line items (LLM/vision) → validate vs PO/db (`http.fetch` ERP) → threshold-based approval chain (`core.approvalGate`) → post to ERP + payment notification | threshold approvers | Posted invoice + payment notice | 🔌 ERP connection pack · 🧪 |
| 15 | **Month-End Close Checklist** | `core.trigger.schedule` (period-end) | `core.subWorkflow` orchestrate close tasks across teams → collect supporting docs (`feature.kb`) → LLM draft variance notes → chase missing approvals (`core.approvalGate` + nudge) → readiness report | task approvals | Close-readiness report | ✅ core/KB · 🔌 ERP figures · 🧪 |
| 16 | **Expense / Budget Approval + Anomaly Detection** | `core.trigger.form` | policy + duplicate/anomaly check (LLM) → threshold approval chain → `core.approvalGate` → reimburse + flag outliers | threshold approvers | Approved/flagged expense | ✅ core · 🔌 ERP/payments · 🧪 |

#### E. Sales / Customer

| # | Workflow | Trigger | Step graph | HITL gate | Deliverable | Readiness |
|---|---|---|---|---|---|---|
| 17 | **Account Brief & Next-Step Draft** | `core.trigger.schedule` (pre-meeting) | `feature.crm.get-company`+`get-deal`+activity ∥ news fetch (`http.fetch`) → LLM brief + recommended next steps + draft outreach → `core.approvalGate` → CRM log | approve outreach | Account brief + next-step draft | ✅ CRM (live today) · 🔌 news connector · 🧪 |
| 18 | **Renewal & Churn-Risk Digest** | `core.trigger.schedule` (weekly) | `feature.crm.list-deals` + `feature.analytics` usage + support sentiment → LLM score risk → flag at-risk → assemble renewal pack + save-play recs → `notification-push` CSM | none (advisory) | At-risk list + renewal packs + save plays | ✅ CRM/analytics (live today) · 🧪 |
| 19 | **RFP / Proposal Response Assembly** | `core.trigger.mailhook`/`form` (RFP) | parse requirements (LLM) → `feature.kb.rag` retrieve answers + past proposals → LLM draft response → `core.approvalGate` (SME) → compile | SME review | Drafted RFP response | ✅ KB (live today) · 🧪 |

#### F. IT / Support

| # | Workflow | Trigger | Step graph | HITL gate | Deliverable | Readiness |
|---|---|---|---|---|---|---|
| 20 | **Incident Triage & Major-Incident Comms** | `core.trigger.webhook`/`event` (alert/ticket) | classify + severity (LLM) → edge `condition`: routine → recommend `feature.kb` article + route on-call (Jira) · major → draft + cadence-push stakeholder updates (`slack-message`/`integration`) → post-incident summary | major-incident sends | Routed incident + status updates + post-mortem | ✅ KB · 🔌 Jira/PagerDuty · 🧪 |

### Connector readiness summary

- **Buildable today, real data, zero new connectors (5):** #10 Lead Triage, #17 Account Brief, #18 Renewal Digest, #19 RFP Assembly, and #3 Post-Meeting tasks — they ride `feature.crm`/`feature.kb`/`feature.analytics` + `core.openwop.integration.*` that are already shipped. **These are the Phase-1 lighthouse set.**
- **Need an *existing example* connection pack wired (most):** M365 (calendar/mail), Slack, Jira, Salesforce, Workday already ship as `examples/connection-packs/*` — the work is configuration + binding the MCP/HTTP consumer node, not authoring a provider.
- **Genuinely-absent providers (2):** **Google Ads** and **Meta Ads** (#6) have no example connection pack — these are the only net-new RFC 0095 packs this library requires.
- **Demo mode:** every workflow degrades to `mock-ai` + seeded data when its connector is unconfigured, so `app.openwop.dev` runs all 20 end-to-end without secrets (badged illustrative, per `workflowAuthorSeed.ts`).

---

## Alternatives considered

1. **A new "Workflows" product surface** (curated gallery + canned runs + its own read
   model). **Rejected** — the [[build-on-orchestration-not-parallel-surfaces]] failure
   mode; fragments capability and drifts from the run/chat surfaces.
2. **Extend the ADR 0032 template library in place** (add 20 rows to
   `workflowTemplates.ts`). **Partially adopted** — but those templates are
   deliberately `mock-ai`-only deterministic stubs the *twins* compose; mixing
   real-connector workflows into that pinned catalog blurs its contract. Instead ship a
   **sibling** `feature.workflows-library` pack that *may* compose ADR 0032 templates
   via `core.subWorkflow`, keeping the deterministic-stub catalog and the real-work
   catalog separate but composable.
3. **Make them chat-only agent packs** (drive each through the chat per ADR 0058).
   **Complementary, not either/or** — each workflow is *also* chat-drivable by scoping
   an agent to it, but the durable artifact is the `WorkflowDefinition` so it can be
   scheduled, replayed, and forked.

---

## RFC gate verdict

**Host-extension — NO new wire RFC for the library itself.** Authoring
`WorkflowDefinition`s that compose already-registered nodes, registering `ScheduledJob`s,
and shipping a pinned pack touch no run-event field, capability flag, event type,
endpoint contract, or normative MUST. They ride **already-Accepted** RFCs:
**RFC 0052** (triggers + scheduler), **RFC 0095** (connection packs), and the
feature-pack RFCs behind ADR 0008/0009/0011/0014/0018.

**Connection packs (landed):** the three new packs fit the existing RFC 0095 manifest
(`marketing`/`finance` category + `oauth2` + `reach.openapi` + `instanceUrlTemplate` are
all already in `connection-pack-manifest.schema.json`) — **no amendment**, pure host packs.

**Workflow packs (the deferred home — §Correction):** the workflow *definitions* belong in a
**workflow(-chain) pack**. The protocol artifact already exists
(`schemas/workflow-chain-pack-manifest.schema.json`, RFC 0013); what's missing is a **host
loader** (peer to `connectionPackLoader`/`promptPackLoader`/`artifactTypePackLoader`).
Implementing that loader is **host work riding the already-defined RFC 0013** — confirm RFC
0013's status in `../openwop/RFCS/` is at least `Accepted` before/with the loader ADR; if the
manifest needs a field these workflows require (e.g. `requires`/`ambient`-style metadata), that
delta is an RFC 0013 amendment authored there, not invented in the host.

---

## Phased implementation plan (corrected — gated on the loader)

| Phase | Scope | Gate |
|---|---|---|
| **0 — Connection packs** | Google Ads / Meta Ads / NetSuite RFC 0095 packs. | ✅ **landed** — packs load + resolve as providers (no RFC amendment). |
| **1 — Workflow-pack loader (next ADR)** | A host loader for `workflow-chain-pack-manifest.schema.json` (RFC 0013), registered as a workflow-catalog source like `connectionPackLoader`/`promptPackLoader`; confirm RFC 0013 status in `../openwop` first. | A workflow pack on disk loads → its ids resolve via `workflowCatalog.getWorkflow` + `:fork` replays; loader-validation + a route/catalog test. |
| **2 — Author the 20 as a workflow pack** | The §"The 20 workflows" catalog authored as RFC 0013 pack entries; deterministic reasoning + run-variable tenant params + approval-gated side-effects (the rules validated in this ADR); connector entries bind the Phase-0 packs. | Lighthouse entries (RFP/KB) run zero-config; connector entries run against a configured connection. |
| **3 — Surface + seed** | Discover via the established workflow-listing surface; seed into demo tenants through the established seeder/registry path (NOT a bespoke route/module). | `npm run ci` green; a provisioned demo tenant lists the workflows. |
| **4 — Chat-drivability (optional)** | Scoped agent persona per workflow (ADR 0058). | — |

---

## Open questions / decisions checklist

- [ ] **Pack home:** sibling `feature.workflows-library` pack vs. a new
  `feature.<vertical>.workflows` pack per department? (Leaning: one library pack,
  category-tagged like the ADR 0032 catalog.)
- [ ] **Demo-fallback policy:** per-node `mock-ai` substitution vs. a workflow-level
  "demo variant" definition. Must stay replay-deterministic (RFC 0056 variant stamp in
  `run.metadata`, per ADR 0001 correction).
- [ ] **Guardrail expression for #6:** edge `condition` thresholds vs. a dedicated
  policy node — does auto-apply-within-guardrail need a new flow primitive?
- [ ] **Google/Meta Ads RFC 0095 fit:** confirm OAuth2 + REST `reach` covers them, or
  scope the amendment.
- [ ] **Trigger ownership:** which workflows ship a default `ScheduledJob` at seed vs.
  require the operator to register one (avoid surprise autonomous spend).
- [ ] **RBAC:** which roles may register/trigger each workflow (RFC 0049 protocol-scope).

---

## What landed now, and what the next ADR must build

**Landed:** the three RFC 0095 **connection packs** (`google-ads`, `meta-ads`, `netsuite`).
Operators connect them under *Access & data → Connections* (the pack supplies the
OAuth/endpoint definition; the operator supplies the client credential host-side). They are
resolvable providers immediately, like the shipped `workday`/`salesforce` example packs —
independent of the workflows that will eventually bind them.

**Next ADR — the workflow-pack loader (RFC 0013).** The 20 workflows ship once that exists.
The loader work must carry forward, from this ADR's analysis:
- the **catalog of 20** (§"The 20 workflows") as the pack contents;
- the **connector-readiness** mapping (which entries need `crm`/`analytics` toggles, which
  bind `workday`/`microsoft365`/`jira`/`google-ads`/`netsuite`/`bigquery`, which need
  `core.openwop.mcp`/`core.openwop.http` packs loaded);
- the **replay-safe authoring rules** validated here (reasoning = deterministic node so a
  no-BYOK/no-connector demo still runs + replays; tenant params like Workday `baseUrl` and
  BigQuery `projectId`/`sql` supplied as run variables, never hardcoded; side-effects behind
  `core.approvalGate`);
- the **ambient cadence** model (a workflow-pack entry may *suggest* a cron; an operator
  registers the `ScheduledJob` — never auto-registered; the daemon's
  `checkAutonomousRunBudget` is the backstop).
Whether `requires`/`ambient` belong in the RFC 0013 manifest (vs. host-side metadata) is a
question for that ADR — decided in `../openwop`, not invented in the host.

**Chat-drivability.** A workflow shipped via the loader is runnable through the existing
surfaces (`POST /v1/runs`, the chat `workflow_run` bubble, ADR 0089); a scoped agent persona
per workflow (ADR 0058 "agent + nodes") remains a separate, later enhancement.
