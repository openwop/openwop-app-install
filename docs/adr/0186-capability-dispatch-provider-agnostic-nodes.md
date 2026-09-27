# 0186 — Capability-dispatch: provider-agnostic connector nodes (Phase 2b)

Status: accepted (Phase 2b — slices 1 Calendar, 2 Ticketing, 3 HRIS, 4a/4b Ads, 5 ERP, 5b writes, **B ERP SuiteQL reads** — implemented; **Workday Staffing SOAP hire/terminate — design recorded, live arm deferred**)

## Context

ADR 0184 concluded that the vendored workflow-chain packs still name a vendor
(`microsoft365`/`workday`/`netsuite`/`jira`/`google-ads`) because their external steps
are `core.openwop.http.openapi-call` nodes, whose `{connectionRef, operationId}` are
inherently provider-specific — `connectionRef` is inert, and `operationId` + the OpenAPI
spec *are* one vendor's API. It named the fix "Phase 2b": provider-agnostic **capability
nodes** that accept a neutral shape and dispatch to whichever provider the tenant
connected. This ADR designs that program and lands its first slice.

## The RFC gate — resolved: no new RFC

Phase 2b adds no wire surface. `NodeContext` (`executor/types.ts`) is the **host-internal
node ABI**, not the normative OpenWOP wire. The precedents are direct:

- **`ctx.ads`** (ADR 0167) and **`ctx.email`** (ADR 0024 §4) — capability-dispatch
  adapters that resolve the acting human's Connection for a category and call the
  vendor API, added host-only, riding **already-accepted** RFCs (0079 provenance,
  0045/0047/0095 connector auth).
- **`ctx.connectors.invoke`** (ADR 0076) — a generic brokered egress already exposed to
  nodes (SSRF guard + provider `apiHosts` pin + `connections:use` gate + RFC 0079
  provenance). First consumers: `core.bigquery.query`, `core.workday.query`.

Capability nodes also **degrade gracefully** when the host doesn't provide the surface
(publish-ad-variants → document handoff), so a pack that uses one is honest on any host.
Hence Phase 2b is **host work under this ADR** — no new RFC in `openwop`.

## Decision

The dispatch **spine already exists**; Phase 2b needs one small primitive plus nodes:

1. **`ctx.connectors.resolveForCapability(category)`** — the one new host primitive. Wraps
   Phase 2's `resolveProviderForCapability` (`connectionsService`), returning the acting
   human's authorized provider id for a category (`email-calendar` / `hr` / `ticketing` /
   `finance` / …), or `null`. It runs through the same authorization choke point as every
   connection (`selectAuthorizedConnection`). This is the whole of the new host surface.

2. **Provider-agnostic capability nodes**, registered as **host bootstrap nodes**
   (`bootstrap/nodes.ts`, always available like `core.bigquery.query`) so a preloaded
   zero-config template can use one without installing a feature pack (the ADR 0184
   dependency trap). Each node:
   - `resolveForCapability(category)` → provider id;
   - a small **per-provider endpoint map** (URL + response normalizer) — the only
     vendor-specific knowledge, and it lives in the node, not a new host adapter;
   - `ctx.connectors.invoke(provider, { url, method, authScheme })` for the brokered,
     credentialed, provenance-stamped call;
   - **fail-safe, never throw**: no connection → `{ connected:false, … }`; a connected
     provider outside the node's endpoint map → `{ connected:false, reason:… }`.

3. **Category granularity is coarser than sub-capability.** `email-calendar` covers both
   email-only providers (gmail/sendgrid) and calendar providers (google/microsoft-graph).
   The node handles this by mapping only providers it supports and degrading otherwise —
   honest today. A finer taxonomy (a `calendar` sub-category on provider metadata) is a
   possible follow-on but is host-only provider metadata, not a wire change.

### Spend-safety rule for mutating categories

Read capabilities (calendar list, metrics) dispatch directly. **Mutating** capabilities
(budget update, HRIS write, ticket create, ERP post) MUST stay behind the existing gates
the packs already use — a `core.chat.approvalGate` upstream and/or the `ctx.ads`
PAUSED/`dryRun` preview pattern — never an auto-applied money/state mutation from a
resolved provider. The capability node makes the *provider* agnostic, not the *approval*
optional.

## Build order (per category, each a slice)

| Slice | Category | Nodes | Providers | Risk |
|---|---|---|---|---|
| **1 (this ADR)** | `email-calendar` (read) | `calendar-list-events` | google, microsoft-graph | read-only |
| **2 (implemented)** | `ticketing` | `ticket-create`, `ticket-transition` | jira, servicenow | write, degrades safe |
| **3 (implemented)** | `hr` actions | `hris-action` (recommend) | workday | high-stakes writes → recommend-only |
| **4a (implemented)** | ads metrics (read) + budget recommendation | `ad-metrics`, `ad-budget-update` (preview) | extend `ctx.ads` meta/google | read-only + zero-mutation |
| **4b (implemented)** | ads budget EXECUTION | `ad-budget-update` real path | dry-run-default mutation on `ctx.ads` | budget = live spend → dry-run default + gates |
| **5 (implemented)** | `finance`/ERP | `erp-action` (recommend) | netsuite | money-posting writes → recommend-only |

Each slice: new endpoint map(s) + node(s) + rewire the naming chains + tests. The marketing
`ad-optimization` loop (the original complaint) is slice 4 — it needs the `ctx.ads`
metrics/budget extension, kept behind its existing guardrail/approval `core.flow.if`.

## Slice 1 — Calendar (implemented here)

- `ctx.connectors.resolveForCapability` added (`connectorsAdapter.ts` + `NodeContext`).
- `core.openwop.connectors.calendar-list-events` bootstrap node — Google Calendar + MS
  Graph endpoint maps, normalized `{ title, start, end, location, attendees }`, fail-safe.
- `exec-ops.meeting-prep` calendar step rewired off `openapi-call`/`microsoft365` to the
  new node — the first pack chain that reads a calendar without naming a vendor.

**Correction (code-review follow-up):** two defects were fixed after the initial slice-1
landing (same PR line, no wire change):
- *Upcoming vs oldest.* Neither vendor endpoint set a time floor, so the read returned the
  *earliest* calendar events, not upcoming ones. Fixed by an OPTIONAL `timeMin`/`timeMax`
  window sourced from `config`/`inputs` (Google `timeMin=`, Graph `$filter=start/dateTime ge`)
  — **never a wall clock** (that would break replay/fork determinism). `meeting-prep` now
  wires `{{params.timeMin}}` so a scheduled trigger supplies its fire time; absent ⇒ the
  node honestly lists by start order rather than claiming "upcoming".
- *Coarse-category shadowing.* `email-calendar` covers email-only providers too, so the
  single most-specific match (e.g. `gmail`) could shadow a calendar-capable one (`google`).
  Added `ctx.connectors.resolveAllForCapability` (a plural resolver through the same authz
  choke point); the node picks the first candidate whose id is in its endpoint map. This
  supersedes the "Category granularity" limitation noted above for this node.

## Slice 4a — Ads metrics + budget recommendation (implemented here)

Closes the original complaint about the *"Ad Performance Optimization Loop"* being
hard-coded to Google Ads, **without shipping any live-spend mutation** (that is the
spend-safety line — deferred to 4b).

- **`ctx.ads.getMetrics`** — a READ-ONLY, provider-agnostic campaign-metrics read on the
  existing ads adapter (Meta `/insights`, Google Ads `googleAds:search`; spend normalized
  to major currency units; tiktok ⇒ `unsupported`). Reuses the same broker + RFC 0079
  provenance as `publishAd`; graceful `no_connection`, never throws.
- **`core.openwop.connectors.ad-metrics`** (bootstrap node) — reads `platform`/
  `adAccountId`/`campaignId` from config/inputs → `ctx.ads.getMetrics` → normalized
  metrics; degrades to `{connected:false, metrics:null}` (no surface / not configured /
  no connection) so the diagnose step tolerates "no data".
- **`core.openwop.connectors.ad-budget-update`** (bootstrap node) — RECOMMENDS a change:
  emits `{applied:false, planned:{platform,campaignId,dailyBudgetMinor}}` for the approval
  card / learnings log and calls **no** platform API. `applied:false` makes the
  not-yet-executing contract explicit.
- **`marketing.ad-optimization` fully rewired** off the three raw `google-ads`
  `openapi-call` nodes to the two capability nodes; gains `platform`/`adAccountId`/
  `campaignId` params. The `core.flow.if` guardrail + `approvalGate` structure is
  unchanged. The chain no longer names a vendor.

**Why budget execution is 4b, not here (spend-safety gate).** Unlike `publishAd` (which
creates a PAUSED campaign — zero spend), a budget update changes *live* spend the moment
it lands, and its platform-specific target semantics (Meta campaign-vs-adset budget) can't
be validated without a live account. Shipping that untested in the same pass would violate
the ADR's own spend-safety rule. 4b adds the real execution path behind a dry-run default +
isolated review.

## Slice 4b — Ads budget EXECUTION (implemented here)

Adds the real budget mutation the loop's `ad-budget-update` node now backs — the one
live-spend surface — designed so it cannot spend by accident:

- **`ctx.ads.updateBudget`** — Meta (`POST /{campaignId}` `daily_budget`) and Google
  (two-step: resolve `campaign.campaign_budget` → `campaignBudgets:mutate` update with an
  `amount_micros` updateMask; minor→micros ×10⁴); tiktok ⇒ `unsupported`. `dryRun`
  returns a preview with **zero** platform calls. Same broker + RFC 0079 provenance;
  graceful `no_connection`; never throws.
- **`ad-budget-update` upgraded** — `dryRun` DEFAULTS on (only the literal `dryRun:false`
  opts in). Default / no account / no budget / no surface ⇒ `{applied:false, planned}`
  (the 4a recommendation contract, unchanged). An explicit `dryRun:false` **plus** a real
  `adAccountId` applies via `ctx.ads.updateBudget` → `{applied:true, target}`; a failure
  surfaces, `no_connection`/`unsupported` degrade to `{applied:false}`.
- **No new dispatch record.** A budget-set is PUT-like (idempotent): re-applying the same
  value on retry/`:fork` is a harmless no-op, and the update never unpauses the campaign —
  so unlike `publishAd`'s create there is nothing to dedupe. Wrong-value risk stays bounded
  by the chain's `core.flow.if` guardrail + `approvalGate` (both unchanged).
- **The vendored `marketing.ad-optimization` template ships dry-run-safe** — its
  `ad-budget-update` nodes carry no `dryRun:false`, so a preloaded run recommends and never
  spends; an operator opts into live execution deliberately in the builder. The nodes gain
  `adAccountId` so that opt-in has an account.

## Slice 2 — Ticketing (implemented here)

- **`core.openwop.connectors.ticket-create` + `ticket-transition`** (bootstrap nodes) —
  `resolveForCapability('ticketing')` picks the connected provider (ServiceNow built-in;
  Jira when its pack is installed), a per-provider request builder shapes the REST call
  (Jira API v3 `/rest/api/3/issue[/{key}/transitions]`; ServiceNow `/api/now/table/{t}`),
  and `ctx.connectors.invoke` performs the brokered, `apiHosts`-pinned, provenance-stamped
  write. `service-now.com` / `atlassian.net` apiHosts cover the per-tenant instance hosts.
- **Per-tenant instance base.** Unlike calendar/ads (fixed vendor hosts), a ticketing
  instance is tenant-specific, so the node takes a **`baseUrl`** config (the pattern
  `core.workday.query` already uses) rather than a hard-coded host.
- **Real writes, but fail-safe.** Ticket create/transition are the chain's purpose (not
  money, reversible), so they execute for real when connected+configured — no dry-run
  gate. Safety is the graceful no-op: no ticketing connection / no `baseUrl` / no required
  field ⇒ `{connected:false}` (no side effect, never a throw), so a preloaded chain that
  hasn't wired ticketing simply skips it.
- **Rewired chains:** `it-support.incident-triage` (create), `people-hr.onboarding`
  (create), `people-hr.offboarding` (transition) — off the hard-coded `jira` openapi-call
  nodes; each gains a `ticketingBaseUrl` (+ project / key / transition) param. The chains'
  existing gates are unchanged.

## Slice 3 — HRIS actions (implemented here)

- **`core.openwop.connectors.hris-action`** (bootstrap node) — `resolveForCapability('hr')`
  reports the connected HRIS (Workday today) and the node RECOMMENDS a worker action
  (`create-worker` / `terminate-worker` / `submit-time-off`): `{applied:false, connected,
  provider, planned:{action, fields}}`. It applies NOTHING and never calls the connector.
- **Why recommend-only.** HRIS writes are the highest-stakes mutations in the catalog —
  hiring, firing, payroll — so, like `ad-budget-update`'s default, a preloaded chain must
  never auto-mutate the HRIS. Real execution is a future state-gated slice; `applied:false`
  is the explicit contract. (The single `hr` provider today, Workday, also makes the
  provider-agnostic resolution mostly future-proofing.)
- **Rewired** `people-hr.onboarding` (create-worker), `people-hr.offboarding`
  (terminate-worker), `people-hr.pto-routing` (submit-time-off) off the hard-coded
  `workday` openapi-call nodes — the People/HR pack now names no HRIS vendor. Generalizing
  the read side (`core.workday.query`) has no vendored-chain consumer and is deferred.

**Slice 3b (implemented) — real submit-time-off execution.** `hris-action` gains a
`dryRun`-default real path (like ad-budget-4b) for the ONE REST-implementable, reversible,
lowest-stakes HRIS write: `submit-time-off` on Workday (Absence Management v1 — `POST
/workers/{id}/requestTimeOff`, a `days[]` body), idempotent via a `DurableCollection`
record (a time-off request is not idempotent). `create-worker` / `terminate-worker` stay
recommend-only even with `dryRun:false` — Workday hire/terminate are Staffing SOAP
business processes (`Human_Resources` WWS), not a REST `brokeredPost`, so they are reported
`{applied:false, reason:'staffing_soap_only'}` rather than dishonestly claimed. The
`people-hr.pto-routing` template stays dry-run-safe (no `dryRun:false`); an operator opts
into a live submit by setting it plus `hrisBaseUrl`/`workerId`/`timeOffType`.

## Slice 5 — ERP actions (implemented here)

- **`core.openwop.connectors.erp-action`** (bootstrap node) — `resolveForCapability('finance')`
  reports the connected ERP and RECOMMENDS a finance action (`get-financial-summary` /
  `match-po` / `post-bill` / `create-expense-report`): `{applied:false, connected, provider,
  planned:{action, fields}}`. Applies nothing; the chains' threshold approval gates are
  unchanged.
- **Recommend-only**, for the same reason as `hris-action`: ERP postings move money
  (vendor bills, reimbursements), so a preloaded chain must never auto-post to the ledger.
  Real execution (reads + writes) is a future money/state-gated slice. NetSuite is not a
  built-in provider, so `resolveForCapability` yields `null` (⇒ `connected:false`) until a
  NetSuite pack is installed — honest degradation.
- **Rewired** `finance.ap-processing` (match-po + post-bill), `finance.expense-approval`
  (create-expense-report), and `exec-ops.board-update` (get-financial-summary) off the
  hard-coded `netsuite` openapi-call nodes — **no vendored chain now names a connector
  vendor for a category with a capability node.**

**Slice 5b (implemented) — real ERP posting.** `erp-action` gains a `dryRun`-default real
path for the money-posting WRITES: `post-bill` and `create-expense-report` on NetSuite
(SuiteTalk REST — `POST /services/rest/record/v1/{vendorBill|expensereport}`), idempotent
via a `DurableCollection` record (a bill/expense post is not idempotent). The path dispatches
ONLY when a `finance` provider actually resolves (NetSuite is not a built-in, so this stays
recommend until a NetSuite connection pack is installed — graceful, honest degradation); the
`finance.invoice-ap` / `finance.expense-approval` templates stay dry-run-safe, gaining
`erpBaseUrl` + vendor/employee/amount opt-in params.

**Slice B (implemented) — real ERP READS via SuiteQL.** Supersedes the deferral above:
`get-financial-summary` and `match-po` now dispatch a NetSuite **SuiteQL** query (`POST
{baseUrl}/services/rest/query/v1/suiteql`, body `{q}`) instead of returning
`{applied:false, reason:'read_not_dispatched'}`. Reads are side-effect-free, so — unlike the
writes — there is no idempotency record and `applied` stays `false`, with `dispatched:true` +
the `result[]` rows. Two host mechanics made this honest without a wire change:
- **A bounded static-header primitive on `brokeredFetch`** (`extraHeaders`, mirroring the
  existing `brokeredPost.extraHeaders`) so the SuiteQL-required `Prefer: transient` header can
  be sent. The broker still owns `authorization` + `content-type`: any case-variant of those
  in `extraHeaders` is **stripped before merge**, so a node can never override the credential
  or smuggle a second auth header. Plumbed through `ctx.connectors.invoke`.
- **Injection-safe query construction.** SuiteQL `q` is a raw SQL string (no bind params over
  the REST body) and the filter values come from config/inputs, so every interpolated value is
  validated/escaped: numeric ids to `^\d+$` (dropped otherwise), string literals
  single-quote-escaped + length-capped. SuiteQL is SELECT-only, so the escaping closes even a
  read-widening injection. `match-po` with no identifier ⇒ `{reason:'read_missing_filter'}`.
The query SHAPES are a documented best-effort — reads carry no live-NetSuite validation, but a
wrong query returns wrong/empty data and mutates nothing, so shipping them resolve-gated is
honest (same tier as the 5b writes: dark until a NetSuite pack is installed).

**Slice A (design recorded; live arm deferred) — Workday Staffing SOAP hire/terminate.**
`create-worker` / `terminate-worker` remain the honest `{applied:false, reason:'staffing_soap_only'}`
gate. The `brokeredFetch` string body + `contentType` + the new `extraHeaders` now make the
transport *expressible* — a `Human_Resources` WWS SOAP call would be
`invoke('workday', { url:<staffing endpoint>, method:'POST', contentType:'application/soap+xml',
body:<Terminate_Employee_Request envelope>, extraHeaders:{ SOAPAction:'…' } })`, with the
OAuth2 bearer the broker already injects (or WS-Security carried inside the envelope). It is
**deliberately not wired to a live apply**: hire/terminate is the highest-blast-radius,
least-reversible mutation in the catalog, and — like NetSuite — Workday is not a resolvable
provider here, so the envelope could never be validated against a live tenant. Shipping an
unvalidated employee-termination path (even dry-run-gated) would be exactly the "advertise
only what's honored" violation this ADR's spend-safety rule forbids. The **live arm is
gated on a Workday sandbox tenant + WWS credentials to validate the envelope end-to-end**;
until then the honest gate stands and this section is the recorded design.

## Consequences

- A Google-Workspace tenant and a Microsoft-365 tenant run the SAME meeting-prep template;
  the calendar step binds whichever they connected. The ADR 0184 "hard-coded vendor"
  problem is now genuinely fixed for calendar, with a repeatable pattern for the rest.
- Additive + reversible; no wire change, no migration. Slices 2–5 replicate the pattern.

## Implementation

| Piece | File |
|---|---|
| `resolveForCapability` primitive | `backend/typescript/src/host/connectorsAdapter.ts` + `executor/types.ts` |
| `calendar-list-events` node | `backend/typescript/src/bootstrap/nodes.ts` |
| Chain rewire | `examples/workflow-chain-packs/exec-ops/pack.json` |
| Tests | `backend/typescript/test/capability-dispatch-calendar.test.ts` |
