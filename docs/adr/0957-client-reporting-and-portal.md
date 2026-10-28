# ADR 0957 — Client reporting and the client portal

Status: Accepted (P0 implemented 2026-10-20; P1 in progress: steps and scheduling built, the chain and its gate step wait on ADR 0942's org-scoped freeze; P2–P5 open)

Date: 2026-10-19. Program: Campaign Studio (ADRs 0941–0962), Tier 4 — agency scale.
Net-new feature planned with `/feature-refinement`; not a MyndHyve port.
Depends on: 0921 (agency = workspace, client = org), 0924 (version-bound
approval and client portal, **extended, not forked**), 0958 (collaborator
identity and grants), 0934 (shared rate limits), 0942 (the one gate), 0943
(Reporting Analyst agent). Reads from: 0952 (spend versus cap), 0949/0950
(experiments and promotions), 0954 (lead funnel, speed to lead), 0955 (journey
and deliverability), 0956 (attribution). Composes: 0013, 0448 and 0887
(sharing), 0417 (BI metric catalog), 0375/0377 (dashboards).

## Context

Agencies keep clients by showing results. Today that means a monthly deck built
by hand from platform screenshots, or a live Looker Studio link whose numbers
change after the account manager has written the commentary. Clients also need
one place to approve work, read reports and send assets. Without it, approvals
arrive by email, reports by PDF and assets by Drive link.

GoHighLevel and AgencyAnalytics sell white-label dashboards. AI "report
summaries" (HubSpot, AgencyAnalytics) generate prose from a model that can and
does misstate numbers. Nobody freezes the numbers, ties every figure in the
narrative to them, and gates publication behind a named reviewer.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `docs/` or
`frontend/`.

- **No client-facing report exists.** The dashboard owns only per-user layout
  intent, keyed `${tenantId}:${subject}`, with no tile data
  (`features/dashboard/dashboardService.ts:1-20, 49-55`). It is not shareable and
  is never frozen.
- **The numbers already exist, with lineage, org-scoped:**
  - `buildAttribution(tenantId, orgId)` (`features/campaign-intel/attribution.ts:128`)
    returns paid rows, web conversions (last click on `utm.campaign`), email
    rollups, `unattributedConversions`, `sharedJoinKeys`, `currencyMixed` and
    `computedAt` (`:101-126`). It never sums platform and web conversions
    (`:20-23`).
  - `kpiSummary(tenantId, orgId?, campaignId?)` (`features/campaign-connectors/performanceService.ts:154`).
  - `engagementStats(tenantId, campaignId)` (`features/email/engagementService.ts:555`).
  - The BI metric catalog (ADR 0417): closed-world `MetricDef`s
    (`features/bi/metricTypes.ts`) evaluated by `runMetric(tenantId, metricId,
    params, viewer)` (`features/bi/biService.ts:225-233`). `viewer: undefined`
    is a system read, unfiltered.
- **The portal is Proposed and not built.** ADR 0924 D5 plans a per-approver
  `ClientApprover` token store and per-package pages. On `origin/main`,
  `approvalPolicy` is the literal `'agency'` (`features/campaign-ops/types.ts:25`,
  `clientService.ts:65`). ADR 0934's shared counters are not on main
  (`host/sharedRateLimit.ts` is absent).
- **Contradiction found.** ADR 0924 D5 says it is "modelled on CRM e-sign", with
  its own hashed token store. But e-sign is itself a **sharing resolver**
  (`sign_request`, `features/sharing/sharingService.ts:581-592`; minted through
  `createLink` at `features/crm/signService.ts:115-116`). ADR 0448 D3 makes
  link-shaped capabilities sharing resolvers, never a parallel store
  (`host/capabilityToken.ts:13-18`). ADR 0958 D3 corrects this, and this ADR
  builds on the correction.
- **Two brands.** `host/brandAssets.ts` is the **host-global** app white-label
  (ADR 0511), the wrong owner for a per-agency report. The org-scoped
  `features/brand` `Brand` (`features/brand/types.ts:202-216`) is the right one:
  the agency's root org kit, or the client org's kit.
- **Scheduling and delivery.** Cron jobs fire through `host/scheduleDaemon.ts`
  (`fireJob`, `:95`) with fire gates (`host/scheduledJobFireGates.ts:32`).
  Transactional email is ADR 0905 D6's hoist. Public-surface rules: ADR 0887
  (re-check on every read, never cache) and ADR 0934 (shared counters).

## Decision

### D1 — A report is a frozen, hashed snapshot of numbers the app already computes

```ts
interface ReportDefinition {             // campaign-ops:report-def, key tenant::orgId::definitionId
  tenantId: string; orgId: string; definitionId: string; title: string;
  campaignIds: string[] | 'all';         // MarketingCampaign ids (ADR 0941)
  sections: Array<{ kind: ReportSectionKind; params: Record<string, string | number> }>;
  period: { kind: 'month' | 'week' | 'custom'; timezone: string };
  schedule?: { cron: string };           // via scheduleDaemon
  brand: 'agency' | 'client' | 'co-brand';
  narrative: boolean;                    // D3
  audience: string[];                    // collaboratorIds (ADR 0958), kind client-stakeholder
  version: number;
}
interface ClientReport {                 // campaign-ops:report, key tenant::orgId::reportId
  tenantId: string; orgId: string; reportId: string; definitionId: string; definitionVersion: number;
  periodStart: string; periodEnd: string;
  snapshot: { metrics: Record<MetricKey, ReportMetric>; tables: Record<string, ReportTable> };
  snapshotHash: string;                  // sha256 of canonicalized snapshot
  narrative?: ReportNarrative;           // D3; absent when disabled or ungrounded
  status: 'draft' | 'in_review' | 'published' | 'withdrawn';
  runId: string; publishedAt?: string; publishedBy?: string;
}
interface ReportMetric { value: number | null; unit: 'count' | 'currency' | 'ratio' | 'duration';
  currency?: string; previous?: number | null;            // same metric, prior period
  lineage: { source: ReportSourceId; computedAt: string; rows?: number; notes?: string[] } }
```

- **`ReportSectionKind` is a closed registry** (`REPORT_SECTION_SOURCES`). Each
  kind maps to an existing computing function and declares the `MetricKey`s it
  emits: `kpi` → `kpiSummary`; `attribution` → `buildAttribution`; `email` →
  `engagementStats`; `spend` → ADR 0952 spend versus cap; `experiments` →
  ADR 0949 results and ADR 0950 decision log; `leads` → ADR 0954 grades,
  routing and time to first touch; `journeys` → ADR 0955 sends and
  deliverability; `bi-metric` → `runMetric` with `orgId` bound. **Reporting adds
  no metric math.** A source that is not built yet is absent from the registry,
  not stubbed.
- Honesty flags carry through unchanged. `currencyMixed` renders as "mixed
  currencies, not summed". `unattributedConversions` and `sharedJoinKeys` render
  as data-quality notes. A `null` value renders "not available", never 0.
- `snapshotHash` binds review, publication and narrative to one set of numbers.
  A re-run that computes different numbers is a new report version. It never
  edits a published one.

> **As built and corrected (2026-10-20, P0, /architect):**
> - **Period honesty.** None of the three P0 sources filters by date:
>   `kpiSummary`, `buildAttribution` and `engagementStats` read all of a
>   client's data. Filtering them would be new metric math in the reporting
>   layer, which this ADR forbids. So a report stores its `periodStart` and
>   `periodEnd`, and every figure's lineage says
>   `all-data-to-computedAt` (shown as "Covers all data up to …, not only
>   this period"). The KPI lineage also carries the source's own data range.
>   Period-filtered sources are a source-side change, made as P5 adds sections.
> - **Sections** are `{kind, key, params}`. `key` is a short identifier that
>   prefixes the section's metric keys (`kpi.spend`, `launch.clicks`). `params`
>   are the kind's own strings: `kpi.campaignId`, which is required when the
>   report names campaigns, so an org-wide total never includes an excluded
>   campaign; and `email.emailCampaignId`. Every campaign and email campaign
>   named must be THIS client's. `engagementStats` is tenant-scoped only, so
>   the email campaign is proven the client's first.
> - **What carries through.** Honesty flags become lineage notes:
>   - mixed or unknown currency, in which case `currency` is left unset;
>   - unreported rows;
>   - shared UTM keys;
>   - "platform and web conversions not summed";
>   - approximate opens;
>   - unenforced unsubscribes.
>
>   `previous` is `null` until prior-period sources exist; it is never 0.
> - **Default periods** are the last complete calendar month or Monday–Sunday
>   week in UTC. The definition's `timezone` is validated and stored, and P1
>   scheduling applies it. `custom` takes explicit dates.
> - **Audience.** `audience` is refused (400) until P2. Collaborators are
>   ADR 0958's (PR #5076), and nothing reaches a client before the portal.
> - `snapshotHash` = sha256 of the canonical snapshot (the audit chain's
>   canonicalizer; ADR 0946 P2 moves it to the pure `host/canonicalJson.ts`).
> - **Workflow surface:** `computeReportSnapshot` and `readReportSnapshot`
>   bind the run to the client through campaign-ops' existing
>   `bindRunToClient` (acting person, run stamp, org scope). ADR 0941 D2b's
>   run tag is not on `main` yet. The `compute-snapshot` and
>   `report-snapshot-read` nodes ship with the P1 chain.

### D2 — Generation is a chain, scheduled or on demand

Chain pack `campaign-ops-reporting`, chain `client-report`:

1. `compute-snapshot` (read). Runs every section source for the client and
   period and outputs `{snapshot, snapshotHash}`. Replay serves the recorded
   output, so a replay never recomputes against newer data.
2. `report-narrative` (agent node, Reporting Analyst, ADR 0943). Only when
   `narrative: true`. See D3.
3. `validate-narrative` (pure). See D3.
4. `feature.campaign-orchestration.nodes.autonomy-gate`, ADR 0942 action class
   `report.publish` (ADR 0942 D1).
   Default `approve(role: account-lead)`. The reviewer sees the rendered report
   with every figure linked to its lineage.
5. `publish-report` (side-effect). CAS `in_review → published`, conditioned on
   `snapshotHash`. Mints or refreshes the grant-backed links (D5) and notifies
   the audience (D7).

Schedules use one cron job per definition through `scheduleDaemon`, with a fire
gate that refuses when the toggle or the client is inactive. A definition
change bumps `version`. Scheduled runs pin the version they started with.

> **As built (2026-10-20, P1 steps):**
> - **The steps.** `feature.campaign-ops.nodes` 1.1.0 adds `compute-snapshot`
>   (side-effect, so a replay serves the recorded snapshot), `report-snapshot-read`
>   (read) and `publish-report` (side-effect). They call the surface's
>   `computeReportSnapshot`, `readReportSnapshot` and `publishReport`, which
>   bind the run to the client.
> - **Status.** A report computed by a run goes straight to `in_review`, since
>   the gate is the chain's next step. A manual compute stays `draft` and can
>   never publish.
> - **Publishing.** `publishReport` is a CAS from `in_review` to `published`
>   that requires the stored `snapshotHash` to equal the approved one
>   (`report_snapshot_changed` otherwise). A replayed publish of the same
>   report returns the row.
> - **Scheduling** is one scheduler job per definition, under a reserved
>   job-id prefix:
>   - its `inputs` pin `definitionVersion`;
>   - every edit re-arms it with the new pin, and clearing the schedule
>     removes it;
>   - the cadence is validated before the definition is written;
>   - a run whose pin no longer matches is a typed `report_definition_changed`.
> - **The fire gate** refuses before any run:
>   - `feature-disabled` for either toggle off;
>   - a new skip reason, `client-inactive` (the client paused, archived or
>     gone, or the definition gone), rendered in the schedules UI in 4
>     locales;
>   - `dispatch-error` for a stale pin.
> - **`publish-report` refuses for now** (code review): with no gate yet, a
>   hand-built workflow chaining `compute-snapshot` into `publish-report` would
>   publish unreviewed numbers. So the surface method refuses with
>   `report_publish_unavailable` until the gated chain ships. The CAS above is
>   what the gated chain calls.
> - **The gate step waits.** The `client-report` chain and its ADR 0942
>   `report.publish` gate ship together once 0942 can freeze a policy for a
>   CLIENT-bound run. Today 0942's stamp requires a campaign, and a report
>   covers a client (team-lead decision 2026-10-20: cs-0942 adds an
>   org-scoped freeze). No stand-in or legacy gate ships. Until then a
>   scheduled slot resolves no workflow and records
>   `workflow-unresolved`, and the sub-toggle is OFF by default.

### D3 — The narrative may not contain a number the snapshot does not

```ts
interface ReportNarrative {
  sections: Array<{ heading: string;
    paragraphs: Array<{ text: string; refs: MetricKey[] }> }>;  // text uses {{key}}, {{key|delta}}, {{key|trend}}
  snapshotHash: string; agentRunId: string;
}
```

- **Read before write.** The agent receives the snapshot through
  `feature.campaign-ops.nodes.report-snapshot-read`. That tool output is never
  compacted (it joins `SCHEMA_READ_EXEMPT_TOOLS`, `host/toolResultTransform.ts:99`).
- **Closed-world validator** (`validate-narrative`):
  - Raw `text` outside placeholders may contain **no** digits, currency symbols
    or percent signs (`/[0-9$€£¥%]/`). Spelled-out numbers ("twelve", "double")
    are also refused, from a closed word list in four locales.
  - Every placeholder key must exist in the snapshot and appear in that
    paragraph's `refs`.
  - `|trend` renders "rose", "fell" or "held" **from the data**. The agent may
    not write direction words ("increase", "drop", "up", "down", and their
    locale equivalents) except immediately after a `|delta` or `|trend`
    placeholder whose sign agrees.
  - No claim of cause is allowed without a `refs` entry from an `experiments`
    or `attribution` source.
- A failure gets **one** error-fed repair, then a typed failure,
  `narrative_ungrounded`. The report goes to review **without** a narrative and
  carries a visible note. It never ships a fabricated or placeholder summary.
- Rendering substitutes values from the snapshot at display time, so the
  agent's text cannot drift from the numbers.

### D4 — White label per agency

The report and portal render with the brand that `ReportDefinition.brand`
picks: the agency's **root-org** `Brand` kit, the client org's kit, or both
(co-brand). They are served on the agency's portal domain when ADR 0906 custom
domains (and the unmerged edge-ownership ADR) are configured, and on the app domain otherwise. They never use
`host/brandAssets.ts`. v1 exports to PDF through a print stylesheet; a
server-side PDF renderer is deferred.

### D5 — One client portal: ADR 0924 extended, not forked

The portal is the `campaign-ops-client-portal` surface ADR 0924 introduced. It
grows from one page per package to one place per client stakeholder. The
identity is ADR 0958's `ExternalCollaborator` of kind `client-stakeholder`,
which replaces ADR 0924 D5's separate `ClientApprover` store before that
store is built.

- **Link-only (default).** Each item is a grant-backed sharing resolver:
  `campaign_change_set` (ADR 0924's package page, with its D2 decide-time
  checks unchanged) and `client_report` (a published report). Both re-check the
  grant, the collaborator, the client and the item state on every request.
- **Signed-in (opt-in per client, ADR 0958 Q3).** `/portal/:clientSlug` on the
  ADR 0958 collab router lists, for that stakeholder: pending decisions (the
  approval rows where they are an eligible decider), published reports (newest
  first), open asset requests (D6) and a history of their own decisions.
- Both modes render the same components. Only how the visitor is
  authenticated differs.
- A withdrawn report or a superseded change set goes dark on the next request:
  uniform 404, or ADR 0924's one stale-package 409 page.

### D6 — Asset requests are ADR 0958 intake, shown to the client

A client-facing asset request ("send three lifestyle photos of SKU-12, 1080×1350")
is an ADR 0958 `asset-request` resource with an `upload` grant for the
stakeholder. Uploads land as pending intake (ADR 0958 D5) and become usable only
when the agency accepts them. The portal adds no upload pipeline of its own.

### D7 — Public posture, limits and delivery

- **Rate limits.** ADR 0934 `takeShared` on every portal route: GET fails open
  to the in-process limiter; decision and upload POSTs fail closed. The numbers
  are 0934's (per token, per IP, per client org). **ADR 0934 must ship before
  P2.**
- **No caching, re-check per use** (ADR 0887). Request bodies are capped
  (comment 2,000 characters, decision body 8 KB). The page shows nothing outside
  the item (no navigation to other clients, no workspace chrome).
- **Delivery.** On publish, each audience member gets an email through the
  agency's transactional lane (ADR 0905 D6) with **the link only, no figures**,
  so a forwarded email leaks no numbers. No email connection means no email,
  with an honest "copy link" in the UI.
- **Audit.** Publish, view (count plus `lastViewedAt`, the sharing PUB-7 fields)
  and withdraw are recorded. Views identify the grant, never an anonymous
  visitor.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `features/campaign-ops/reports/` (definitions, reports, section registry, routes) and `features/campaign-ops/portal/` (the extended ADR 0924 surface). `features/sharing/` gains the `client_report` and `campaign_change_set` resolvers. No core edits. |
| 2 | Toggle | New sub-toggle `campaign-ops.client-reports` (default OFF, `bucketUnit: 'tenant'`), an `extraToggleDefaults` entry of `campaign-ops` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code with `campaign-ops`). The portal stays `campaign-ops-client-portal` (ADR 0924), so there is no second portal toggle. |
| 3 | Workflow surface | `ctx.features.campaignOps.computeReportSnapshot`, `readReportSnapshot`, `publishReport({orgId, reportId, snapshotHash})`. Every method takes `orgId` and checks the run tag (ADR 0941 D2b). |
| 4 | Node pack | `feature.campaign-ops.nodes` gains `compute-snapshot`, `report-snapshot-read`, `validate-narrative` and `publish-report` (side-effect, CAS). Chain pack `campaign-ops-reporting`. |
| 5 | AI chat and envelopes | No envelope. The narrative is a validated node output. Operators can ask about a report in the one chat (deep link `/?agent=<reporting-analyst>`), using the same read tool. |
| 6 | Agent pack | ADR 0943 Reporting Analyst: tools `report-snapshot-read` only. Its prompt states "every number must be a placeholder from the snapshot", and that line is test-pinned against the validator's word lists. |
| 7 | Public surface | Grant-backed sharing resolvers plus the ADR 0958 collab router. Tenant from the grant, uniform 404, ADR 0934 limits, no cache, payload caps. |
| 8 | RBAC | Definitions and manual runs need `workspace:write` on the client org. Publishing goes through the ADR 0942 `report.publish` gate (proposer cannot self-approve, the ADR 0924 D2 rule). Withdrawing needs `host:members:manage` on the client org. |
| 9 | Replay / fork | The snapshot is recorded in node output. Publication is CAS-bound to `snapshotHash`. A fork after `compute-snapshot` reuses it; a fork before recomputes and yields a new report version. Toggle state is not read at replay. |
| 10 | Frontend | A Reports tab in the `/campaign-studio` hub (definitions, history, review view with lineage popovers). **As built (P0):** the internal review view is a lazy **Client reports** section on the campaign-ops operations page (`/campaign-ops`), under the selected client, where the client already is. It lists definitions, computes a draft, and shows each figure with its source and notes in a `<details>` disclosure. Portal pages are standalone with no app chrome, branded per D4, with a print stylesheet. Four locales. Charts follow DESIGN.md tokens. |

## Why this is our advantage

- **Numbers you can trace, words you can trust.** Every figure in the narrative
  is a placeholder bound to a hashed snapshot with lineage. An AI summary
  cannot misstate a number because it cannot write one. AgencyAnalytics and
  HubSpot generate free prose.
- **Replayable reporting.** "What did we tell the client in March, and from
  which data?" is answered by the run: the snapshot, the narrative run and the
  approval.
- **One portal, three jobs.** Approvals (version-bound, ADR 0924), reports and
  asset requests share one identity and grant model per client. Competitors
  split them across a dashboard tool, an approval tool and Drive.
- **Agency control plane.** Per-client brand, audience and schedule inside one
  agency workspace.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `ReportDefinition`/`ClientReport` stores, `REPORT_SECTION_SOURCES` (`kpi`, `attribution`, `email`), `compute-snapshot`, internal review view | Snapshot numbers equal the source functions; a client-B snapshot is 404 to a client-A-only operator |
| P1 | `client-report` chain with the ADR 0942 gate and `publish-report` CAS; scheduling with fire gates | A changed snapshot cannot publish under an old approval; scheduled runs pin the definition version |
| P2 | `client_report` and `campaign_change_set` resolvers (needs ADR 0958 P1 and ADR 0934); portal link-only mode; emailed link | Revoked grant is dark on the next request; the email contains no figures |
| P3 | Reporting Analyst narrative, validator, repair, `narrative_ungrounded` path | A narrative with a raw digit, an unknown key or a contradicting direction word is refused; a report ships without a narrative rather than with a bad one |
| P4 | Signed-in portal home (needs ADR 0958 P2), asset requests (needs ADR 0958 P3), brand and custom-domain rendering, print stylesheet | Stakeholder sees only their client's items; uploads arrive as pending intake |
| P5 | Further sections as their sources land: `spend` (0952), `experiments` (0949/0950), `leads` (0954), `journeys` (0955), `bi-metric` | Each section is added only once its source exists |

### Implementation record

| Phase | What shipped | Tests |
|---|---|---|
| P0 (2026-10-20) | `features/campaign-ops/reports/` (types, `REPORT_SECTION_SOURCES` with kpi/attribution/email, service, routes); the stores `campaign-ops:report-def` and `campaign-ops:report`; sub-toggle `campaign-ops.client-reports` (OFF, tenant); surface `computeReportSnapshot` / `readReportSnapshot`; the campaign-ops eraser covers definitions and reports; the internal review view (`ClientReportsSection`, lazy, 4 locales). Ratchet: undeclared feature edges 99 → 103. | `test/adr0957-client-reports.test.ts` (8): the snapshot equals the sources verbatim, client B is a uniform 404 (including by id under client A's path), the email org check, closed-world definitions, version bump and stale edit, frozen reports, the sub-toggle, erasure. Sabotage: a transformed figure, an org-less lookup, a dropped email org check and a wrong hash each red a case. `clientReportsSection.test.tsx` (3). |
| P1 steps (2026-10-20) | `feature.campaign-ops.nodes` 1.1.0 (`compute-snapshot`, `report-snapshot-read`, `publish-report`); surface `publishReport`; the publish CAS on `snapshotHash`; one scheduler job per definition with a pinned version, re-armed on every edit; the fire gate and the `client-inactive` skip reason. The chain and gate step follow. | `test/adr0957-p1-report-steps.test.ts` (7). Sabotage: dropping the hash check, the version pin, the client-status check or the re-arm each reds its case. |

## Alternatives weighed

- **Share the live dashboard.** Rejected. It is a per-user layout with live
  reads (`dashboardService.ts:1-20`), so its numbers change after the commentary
  is written, and it has no client isolation for an outsider.
- **Let the model write the whole report.** Rejected. It breaks the honesty
  invariant (a model's numbers are claims, not data) and cannot pass the D3
  validator by construction.
- **A separate reporting portal beside ADR 0924's approval portal.** Rejected.
  Two external identities, two token lanes, two rate-limit budgets for the same
  client stakeholder.
- **Server-side PDF in v1.** Deferred. It adds a renderer dependency, and the
  print stylesheet covers "send it to my boss".

## RFC verdict

**Host extension, no RFC.** Routes are under `/v1/host/openwop-app/campaign-ops/*`,
`…/public/*` and `…/collab/*`. The approval gate rides the existing interrupt
plus ADR 0942 bridge, with the external-decider constraint of ADR 0958 D4.
Nothing is advertised.

## Open questions

1. **(David)** Default narrative posture: on for new definitions (with the
   validator and review gate), or off until an agency opts in? Proposed: on,
   because the gate and validator make it safe.
2. **(David)** Should a client be able to subscribe a stakeholder who has never
   accepted an invite (link-only by email)? Proposed: yes for link-only mode,
   with a grant expiring at the report's next period plus 30 days.
3. **(David)** Is a server-rendered PDF needed for the YC demo, or is print to
   PDF enough? Proposed: print to PDF.
4. Spelled-out-number word lists need locale review (es, pt-BR, ja); `ja` uses
   numerals in kanji. Owner: the i18n lane.
5. No `/architect` pass has been run yet. Run it before Accepted, together with
   ADR 0958, because the portal's security rests on 0958 D2–D3.

## Planning rows

**ROADMAP (Campaign Studio program table):**
`| 0957 | **Client reporting and portal** ([ADR 0957](docs/adr/0957-client-reporting-and-portal.md)) | `campaign-ops.client-reports`, `campaign-ops-client-portal` | 0921, 0924, 0958, 0934, 0942, 0943; sections from 0949–0956 | `feature.campaign-ops.nodes`, `campaign-ops-reporting` chain pack | Host extension | 🔵 Proposed (P2 waits on 0958 P1 and 0934) |`

**FEATURES "Future features":**
`- **Client reporting and portal (ADR 0957, Proposed 2026-10-19)** — scheduled, white-labelled client reports that freeze the app's existing metrics (attribution, KPIs, email, then spend, experiments, leads and journeys) into a hashed snapshot with lineage. A Reporting Analyst narrative may cite numbers only as placeholders the validator checks, and nothing is published until a named reviewer passes the ADR 0942 gate. One client portal (ADR 0924 extended) brings together version-bound approvals, published reports and asset requests on the ADR 0958 collaborator model, under ADR 0934 shared limits. Sub-toggle `campaign-ops.client-reports` (OFF, tenant). No RFC.`


### Recovery architecture review and corrections — 2026-10-25 (validation pending)

Track A: this is host application work. The existing campaign-ops owner,
client-org authorization, subject eraser, chain registry and single scheduler
remain the seams. No public portal, second chat, new identity, metric calculator,
raw in-tree WorkflowDefinition, normative wire field or capability is added.
The original implementation record is retained; the P1 review/publish chain
and P2–P5 remain pending at their existing dependency gates.

- Manual drafts stay available. A requested schedule is rejected before saving
  its definition when the report workflow is absent. A previously saved job also
  refuses `workflow-unresolved` before starting a run or spending its budget.
  An installed portable chain registers through the existing chain-backed seam.
  Tests use an explicitly local compute-only chain fixture to test scheduling
  bookkeeping; it is not a shipped report-review/publish chain.
- Sources check the source feature's live access before computing (including a
  named campaign's source). Reports copy existing metrics, with the original
  all-data-to-computedAt lineage; no date-filtered metric claim is introduced.
  Impossible normalized calendar dates and unsupported nested fields refuse.
- A run's report write has a deterministic identity and CAS insert. A lost write
  acknowledgement resumes the same stored snapshot; a manual computation still
  creates a fresh report. Publication checks both the requested fingerprint and
  the stored snapshot's actual fingerprint before its existing status CAS.
- Report author/decider erasure uses bounded CAS to preserve concurrent state
  changes and avoid resurrecting a deleted row. The report form is keyed by
  client org, so a draft or late save refresh cannot cross a client switch.

The recovery adds source-toggle, missing-workflow, lost-acknowledgement, modified
snapshot, invalid-date/closed-field and cross-client UI regressions. They are
not yet run: the ADR0942 canonical train owns the one local heavy-work slot.
Publication still refuses through the exposed surface until the real review
gate and chain are composed; no feature flag, schedule, vendor call or production
configuration was changed by this source recovery.


### Recovery focused qualification — 2026-10-25

The validation-pending notes above describe the preparation stage. The composed
branch now includes qualified main 2f4e6c0ce and all three original branch
histories. Native backend typechecking, pack-surface parity (6 cases), and the
20-file focused suite (270 passing cases, one expected failure) pass. Frontend
lint, the canonical build including CSS/token and bundle gates, test
typechecking, and nine focused suites (67 cases) pass. Entry gzip remains
within the existing 129 kB ceiling (49 bytes headroom); no budget was raised.
The generated floor is 375 / served 332 / unresolved 0, with the same 43
deferred classifications. The measured toggleable dependency ceiling is 113.

Brand, CMS and KB remain always-on substrate; regression fixtures disable
actual toggleable sources, and deleted-collection and revoked-member cases
exercise their live authority checks. A new real-KV fault test also proved
that a proposal CAS with no confirmed winner must refuse, rather than return a
phantom pending proposal; the corrected implementation passes. This does not
complete the later phases listed above. Full canonical CI remains required
before merge, and deployment remains separately queued.
