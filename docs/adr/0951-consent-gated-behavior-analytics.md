# ADR 0951 — Consent-gated behavior analytics: heat maps, session replay, AI summaries

Status: Proposed

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 3. Net-new from David's 2026-10-19
request ("evaluate heat maps"). Extends `features/analytics` (ADR 0018) and composes
the consent stack (ADRs 0020, 0227, 0338, 0857, 0860), retention (ADRs 0077, 0380)
and subject erasure (ADR 0464). Feeds hypotheses to ADR 0949's backlog. Read by
0957 (client reports) and 0960 (cockpit).

## Context

Landing-page optimization needs to know where visitors click, how far they scroll,
what they ignore, and where they get frustrated. Clarity gives heat maps and replay
away free with Copilot summaries; Hotjar/Contentsquare added Sense agents. Two
things make this surface legally hot in a way page analytics is not:

- **ePrivacy Art. 5(3)** requires prior consent for reading or storing information
  on a device unless it is strictly necessary. A recorder script that reads the DOM
  and input events is not strictly necessary.
- **CIPA §631 (California wiretapping)** litigation in 2025–26 treats session replay
  captured without all-party consent as interception of a communication's contents.
  Courts have looked at whether content was captured *before* consent and whether it
  was masked *before* it left the browser. Masking on the server does not help,
  because the interception has already happened.

So the design rule is: **capture nothing before consent, mask on the client before
transmit, keep aggregate and individual capture under separate purposes, and never
record payment, password or health fields.**

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `frontend/` or `docs/`.

- **Analytics owns behavioral events but has no behavior capture.** `EventType =
  'pageview' | 'event' | 'conversion'` (`features/analytics/analyticsService.ts:36-37`).
  The store is `DurableCollection('analytics:event')` in `host_ext_kv`, tenant-indexed
  (`:83`). Props are capped at 4 KB (`:81`, `:122`), and query strings and fragments
  are stripped from paths (`:27-32`). PII fields are declared (`:107-108`). There is
  no click, scroll or replay type.
- **Public beacon:** `POST /host/openwop-app/public-analytics/:orgId/collect`
  (`features/analytics/routes.ts:84`), on `PUBLIC_PATH_PREFIXES`
  (`middleware/auth.ts:214`), with a per-org budget of 600 requests/min per instance
  (`routes.ts:41-50`).
- **Consent:** one chokepoint `isAllowed` (`features/consent/consentService.ts:886`).
  Categories are `necessary | analytics | marketing | marketing.*` (`:41-44`).
  **When the `consent` toggle is OFF, `isAllowed` is permissive** (`:908-909`). A
  strict explicit-opt-in set exists, `STRICT_EXPLICIT_OPT_IN = {'marketing.whatsapp'}`
  (`:56`): only a recorded `true` permits, with no toggle-off escape and no opt-out
  default (`:888-892`). The visitor decision is `visitorAnalyticsAllowed`
  (`features/consent/visitorConsent.ts:62-67`), region-aware via
  `REGULATED_REGION_FLOOR = ['EEA','UK','US-CA']` (`visitorRegion.ts:27`). The
  visitor banner and key minting are in `frontend/react/src/features/site/
  VisitorConsentBanner.tsx` and `visitorConsent.ts`. The key is minted only after
  consent (ADR 0860 D5, `visitorBeacon.ts:13-17`).
- **Erasure:** `registerSubjectEraser` (`host/subjectErasure.ts:145`). Every eraser
  must appear in the manifest `EXPECTED_SUBJECT_ERASERS`
  (`host/subjectEraserManifest.ts:212`), which `missingSubjectErasers` checks
  (`host/subjectErasure.ts:168`). Analytics registers `eraseSubjectAnalytics`
  (`analyticsService.ts:689`).
- **Retention:** `registerRetentionPurger` (`host/retentionPurger.ts:57`). Analytics
  ages `confidential-pii` rows (`analyticsService.ts:694-705`). Global size age-out is
  `registerKvAgeOut` (ADR 0380 §3).
- **Blob storage exists:** `host/blob/gcsBlob.ts`, `host/blob/s3Blob.ts`, plus
  `host/blob/blobBootCheck.ts`. Growth is gauged hourly by `host/storageGrowthGauge.ts`
  (ADR 0871).
- **Access logging:** `GovernanceDecisionKind` includes `'access'`
  (`host/governanceDecisionLog.ts:10`). The hash chain is `host/auditChainService.ts:188`.
- **Host permission scopes** are a closed list (`host/accessControlService.ts:119-139`,
  e.g. `host:billing:manage`).
- **An insights agent exists:** `vendor.openwop-app.analytics.agents.insights`
  (`packs/vendor.openwop-app.analytics.agents/pack.json`). Analytics nodes are `query`
  and `events` (`packs/feature.analytics.nodes`).

**DB-growth constraint (the run-snapshot and ADR 0868/0871 lessons).** One replay
session is typically 50–500 KB compressed. At even 1,000 recorded sessions per day,
`host_ext_kv` would grow by 0.05–0.5 GB a day per busy client. **Replay bytes must
never go into Postgres.**

## Decision

### D1 — Two capabilities, two purposes, two toggles

| | Heat maps (aggregate) | Session replay (individual) |
|---|---|---|
| What | click maps, scroll depth, attention (time in view per section), rage, dead and error clicks | a masked DOM-mutation recording of one session |
| Consent purpose | existing `analytics` category (ADR 0860 region rules apply) | **new `analytics.replay` category, added to `STRICT_EXPLICIT_OPT_IN`**: explicit opt-in in every region, no toggle-off escape, no opt-out default |
| Stored | aggregate cells only, **no visitor identifier** | an index row (Postgres) + masked chunks (blob) |
| Toggle | `analytics.heatmaps` | `analytics.session-replay` (also needs blob configured) |

Both are sub-toggles of `analytics`, the `analytics-visitor-identity` precedent
(`features/analytics/feature.ts:44-49`). Both default **OFF** with `bucketUnit:
'tenant'`. With replay ON but no blob backend, the settings page says "not
configured", and the recorder is never served (fail-closed).

The visitor banner (ADR 0860) gains a separate, unticked "Session recording" choice.
It appears only on sites whose org has replay ON. "Accept all" does not tick it in
regulated regions (Q2).

### D2 — Capture: one first-party recorder, masked before transmit

- **Recorder:** `frontend/react/src/features/site/behaviorRecorder.ts` for SPA public
  pages, plus the same module built as `owx-recorder.js` for externally served
  published sites. It is first-party only and sends nothing cross-site. Replay uses
  rrweb (MIT) in its strict configuration (Q4). Heat capture is our own small listener
  and needs no DOM serialization.
- **Nothing loads before consent.** The module is imported dynamically after the
  visitor's recorded decision allows the purpose. A tombstoned or erased key never
  loads it.
- **Mask by default, on the client:**
  - every `input`, `textarea`, `select` and `contenteditable` value is replaced before
    serialization (`maskAllInputs`). Keystrokes are never recorded;
  - all text nodes are masked (`maskTextSelector: '*'`) except elements an editor
    explicitly marks `data-owx-unmask` in the CMS. Default posture: layout visible,
    words hidden;
  - **blocked outright** (`blockSelector`), even if unmasked: `type=password`, any
    `autocomplete="cc-*"`, `one-time-code`, payment iframes, any field carrying a new forms
    field attribute `sensitivity: 'payment' | 'health' | 'credential'` (forms has no such
    attribute today; P2 adds it, and fields with payment or password input types get it
    by default);
  - **pages never recorded:** commerce checkout and account pages, any page whose CMS
    page has `behaviorCapture: 'off'`, and any page carrying a form with a `health`
    field.
- **Server re-check (defense in depth, never the primary control):** the ingest
  scans each chunk for Luhn-valid card numbers, email addresses, phone numbers and
  SSN patterns. A hit drops the whole chunk and increments `replay_chunk_rejected` with
  the reason. The chunk is never "fixed up" and kept.
- **Bots and AI agents** (UA plus the existing bot heuristics) are excluded from heat
  aggregates and replay, and counted separately.

### D3 — Ingest and storage within a budget

- **Endpoints** (public, on `PUBLIC_PATH_PREFIXES`, same org derivation and budget
  posture as the beacon): `POST …/public-analytics/:orgId/heat` (batched heat events,
  ≤ 50 per batch) and `POST …/public-analytics/:orgId/replay/:sessionId/chunk`
  (≤ 256 KB gzipped per chunk). Each call re-checks consent server-side, so a client
  cannot claim it.
- **Heat aggregates:** `analytics:heat` cells keyed `(orgId, pageId, pageVersion or
  experiment arm, deviceClass, day, cell)`, where `cell` is a 2% viewport-relative grid
  square or a stable element selector (top 500 per page per day; the rest go to an
  `other` cell). Counts only, with no `sessionKey` and no `visitorHash`. Rows are
  bounded at about 50 pages × 3 devices × 500 cells × days, and each cell is
  incremented in place.
- **Replay index:** `analytics:replay` rows `{sessionId, orgId, subjectKey (the
  consented key), pageIds, startedAt, durationMs, bytes, flags: {rage, dead, error,
  converted}, blobRefs[]}`. **Chunks go to blob** under
  `replay/<tenant>/<org>/<sessionId>/<n>`.
- **Budget, defaults per client org (operator-tunable, plan-limited via ADR 0928):**
  sample 10% of consented sessions; at most 2,000 recorded sessions per day; at most
  30 minutes and 5 MB per session; 30-day retention (maximum 90). Over budget, the
  recorder is not served and the cap is reported. The storage-growth gauge gains
  `replay_bytes_gauge` and `heat_cells_gauge` lines.

### D4 — Retention, erasure and access

- **Retention:** a `registerRetentionPurger` entry for `analytics:replay`
  (`confidential-pii`) deletes index rows *and* their blobs past the org's window.
  Blob deletion comes first, so a crash leaves an orphan blob, which a sweep finds, and
  never an index row pointing at nothing. Heat cells age out with `registerKvAgeOut`
  at 13 months (the CNIL audience-measurement ceiling).
- **Erasure (DSAR):** `eraseSubjectReplays` deletes every replay of the subject's
  keys, both blobs and rows. It is registered **and** added to
  `EXPECTED_SUBJECT_ERASERS`, so `missingSubjectErasers()` fails a boot that forgets
  it. Heat cells hold no identifier and go on the ADR 0464 exemption allowlist with
  that justification. A consent withdrawal for `analytics.replay` deletes that
  subject's recordings, not only future capture. No withdrawal hook exists in
  `consentService` today; P0 adds one that calls the same eraser for this one purpose.
- **Access:** new host scope `host:analytics:replay` (owner and admin by default,
  grantable through a custom role per client org). The replay list and player require
  it on the exact client org (ADR 0921 D2). Every playback writes an `access`
  governance decision and an `analytics.replay.viewed` hash-chain entry
  `{sessionId, viewer, at}`. Heat maps need only `workspace:read`.
- **Agency isolation:** all rows and blob prefixes carry `orgId`. No cross-client list
  exists.

### D5 — The behavior summary agent writes hypotheses, not changes

- **Signals service** (deterministic, `features/analytics/behaviorSignals.ts`):
  rage-click clusters (≥ 3 clicks within 700 ms within 30 px), dead clicks (no DOM
  mutation or navigation within 1 s), scroll drop-off by section, attention per
  section, error clicks, and funnel step drop-off joined from funnels. Each signal
  carries counts, the share of sessions affected and a sample of replay ids (ids
  only).
- **Agent:** the existing `analytics.agents.insights` gains tools
  `analytics.behavior-signals` (read) and `experiments.propose-hypothesis` (ADR 0949).
  The proposal creates a `proposed` experiment draft *and* a kanban card in the
  campaign's experiment backlog stack (ADR 0311 `openwop:kanban.add-todo`). The agent
  **never reads raw replay content.** It sees signals and masked selectors only, so no
  recorded visitor content reaches a model provider. A human (or ADR 0942 policy)
  launches any test.
- The CRO Analyst (ADR 0943) can be scoped to the same tools, under the rule
  "capabilities live in node packs, not in a named agent".

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Extends `features/analytics/` (service, routes, `behaviorSignals.ts`, blob store adapter) + `features/site/` recorder. Consent category added in `features/consent`. No new package. |
| 2 | Toggle | Sub-toggles `analytics.heatmaps` and `analytics.session-replay`, both **OFF**, `tenant`, category `CRM` (the analytics family), an `extraToggleDefaults` entry of `analytics` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code with `analytics` and `consent`); the older kebab sibling `analytics-visitor-identity` keeps its id. Replay needs `consent` ON, because with it OFF `isAllowed` is permissive for everything except strict categories, and replay is strict. |
| 3 | Workflow surface | `ctx.features.analytics.{heatmap, behaviorSignals}` (read). No replay content on the surface. |
| 4 | Node pack | `feature.analytics.nodes` gains `heatmap` and `behavior-signals` (read). Chain `analytics.behavior-review` (weekly: signals → insights agent → hypothesis cards → notify). |
| 5 | Envelopes | None. |
| 6 | Agent pack | Extends `vendor.openwop-app.analytics.agents.insights` with two tools; prompt parity pinned. No new agent. |
| 7 | Public surface | `/heat` and `/replay/:sessionId/chunk` under the public analytics prefix; org from the path; server-side consent; payload caps; per-org budget; uniform 202 on refusal (no consent oracle). |
| 8 | RBAC | Heat: `workspace:read`. Replay: `host:analytics:replay` on the client org; every view logged. Settings: `workspace:write` + admin. |
| 9 | Replay / fork | Read-only nodes over derived data; a forked behavior-review run re-reads signals snapshotted into its node output. The hypothesis proposal is a side-effect node keyed by `(signalId, week)`. |
| 10 | Frontend | Analytics → "Behavior" tab: page picker, device toggle, click/scroll/attention overlays on the page version (or experiment arm), signal list with "propose test"; replay list and player behind the scope, with a "recording masked" banner. |

## Why this is our advantage

- **Behavior evidence becomes governed experiments.** Signals become hypotheses in the
  same per-client backlog that ADR 0949 runs and ADR 0950 promotes. Clarity and
  Hotjar summarize. They do not hand off to a governed test-and-promote run.
- **Privacy by construction, provable per client:** strict opt-in for replay,
  client-side masking, blocked field classes, logged and role-gated playback, DSAR
  coverage enforced at boot. Agencies can show each client exactly who watched which
  session.
- **No model sees visitor content.** The agent works on derived signals. Most
  "AI replay summary" products send recordings to a model.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `analytics.replay` strict category + banner choice; host scope; erasure + manifest entry; retention purger; blob adapter with boot check | Manifest test fails without the eraser; replay settings show "not configured" without blob |
| P1 | Heat capture + `/heat` ingest + aggregate cells + overlay UI (clicks, scroll, attention) | No identifier in `analytics:heat` (schema test); bot traffic excluded |
| P2 | Replay recorder (masked) + chunk ingest + server re-check + player + access logging | Fixture page with card/password/health fields records none of them (DOM witness); every view writes an audit entry |
| P3 | Signals service + insights tools + `analytics.behavior-review` chain + hypothesis cards into the 0949 backlog | A rage-click fixture yields a proposed draft and a kanban card |
| P4 | Budgets per plan (0928), growth gauges, client-report tiles (0957) | Over-budget org stops being served the recorder; gauge lines present |

## Alternatives weighed

- **Embed Clarity or Hotjar.** Free and mature. Rejected: third-party capture breaks
  per-client isolation, adds a processor per client, and gives us neither DSAR control
  nor access logs. It could be offered later as a connection pack.
- **Store replay in `host_ext_kv`.** Rejected on growth (see the audit).
- **One consent purpose for both.** Rejected: aggregate heat maps and individual
  recordings have very different risk, and CIPA exposure attaches to the second.
- **Server-side masking only.** Rejected: interception happens at transmit.

## RFC verdict

**Host extension, no RFC.** Public lanes sit under the existing
`/v1/host/openwop-app/public-analytics/*` prefix. The consent category, scope and
stores are host-internal. Nothing is advertised at `/.well-known/openwop`.

## Open questions

1. **(David)** Is the replay default (10% sample, 2,000 sessions a day, 30 days) right
   for agency clients, and which plan tier (ADR 0928) unlocks replay at all?
2. **(David)** In non-regulated regions, should "Accept all" include session
   recording, or must recording always be its own tick? Proposed: always its own tick
   (CIPA reaches visitors from California wherever the site is).
3. **(David)** Should replay be excluded entirely for orgs whose campaigns are in a
   regulated category (health, finance) under 0942?
4. Is rrweb acceptable as a dependency (bundle size about 40 KB gzipped, loaded only
   after consent), or do we build a smaller recorder?
5. Should heat aggregates exclude the experiment-arm dimension when an arm has fewer
   than 30 sessions (k-anonymity on small cells)?

## Planning rows

**ROADMAP (Campaign Studio program table):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| T3-c | **Consent-gated behavior analytics** ([ADR 0951](docs/adr/0951-consent-gated-behavior-analytics.md)): aggregate heat maps (`analytics` consent, no identifiers) + masked session replay (strict `analytics.replay` opt-in, blob storage, budgets, DSAR, logged scoped playback); insights agent turns signals into 0949 hypothesis cards | `analytics.heatmaps`, `analytics.session-replay` | 0018, 0860, 0857, 0464, 0380, 0871, 0949 | `feature.analytics.*` | Host extension | 🔵 Proposed |

**FEATURES "Future features":**

- **Behavior analytics: heat maps + session replay (ADR 0951, Proposed)**: click,
  scroll and attention heat maps stored as identifier-free aggregate cells; session
  replay under a new strict `analytics.replay` consent category, masked on the client
  before transmit, never capturing payment, password or health fields; chunks in blob
  storage with per-org budgets and retention; DSAR eraser in the boot manifest;
  playback needs `host:analytics:replay` and every view is logged. The insights agent
  reads derived signals only and files hypotheses into the ADR 0949 backlog. Sub-toggles
  `analytics.heatmaps` / `analytics.session-replay` (OFF, tenant). Host-ext, no RFC.
