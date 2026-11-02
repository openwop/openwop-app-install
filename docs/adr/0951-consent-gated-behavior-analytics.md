# ADR 0951 — Consent-gated behavior analytics: heat maps, session replay, AI summaries

Status: Accepted (P0/P1 source recovered; integration qualification pending; P2–P4 open). The P2 privacy amendment below was **approved by David on 2026-10-28; implementation and qualification pending**.

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

> **Correction 2026-10-20 (P0 build, /architect).** Three facts the text above did not
> state, all now implemented:
> - **How the banner knows "replay ON".** The public posture read
>   (`GET …/public-consent/:orgId/posture`) returns `choices: ['analytics.replay']`
>   when the org offers it. Consent owns the question through a new seam,
>   `registerVisitorChoiceProvider`; analytics answers it (`replayEnabled`: the
>   `analytics` and `analytics.session-replay` toggles plus configured storage), so
>   consent never imports analytics. No storage ⇒ not offered, so a visitor is never
>   asked to consent to a recorder that cannot run.
> - **Q2 is applied as proposed: always its own tick, in every region.** "Accept"
>   records the tick as it stands (unticked ⇒ `false`); "Reject" refuses both. A site
>   that offers recording therefore asks a visitor with no recorded choice in an
>   `opt-out` regime too, with copy that does not claim nothing is counted.
> - **`consent` ON is required and is enforced structurally.** With it OFF the public
>   consent lane 404s, so `analytics.replay` can never be recorded, and the strict
>   category has no toggle-off escape. A visitor without a consent token is always
>   refused (`visitorReplayAllowed`): the grant exists only under the token's
>   `visitor:` subject.
>   *Corrected 2026-10-30 (P2 review #6): `visitorReplayAllowed` was never the
>   gate. It is deleted. The gate is the upload lane's token subject plus
>   `putReplayChunk`'s live strict grant generation.*
> - **Only the visitor can GRANT `analytics.replay`.** Every consent write path is
>   shared (workflow `record` node, form sink, CRM merge, WhatsApp keywords, admin), and
>   without a guard any of them could record "this person agreed to be recorded". A
>   grant (a transition to `true`) is refused with a typed 400 unless it arrives on the
>   public consent lane (`source` `public:<orgId>`, set server-side by that route).
>   Refusals are accepted from any source; carrying an already-stored `true` forward is
>   not a grant.

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
> **Correction 2026-10-20 (P0 build, /architect) — the blob ROOT.** The tenant's blob
> surface (`buildHostSurfaceBundle({tenantId}).storage.blob`) is the same per-tenant
> root the `core.storage.blob-*` nodes read and write, so chunks stored there would be
> readable by any workflow the tenant runs, bypassing `host:analytics:replay` and the
> per-view access log. Chunks go under a RESERVED host root (`__openwop_session_replay__`,
> the `__openwop_boot_check__` precedent), with tenant, org and session encoded in the
> key `replay/<tenant>/<org>/<sessionId>/<n>`. "Configured" means a durable blob backend
> is selected (GCS or S3; the ADR 0867 boot round trip exits a revision whose backend
> fails, so configured implies verified). The process-local `memory` blob never counts,
> except under the dev/test allowance `OPENWOP_REPLAY_ALLOW_MEMORY_BLOB=true`, which
> `NODE_ENV=production` refuses.

- **Replay index:** `analytics:replay` rows `{sessionId, orgId, subjectKey (the
  consented key), pageIds, startedAt, durationMs, bytes, flags: {rage, dead, error,
  converted}, blobRefs[]}`. **Chunks go to blob** under
  `replay/<tenant>/<org>/<sessionId>/<n>`.
- **Budget, defaults per client org (operator-tunable, plan-limited via ADR 0928):**
  sample 10% of consented sessions; at most 2,000 recorded sessions per day; at most
  30 minutes and 5 MB per session; 30-day retention (maximum 90). Over budget, the
  recorder is not served and the cap is reported. The storage-growth gauge gains
  `replay_bytes_gauge` and `heat_cells_gauge` lines.

> **Correction 2026-10-20 (P1 build).** What P1 actually built, where it differs from
> the text above:
> - **Cells.** A cell is a 2% square of the DOCUMENT (x, y as fractions of its width
>   and height), or an author-given element id (`data-owx-id`, else `id`, in a
>   markup-safe alphabet; never text). The row is keyed (tenant, org, page, day,
>   device, arm), with ≤ 500 cells plus `other`, ≤ 100 sections, and ≤ 200 pages per
>   org; a new page past the cap is dropped and logged. Counts are CAS-incremented.
> - **The experiment arm is server-derived** (`resolveExperimentStamp`, the ADR 0651
>   D3 rule), never client-claimed. **Q5 is decided as proposed:** an arm with fewer
>   than 30 page views is listed as suppressed, and its cells are not returned on
>   their own.
> - **One response for every non-malformed batch: `204`.** That covers consent
>   refused, heat maps off, bot, page cap and recorded. The lane is not an oracle for
>   anyone's consent or the org's settings. A malformed batch is a typed 400 naming
>   the field.
> - **Bots** (`botTraffic.ts`) count on the page's row as `bots`, never as cells,
>   views or scroll, and they never create a page. They are classified by UA
>   tokens (crawlers, AI agents, headless browsers, HTTP libraries) plus the page's
>   own `navigator.webdriver` report. A missing UA counts as automated. The list is
>   deliberately separate from publishing's prerender allowlist, which answers a
>   different question.
> - **The overlay is not on a screenshot.** The host has no page-snapshot capability,
>   so the click map is drawn on the page's own proportions, with a link to the live
>   page. Every value is also in a table (named elements, top areas, scroll reach,
>   attention). Drawing on a real render of the page version needs a snapshot
>   capability: open, P4 or later.
> - **Wired on the published front page** (`FrontPage`, which docs also render). The
>   funnel viewer is not wired yet (open, with P2's recorder mount).
> - Rage, dead and error clicks are P3 signals; P1 records plain clicks only.
> - Both stores carry `tenantOf`, so ADR 0284 tenant teardown reaches them, and they
>   age out at 396 days on the ADR 0380 kv lane. They name no person, so they are not
>   subject-erasure stores.

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
  grantable through a custom role per client org).

> **Correction 2026-10-20 (P0 build).** Four statements in D4 were not true of the code:
> - **"grantable through a custom role" is false today.** A custom role carries only
>   protocol scopes (`isProtocolScope`, `accessControlService.ts`); management scopes
>   are never mintable onto one. `host:analytics:replay` is built-in admin/owner only,
>   like `host:billing:manage`. Per-client delegation needs a custom-role change (open).
> - **"fails a boot that forgets it" overstates the guard.** `missingSubjectErasers()`
>   is not called at boot. A forgotten eraser fails the manifest test (both its source
>   layer and its `createApp()` layer — witnessed red in P0) and counts as a failed,
>   named system on every erasure.
> - **The retention purger alone does not hold the window.** The ADR 0077 governance
>   fan-out runs only for governed tenants with a configured window, behind
>   `OPENWOP_RETENTION_SWEEP_ENABLED`. P0 adds a default-on seam,
>   `registerDefaultWindowSweep` (`host/retentionPurger.ts`), run by the retention
>   daemon beside the ADR 0380 TTLs, so the 30-day default holds on every posture; it
>   skips legal-held tenants per row and does nothing under a dry run. The governance
>   purger also runs, and its cutoff is the later (stricter) of the tenant window and
>   the replay default, so a long tenant window never keeps a recording longer.
> - **Tenant teardown would orphan the chunks.** The ADR 0284 walk deletes `host_ext_kv`
>   rows, not blobs. P0 registers a tenant-purge pre-hook that deletes each session's
>   chunks, then its row. (Org deletion has no feature cascade today; an org's
>   recordings age out with the window. Open item for P2.)
>
> The withdrawal hook is a consent seam, `registerConsentWithdrawalHook(category, …)`,
> fired from every consent write (`recordConsent`, the merge CAS path and its
> fallthrough) when the stored value is no longer `true` and either the prior record
> said `true` or the caller explicitly sent `false`. It is awaited; a failure is logged
> by hash and never fails the consent write (the recorded refusal is what stops
> capture; the hook is idempotent and re-runs on the next explicit refusal). A CRM
> merge that folds `analytics.replay: false` onto a survivor runs it for the survivor:
> it only ever narrows, which is the safe direction. Turning `analytics.session-replay`
> OFF does not delete existing recordings; they age out with the window
> (purge-on-disable is an open item for P2). The replay list and player require
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

### Implementation record

| Phase | Commit | Tests |
|---|---|---|
| P0 | (this PR) | `test/adr0951-p0-replay-privacy.test.ts` (24: strict category, visitor-only grant, withdrawal, DSAR, retention, storage gate, reserved root, teardown, scope, posture + settings routes); `test/subject-eraser-manifest.test.ts` (both layers red without the eraser — witnessed); frontend `site/__tests__/replayConsent.test.tsx` (7), `analytics/__tests__/behaviorCapture.test.tsx` (5) |

| P1 | (this PR) | `test/adr0951-p1-heatmaps.test.ts` (21: the no-identifier schema test, which pins the field set AND checks stored JSON after a real ingest carrying session key, IP and UA; bot exclusion + separate count; bots never create a page; consent refusal; toggle gating; 9 closed-world 400s; cell cap; arm k-anonymity; scroll reach; 13-month age-out; member-only read); frontend `site/__tests__/heatCapture.test.ts` (4: nothing before consent or on a non-collecting site, no text or input values sent, withdrawal stops capture), `analytics/__tests__/heatmapPanel.test.tsx` (6) |

P1 sabotage witnesses: bot classification bypassed in the route (2 red); a session
key written into the row (1 red); the consent and withdrawal checks removed from the
capture module (2 red).

P0 sabotage witnesses (each red, then restored): eraser registration removed (4 red
across the manifest test and this ADR's test); `analytics.replay` dropped from
`STRICT_EXPLICIT_OPT_IN` (3 red); the merge-path withdrawal hook removed (1 red); the
legal-hold skip removed (1 red); the governance purger using the tenant cutoff alone
(1 red); the banner's checkbox pre-ticked (2 red); `replayAllowedFor` inferred from
the analytics choice (4 red); the visitor-only grant guard bypassed (1 red).

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


Recovery checkpoint — 2026-10-25 (source only): original P0 `dc1df8d6e` and
P1 `e180c17de` histories are retained on current main. Merge conflicts preserve
all current subject erasers and historical steward records. The new consent,
retention, store, capture and heat-map behavior has NOT been executed in this
recovery. Two new regression cases are authored UNRUN for prototype-named
attention sections and simultaneous admission at the org page cap; review
identified both as needing verification before merge. Generated metadata,
focused checks and canonical CI remain pending.

The separate P2 replay capture/player source remains preserved on its recovery
branch. Atomic chunk/subject/budget reservation, hostile-HTML playback egress,
serializer privacy and consent rechecking after compression require correction
before its public ingest is exposed. This checkpoint does not claim P2 complete.


Recovery correction — 2026-10-25: the new regressions reproduce both a section
cap bypass through valid Object prototype member names and concurrent new-page
admission exceeding the last org slot. Attention now reads only own properties.
The existing analytics owner replaces read-count-write admission with one
cross-instance CAS catalog per tenant/org, holding the bounded page metadata
itself. Expired entries free capacity in that same update. Legacy page metadata
is adopted without deleting its old rows; historical over-cap indexes remain
readable and deny new pages until retention frees capacity. The catalog uses
the existing tenant teardown and 396-day age-out owners; bots admit no page
and refresh no lastSeen. No identifier, public route, consent category or
replay ingress is added. Focused and canonical qualification remain pending.


Recovery availability correction — 2026-10-25: P0 storage/privacy and P1 heat
maps are recovered, while P2 recording remains withheld for the documented
privacy/concurrency findings. P0 must not claim recording is available merely
because storage and toggles are configured. The actual recorder will register
the existing visitor-choice provider when installed; P0 registers no recording
choice. Settings consult that same registry and the UI honours `available`.
All four locales name the unavailable state. Tests reproduced the previous
false available/offered claims and the UI ignoring the availability field
before repair. Direct privacy, consent, retention and erasure tests remain.

## P2 privacy amendment — approved 2026-10-28

**Decision status: approved directly by David in the release coordinator's Codex
conversation on 2026-10-28: “Approve this privacy design”.** This approves the
P2.1–P2.5 policy below and permits implementation; production enablement and
qualification still follow the boundaries at the end of this amendment.
The user explicitly requested a privacy decision
covering masking, consent, retention, viewer roles and erasure before rebuilding
the archived recorder/player. Earlier accepted text remains historical context;
where this proposal changes it, the change is called out below.

### Source and existing owners

This review uses `origin/main` at `002e1ed1538b841fd739bf67ea6c969f54faada1`
and archive `archive/adr-0951-p2-replay-wip`, peeled commit
`999e0c9912825777fd5c1447fd3aed91ed74f79f`. The archive is reference material,
explicitly marked untested and not for merge. This is a source review, not runtime
qualification. No dependency installs, tests or browser runs accompanied this draft.

Architecture track A applies: this is an existing analytics feature and its
host-local privacy/access boundaries. It adds no OpenWOP protocol capability,
run-event field, or normative endpoint. No new RFC is proposed.

| Concern | Existing owner and seam to extend |
|---|---|
| Visitor decision | `consentService.ts`: strict category, visitor-only grant checks and `getStrictGrantGeneration` (the gate `putReplayChunk` uses). *`visitorReplayAllowed` was deleted by the P2 review, #6.* |
| Recording availability | `features/consent/consentService.ts`: `registerVisitorChoiceProvider`/`offeredVisitorChoices`, analytics settings in `features/analytics/routes.ts`, and existing tenant toggles |
| Index and private bytes | `features/analytics/replayStore.ts`: `DurableCollection('analytics:replay')`, reserved `REPLAY_BLOB_ROOT`, encoded tenant/org/session prefixes |
| Authorization | `host/accessControlService.ts`: existing `host:analytics:replay`, built-in owner/admin; reuse analytics' organization authorization helper |
| Retention and deletion | `registerDefaultWindowSweep`, `registerRetentionPurger`, `registerSubjectEraser`, `registerConsentWithdrawalHook`, and `registerTenantPurgeHook` |
| Viewing audit | Existing governance access decision and hash-chain services; no separate audit database |
| Page/form exclusion | Existing CMS, forms sensitivity, publishing and public-site mounting owners; no second consent banner or form model |

The current store supplies P0 privacy machinery, but does not offer recording.
Current source explicitly withholds the choice until a recorder registers it.
Custom roles cannot currently mint the host management scope; the earlier D4
correction remains authoritative. Do not broaden custom roles as an incidental P2
change. Organization teardown must be reviewed against the current owner and
any newly merged #5332 hooks before choosing the integration point.

### Findings that prevent reusing the archived implementation

| Severity / boundary | Source evidence | Required outcome |
|---|---|---|
| Critical: privacy serialization | Archived `site/replayRecorder.ts`, `keptAttrs`/`serializeMasked`, copies class values, arbitrary `data-owx-*`, style text and ancestor unmasking. A name allowlist alone does not make those values free of visitor data. | A closed, typed representation with validated values; no arbitrary DOM text, attributes or CSS bytes leave the browser. |
| Critical: playback egress | Archived `snapshotDocument` retains stylesheet URLs; `analytics/ReplayPanel.tsx` feeds stored `snap.html` to `srcDoc`. `sandbox=""` does not itself prohibit stylesheet/image/network requests. | Recorded content cannot cause network requests, navigation, script execution or access to the app origin. |
| High: withdrawal race | Archived `flush` checks consent before awaiting compression, then fetches without repeating that decision. A stop/withdrawal during compression can leave a send in flight. | Recheck the recording generation and current local decision immediately before sending; abort/drop queued work after withdrawal, with a fresh server-side decision on ingest. |
| High: concurrent storage | Current P0 `putReplayChunk` writes a deterministic blob key then unconditionally puts the session index. It is explicitly test-reachable infrastructure for future P2, not an atomic public admission protocol. | Immutable subject binding, idempotent sequence claims and atomic budget admission across instances before publishing a readable chunk. |
| High: erasure races | Current `deleteReplaySession` deletes blobs before the index; withdrawal-hook failures preserve the refusal but can leave bytes for retry. P2 would introduce concurrent writers and readers. | A durable denial/deletion state prevents reads and finalization while deletion retries; an ingest arriving during erasure cannot resurrect the session. |

These are source-supported design blockers. No production exploit or complete
browser reproduction is claimed. The archived review-blocker file named in its
commit message was unavailable at the recorded recovery path on this Mac; the
findings above come from the inspected source instead.

### Approved decisions

**P2.1 — Layout and interaction replay, with all visitor content masked.**

The initial recorder captures geometry, bounded pointer/scroll positions, timing
and a closed set of structural node types. All text and form values are replaced
before serialization. Passwords, payment details, one-time codes, health fields,
contenteditable areas, media, canvases, embedded documents and frames become
opaque placeholders. Text length need not be preserved precisely: use bounded
placeholder geometry so a masked value is not exposed through its character count.

**Change from D2:** `data-owx-unmask` will not enable content capture in P2. Raw
class/id/data attribute values, authored CSS, SVG payloads, stylesheet URLs,
query strings and fragments are excluded. Prefer stable opaque page/element IDs
and validated numeric/layout enums. Page labels must come from a permitted public
CMS identity, not a URL segment that may contain a person's identifier. Replay
fidelity will be lower than a page screenshot; the UI must say what is omitted.

Checkout, account, credential and health-form pages remain excluded. Proposed
operator policy: health/finance campaign categories are excluded from P2 replay
until a separately approved policy permits them. Do not infer safety from a
missing field label or a server regex scan.

The player constructs inert content from the validated representation; it never
renders arbitrary captured HTML. A sandboxed opaque-origin frame plus restrictive
content policy permits only the renderer's controlled local styles and denies
network loading, forms and navigation. The host validates decoded event types,
field lengths, nesting/depth and values before persistence and again at playback.
The existing server leak-pattern scan is defense in depth; it is not proof that
client capture was private. Recordings never go to an LLM, workflow blob surface,
public share link or content export in this phase.

**P2.2 — A separate visitor choice and a revocable recording generation.**

Replay remains off by default and requires the parent analytics toggle, replay
toggle, consent availability, durable blob storage and an installed, qualified
recorder. It has its own unchecked choice in every region; accepting aggregate
analytics does not grant replay. Only the visitor's existing public-consent lane
may grant it. No recorder import, DOM capture, replay identifier or replay request
precedes the recorded grant. No server error or missing decision falls back to yes.

Every ingest resolves tenant/org server-side and the subject from the validated
consent token. Client session IDs never authorize a subject change. A recording
generation is bound to that subject and purpose; withdrawal, erasure, token
invalidation or page exclusion stops listeners, clears buffers and invalidates
pending compression/retry work. Fresh consent starts a new recording generation.
The server refuses finalization for withdrawn or deletion-pending generations.
Consent withdrawal also revokes playback of prior recordings immediately.

**P2.3 — Bounded private storage and a fixed expiry.**

Keep the existing proposed budgets: 10% sampling of consented sessions, 2,000
sessions/day/org, 30 minutes and 5 MiB/session, 256 KiB compressed/chunk and 4 MiB
decoded/chunk. Also bound event count, node count, depth and processing cost.
The implementation must document exact byte units and enforce limits on both
compressed and decoded paths. These are ceilings, not promises to record every
eligible visit. A disabled or unentitled organization never gets a recorder.
Product plan entitlement remains an explicit configuration decision before rollout.

Index metadata stays in the existing durable collection; payloads stay under the
reserved host blob root. **Change from the P0 age check:** expiry is fixed from
session start, normally 30 days; an approved operator setting may shorten it and
may not exceed 90 days. Updating a chunk cannot extend expiry. Existing privacy
retention and legal-hold governance remains the owner; a hold must not silently
restore normal playback after withdrawal or erasure. Any conflicting deletion
decision is surfaced to the authorized governance operator rather than reported
as successfully erased.

No public GET or signed bearer URL bypasses the authorized playback route. Chunk
retries use a stable sequence plus digest: identical retry is idempotent, a
different payload for the same sequence is refused. Subject, session admission
and budget reservations must be durable and correct across Cloud Run instances;
in-memory locks or a list/count/write sequence are insufficient. Pending bytes
are unreadable until finalization; failed reservations and orphan blobs need
bounded recovery through existing retention/scheduling seams.

**P2.4 — Owner/admin viewers only, scoped and audited.**

Both list and playback require the existing `host:analytics:replay` permission
on the exact organization, with live membership and tenant checks. No cross-client
list, protocol-scope shortcut, public grant or custom viewer role is introduced.
Settings retain their existing admin authorization. A future delegated viewer role
needs its own approved change to the access-control owner.

The playback route rechecks access and deletion/expiry/consent state for each
content request. Revoked members cannot continue fetching chunks from a previously
opened player. Before releasing bytes, persist the existing access audit entry
with viewer, tenant/org, opaque session ID, action and timestamp; audit failure
refuses content. Do not log consent tokens, decoded content or URL payloads.
Audit retry/idempotency and audit-metadata retention need explicit contracts;
the analytics view must not become an audit-log discovery route.

**P2.5 — Deny access first, delete durably, prove completion.**

Withdrawal, subject erasure, tenant teardown and org deletion first fence new
ingest/finalization and playback, then delete blobs and finally retire index
metadata. A durable, minimal deletion receipt remains while any blob or index
operation needs retry. Consent failure must never revert a recorded refusal.
Toggling replay off stops capture/playback immediately and requests deletion of
the organization's recordings; this is an explicit change to the earlier D4
age-out-only behavior. Re-enabling cannot revive deleted or pending generations.

All writers must honor the same durable deletion fence. A second consent read
alone is not a cross-store transaction: the implementation design must show the
linearization point shared by consent invalidation and finalization, or a
fail-closed recovery protocol that never publishes bytes after invalidation.
This requires a separate architecture pass before exposing public ingest, even
after the privacy policy is approved. Existing P0 primitives are not assumed to
provide that protocol today.

Erasure covers both consent-subject and linked analytics-session keys, all chunks,
orphan prefixes, and every relevant blob version. Provider soft-delete/versioning
and backups must be inventoried before enabling replay; report their actual purge
windows. Do not promise immediate physical deletion from a backup. Recovery must
reapply erasure/deletion records before restoring replay access. Operational
failure stays visible as pending/failed; no success result while content remains.

### Required evidence before P2 can offer recording

1. Real DOM/network witnesses prove no import, capture or request before consent;
   poison text in values, attributes, CSS, SVG and URLs never appears in outgoing
   or persisted bytes. Include dynamic fields, nested exclusions and page changes.
2. Pause compression, withdraw consent, then resume: no send; race ingest and
   withdrawal/deletion across independent storage clients: no readable survivor
   or later resurrection. Re-grant cannot reopen the old generation.
3. Hostile stored events and forged HTML/CSS/URLs cannot execute, navigate, load
   remote resources, access parent storage or fetch same-origin credentials.
   Assert an actual request log in a real browser, not only sandbox attributes.
4. HTTP tests exercise wrong tenant/org, viewer revocation, custom-role/protocol
   scopes, malformed/tokenless requests, audit-write failure and expired sessions.
   Public refusal responses do not reveal another visitor's consent or settings.
5. Concurrent last-slot admission, duplicate sequence with differing digests,
   partial blob writes, index failures and interrupted deletion demonstrate bounded
   budgets and durable retry. Include real persistence; mocks alone are insufficient.
6. Retention, withdrawal, subject erasure and org/tenant teardown remove index and
   bytes under injected failures. Verify scheduled retry and backup/soft-delete
   behavior with the configured backend before rollout.
7. Canonical full gate and required browser checks pass on the final integrated
   tree in a scheduled slot. Removing each privacy boundary makes its witness red.
   No gate or browser qualification has been run for this document-only proposal.

### Approval and implementation boundary

- [x] David approved P2.1–P2.5 directly on 2026-10-28, including no unmasking, separate opt-in, fixed
  30-day default/90-day maximum, owner/admin viewers, exclusion of health/finance
  campaigns, and deletion on withdrawal or disable.
- [ ] Product plan entitlement and blob/backups retention are specified before
  enabling the recorder for an organization.
- [ ] The concurrency/fencing and inert-renderer designs pass architecture review;
  any missing shared primitive is added through its existing owner.
- [ ] Rebuild from current main and qualify the complete contract; retain the
  archive tag until its replacement has merged.

Approval of this document permits implementation planning and code work under the
approved policy. It does not enable production recording, add a delegated viewer
role, change another project's production, or waive any release gate.

### P2 implementation architecture audit — 2026-10-28

Track A applies: this is a host feature extending analytics, consent, access
control and durable storage. It adds no OpenWOP wire contract. The source audit
below is a design review; it is not a passing implementation or runtime check.

The existing extension owners remain authoritative: analytics owns the private
replay index and reserved blob root; consent owns visitor grants, withdrawal and
erasure tombstones; access control owns exact-org viewer membership; retention
owns sweeps and holds. `registerAllRoutes` installs core modules before feature
routes. The existing replay surface offers settings only; there is no current
public replay-ingest or playback route to duplicate.

Three existing primitives need correction before they can support P2 (the
implementation checkpoints below record progress without replacing this audit):

1. **Critical, revocation concurrency.** `consentService.ts` runs withdrawal
   hooks after recording refusal, logs hook errors and returns. Its normal
   category merge uses CAS, but after five conflicts falls back to a blind
   latest-wins put. `replayStore.ts` separately writes the blob then blindly
   writes the index. Those paths do not serialize finalization with withdrawal
   and can leave an unindexed late blob after a completed sweep. They must not
   be exposed as public ingest unchanged.
2. **High, expiry and erasure.** Replay retention currently uses `updatedAt`,
   so a later chunk extends the window. Deletion starts with blob removal and
   only then removes the index, with no durable unreadable state. Fixed expiry,
   a durable deletion receipt and authorization checks against revocation are
   required even when storage deletion fails.
3. **High, renderer input.** The archive copies authored DOM/CSS attributes.
   P2 requires a closed representation of bounded geometry and enums, validated
   before storage and rendering; existing DOM serialization is not reusable.

The selected implementation direction is a consent-owned recording generation,
bound to an explicit replay grant revision. A strict-purpose write must never
fall back to a blind update that can carry an older grant over a refusal. A new
affirmative grant creates a fresh generation; recordings from a prior generation
never become readable again. Playback checks the live grant generation and
deletion/expiry state on every content request, then persists the access audit
before releasing bytes. An index marked ready alone is never authority to read.

`DurableCollection.compareAndSwap` is a real cross-instance atomic operation on
one entity, not a transaction across consent, session and blob records. The
implementation must therefore retain durable reservations/deletion receipts
before starting any blob write, fence visibility through the consent-owned
generation, and sweep late/orphan writes until every reservation is settled.
The exact retry, finalization and toggle-disable interleavings still require
executable witnesses through independent storage clients. Do not label this
direction qualified until those witnesses fail under deliberate fence removal.

Implementation proceeds through the existing owners: strict consent generation
and durable cleanup first, then the closed event contract and inert renderer,
then scoped HTTP ingest/playback and visitor capture. Public recording remains
unoffered until the complete privacy and concurrency evidence above passes.

### P2.3 retention correction checkpoint — 2026-10-28

After the direct privacy approval, the existing default sweep and governance
purger were changed to age sessions from `startedAt`, rather than `updatedAt`.
Two witnesses first failed against the old implementation: a 31-day session
with a recent chunk escaped the default sweep, and an 8-day session with a recent
chunk escaped a stricter 7-day governance window. Both now delete the old index
and blobs while preserving the corresponding younger control. Existing fixtures
now give old sessions a matching old start time instead of an impossible update
before their start.

Real npm 10.9.8 installs completed in root, backend and frontend under Node 22.
All 26 replay-privacy cases and the backend typecheck pass. Original failures
and subsequent results are retained as `privacy0951-retention-r0.log`,
`privacy0951-retention-r1.log` and `privacy0951-typecheck-r0.log` in the
coordinator state directory. No full gate has run for this checkpoint.

This repairs the retention consumers only. The P2 admission protocol still
needs to establish immutable, server-owned start times, consent generations,
deletion fences and durable recovery before public capture or playback exists.
The store's current test-reachable writer is not certified for public ingest.
Recording remains unoffered; this checkpoint does not claim P2 complete.

### P2 consent generation checkpoint — 2026-10-28

The existing consent owner now stores a random grant generation for each strict
optional purpose, plus a decision revision that survives withdrawal. Only an
explicit visitor affirmation can mint a missing generation. Unrelated edits
preserve it; withdrawal removes it; re-grant creates a different one. Legacy
boolean grants acquire no recording generation until the visitor affirms again.
Both fields travel with the existing consent history in the same atomic write.

**Correction to the earlier latest-wins path:** both replacement and partial
writes now use bounded CAS. Five collisions return an explicit 409 conflict;
there is no blind overwrite fallback. Every retry checks visitor authority.
A public affirmation also retains the strict-purpose decision revision it first
read: a later refusal stops that older in-flight request, even if a concurrent
refused → granted → refused sequence ends at the same boolean. A fresh visitor
choice after the refusal can still grant. This prevents restoring an old grant
while preserving unrelated updates and the existing purpose-vocabulary rules.

Two independent connections to a real SQLite file witnessed the original stale
wholesale overwrite and retries-exhausted overwrite, plus missing generation
identity (four red cases in `privacy0951-consent-r0.log`). Three further public
affirmation/withdrawal cases failed before the decision-revision fence
(`privacy0951-consent-r2.log`). All seven now pass, alongside the existing privacy,
consent history/channel and erasure suites: 61 cases in five files, 15.59 seconds
(`privacy0951-consent-r4.log`), and backend typecheck passes. Original failure logs
are retained; one intermediate run also exposed error-check ordering, corrected
so an operator's unauthorized grant retains its existing validation response.

This checkpoint establishes consent identity and write ordering only. Public
recording remains unavailable. Ingest/playback must consume the live generation;
durable chunk reservations, deletion retry/fences, fixed timestamp admission,
closed recorder representation, inert playback and browser/full-gate
qualification remain required before P2 is offered.


### P2.5 erasure witness preparation — 2026-10-28

Three storage-boundary cases now specify the next privacy checkpoint: failed blob
deletion hides the session from a second SQLite connection while preserving the
retry path; a second writer cannot reuse an erased session ID; and erasure during
the first delayed blob write prevents finalization and removes the late bytes.
They use real SQLite and the existing memory blob adapter, injecting only the
I/O failure or ordering at the adapter boundary. A separate subject is a positive
control. The first execution failed in fixture setup because it had not called
`initInMemorySurfaces`; that setup failure was not a privacy witness. After adding
the existing initializer, all three assertions fail against the P0 store:
failed physical deletion returns a readable row, an erased identity accepts a new
chunk, and a first write paused at the blob adapter finalizes after erasure.
The single-file run completed in 2.25 seconds on 2026-10-28 at 07:58Z, one worker,
while release Train 259 was in shell selftests with normal memory pressure.
Evidence: `privacy0951-erasure-red-r1.log` in the coordinator scratchpad. This is
RED-before evidence, not a passing store or permission to expose recording.

The P0 blob-first write / blob-first deletion implementation has no durable
reservation or unreadable tombstone. The existing P0 test that keeps a failed
row readable must change as an explicit P2.5 contract correction, preserving its
retry evidence. Implement through the current replay owner, DurableCollection
CAS, consent generations and retention recovery; do not add another public route
or an independent consent store. Public ingest remains unavailable until the
cross-store protocol and its failure witnesses are qualified.


#### Erasure implementation constraint discovered from the delayed-write witness

A reservation must exist in the current replay owner's durable collection before
any blob write begins, so erasure can discover an in-flight first chunk. A CAS
must make the session unreadable and deny finalization before physical deletion.
An erased identity must retain a minimal non-content fence; deleting the only row
would permit identity reuse. Subject, page and flag metadata cannot become a
permanent deletion receipt after erasure completes.

A writer that has not acknowledged its outcome is a separate completion hazard:
listing an empty prefix while its put is still pending does not establish physical
erasure. Keep a durable pending receipt and report the unresolved operation; do
not claim success merely because a live writer's catch block normally cleans up.
Crash recovery must retry hidden pending prefixes and preserve that receipt until
all reserved writes are known settled. The existing blob API provides no generic
cross-store atomic transaction or cancellation proof. Public ingest still needs
consent-generation admission/finalization, provider version/backup inventory, and
bounded recovery qualification; these three store witnesses alone are insufficient.

### P2.5 durable erasure checkpoint — 2026-10-28

The existing `analytics:replay` collection now records a pending write before
touching blob storage. Its compare-and-swap transition to `erasing` hides reads
across clients and refuses new writes or late finalization. Failed deletion
retains a hidden retry record; completion leaves only tenant, org and session
identity plus the erased state, removing subject, page and visit metadata.
Retention and subject erasure include hidden records. A pending write prevents
an erasure-success claim even when the blob prefix is temporarily empty.

The three original real-SQLite/memory-adapter failures now pass. The P0 test that
expected a failed erasure to remain readable was explicitly corrected: it now
requires unreadability while preserving the backend-restoration/retry check.
The delayed-write witness now requires an erasure error until the write settles;
an empty prefix was never sufficient evidence of completion. A fourth witness
injects a lost acknowledgement after the real SQLite finalization commits and
requires the committed chunk to survive. Disabling that recovery makes it fail.

Focused verification: 30 tests in two files passed in 11.45 seconds; the fourth
witness's negative control failed in 2.17 seconds and source bytes were restored.
Backend typechecking passed before the fourth witness was added; its final check
is recorded separately in the coordinator evidence packet. No full gate or
production qualification is claimed here.

A crashed writer or an unknown reservation outcome still leaves a durable
unsettled receipt. This checkpoint deliberately does not expire that receipt:
the generic blob interface cannot prove a remote write will never finish.
Provider-specific settlement and recovery, consent-generation checks at ingest
and finalization, browser capture/playback, and full-gate qualification remain
required. Public recording is still unavailable.


### P2.5 unknown provider completion correction — 2026-10-28

**Correction to the durable erasure checkpoint:** retaining receipts only for a
crashed writer was insufficient. A rejected or malformed blob PUT response can
also leave a request executing at the provider. An acknowledged DELETE or empty
prefix can precede that PUT's completion. The previous catch path deleted visible
bytes and then cleared the reservation, allowing erasure to report completion
and forget a later orphan write.

The store now requires explicit `ok: true` acknowledgements for writes and
deletes. It clears a failed-finalization reservation only when the PUT itself was
acknowledged before cleanup. A lost/unknown PUT response retains its reservation
even after cleanup; retries stay hidden and the eraser continues to sweep visible
bytes without claiming physical completion. This is deliberately conservative:
provider-specific operation settlement, version/backup inventory and bounded
recovery are still required before public recording can be offered.

Three new tests first failed: lost PUT response followed by an empty-prefix
erasure, missing PUT acknowledgement publishing a readable index, and missing
DELETE acknowledgement forgetting live bytes. After correction, all 33 cases in
the erasure/privacy pair pass. They use two actual SQLite connections and a real
memory blob adapter with injected response/order faults. The lost-response test
then completes the remote write and proves the retry removes the late bytes while
retaining the still-unsettled receipt. This is storage-boundary evidence, not live
GCS/S3 settlement or full P2 qualification; public capture remains unavailable.

### P2.1 event representation preparation — 2026-10-28

`features/analytics/replayEvents.ts` defines the feature-owned version-1 private
geometry format. This is host recording data, not an OpenWOP wire change. It
introduces no route, storage authority, recorder activation or playback permission.
The existing analytics feature remains its owner; consent, admission, erasure,
access control and audit decisions stay with their existing owners. The frontend
must not import this backend module.

Each chunk begins with an independent frame: a document rectangle, viewport size
and an ordered tree of numeric node IDs. The two node kinds are structural boxes
and opaque 64-by-16 placeholders. Parents precede children; placeholders have no
children. Node rectangles stay inside the document, pointer coordinates inside
the viewport, and scroll offsets inside the document's scroll range. Positions
and extents use an 8-pixel grid and timestamps a 10-millisecond grid. No page URL,
text, attribute, CSS, HTML, arbitrary event name or string-valued identifier is
accepted. Unknown fields fail rather than being silently persisted.

Bounds are 262,144 compressed bytes, 4,194,304 decoded bytes, 2,000 events,
2,000 nodes per frame, 10,000 nodes per chunk, depth 32 and a 1,800,000-millisecond
time range. The gzip entry point limits expansion inside zlib, then checks UTF-8
and the closed representation. Callers must persist the validated result rather
than the input bytes, and must separately enforce per-session budgets and current
consent. A syntactically valid geometry payload does not prove the recorder
excluded sensitive elements; DOM/network witnesses remain required.

The source and adversarial tests are prepared but **not yet executed or
typechecked**. Validation is queued behind the active full gate on this Mac.
No parser, browser or complete P2 qualification is claimed at this checkpoint.

**Evidence correction (2026-10-28):** the first compressed-expansion test used
only whitespace and asserted the outer format error. It could pass without the
zlib allocation bound because the later decoded-size or JSON guard also rejects
that input. The prepared replacement uses a valid recording padded with legal
JSON whitespace: the exact decoded limit must round-trip, while one byte over
must throw inside real zlib. A transparent call-through spy distinguishes that
refusal from a later parser rejection. Removing `maxOutputLength` is the planned
negative control. These revised tests are still unrun while train265 owns this
Mac's test window; this is a stronger witness design, not a passing result.

**Focused qualification, 2026-10-28 14:17Z:** after train265 completed, all 19
event-format cases passed on source commit `366b70b0e`. Removing only zlib's
`maxOutputLength` made the inflation witness fail because real zlib returned
instead of throwing; the other 18 cases were deliberately unselected for that
negative control. Restoring the bound returned all 19 cases to green. The source
was restored byte-for-byte. Logs and machine-readable reports are retained in
the coordinator's `privacy0951-events-verification.json` evidence packet. This
qualifies the parser cases, not DOM capture, admission, playback or the full P2
feature. Backend typecheck and the complete gate remain outstanding.

### P2.3 chunk reservation preparation — 2026-10-28

The private replay store now prepares immutable sequence receipts alongside its
existing write/erasure reservations. A receipt binds SHA-256 and actual stored
bytes; a committed identical retry does not PUT again, alter metadata or consume
more capacity, and a different payload at the same sequence refuses. Both pending
and committed bytes count toward 5 MiB (5 × 1,024² bytes) in the same per-session
CAS. Each chunk is at most 256 KiB; sequence indices are limited to 0–2,047 so the
receipt map has a fixed ceiling. This is an additional conservative processing
bound, not a promise to collect that many chunks. Base64 is bounded before decode
and must round-trip canonically; the separate event parser bounds inflated JSON.
Finalization derives byte/chunk counters from the receipts rather than accepting
caller counters. Erasure keeps the receipts until its opaque final fence, and
legacy recordings without sequence evidence cannot be reopened for writes.

The new SQLite witnesses are **prepared, not executed** while client-report
preflight266 owns the local gate. They exercise unchanged retries, conflicting
bytes, supplied-counter rejection, out-of-order finalization, a pending last-slot
write visible through a second SQLite connection, finalized capacity, malformed
and oversized chunks, and legacy-row refusal. Before accepting this checkpoint,
run these plus the existing erasure/consent/parser witnesses; deliberately remove
the pending-byte charge and the changed-digest refusal one at a time and require
RED, then restore exact source and rerun. Backend typecheck and full CI remain owed.

This does not establish consent-generation admission, the 2,000 sessions/day/org
limit, sampling, immutable server timestamps, provider settlement or authorized
playback. It adds no public route or visitor choice; recording remains unoffered.




Chunk reservation qualification at the preceding `0e5e94ead` checkpoint completed
2026-10-28 17:25Z: real npm 10.9.8 installs in all three packages; five suites,
73 passing cases including all 14 chunk-budget witnesses; removing the pending
byte charge and committed-digest check separately produced one expected failure
each; restored source passed all 73; native backend typecheck exited zero. Owned
process cleanup was verified empty. Evidence: `privacy0951-chunks-verification.json`
in the release coordinator state directory. That evidence applies to `0e5e94ead`,
not to the later server-clock changes below; it is not a full CI verdict.

### P2.3 server-owned clock preparation — 2026-10-28

The first successful durable chunk reservation establishes `startedAt` from the
host's UTC clock. The incoming session object's timestamps are not authority.
Every subsequent reservation/finalization preserves that start, including a PUT
that finishes after a later sequence. Finalization stamps `updatedAt` from the
host clock, floored at the persisted value if the clock moves backwards. An
identical retry changes neither clock. Retention continues to use `startedAt`;
legacy rows remain readable/erasable but cannot accept new writes without the
immutable receipts introduced above. No database migration is needed.

Metadata ordering must also stop depending on caller timestamps. The highest
committed sequence supplies the session metadata snapshot; a delayed lower
sequence still contributes its bytes/receipt without replacing that snapshot.
This assumes the future admission layer validates cumulative metadata and sequence
ownership. It does not authorize trusting arbitrary page IDs, flags or duration
at a public boundary. The host clock is the time authority; this change does not
claim to correct a misconfigured host clock or establish the separate 30-minute
admission/session limit.

Architectural boundary: this stays inside the existing private replay collection
and its CAS reservation/finalization owner. It adds no protocol capability, public
route, grant, viewer role or provider adapter. The two-connection SQLite witnesses
are prepared to reject future/past caller clocks, preserve the first reservation
across delayed/out-of-order completion, keep clocks stable on retry/rollback, and
erase the actual blobs after the fixed window. Existing retention fixtures will
advance only the server Date clock when creating historical sessions, with recent
chunks submitted at the later server time. No assertions or retention windows are
relaxed. These changes are **not yet executed or qualified** while Train268 R2
owns this Mac's gate; focused negative controls, typecheck and full CI remain owed.


Server-clock qualification at `5993e045b` completed 2026-10-28 17:52Z. Five
backend suites passed all 78 cases, including all 19 chunk/clock witnesses.
Separate controls that trusted the caller at initial reservation, replaced the
retention start during finalization, ordered metadata by caller time, or allowed
the update clock to move backwards each failed the intended assertion once.
Restoring the exact source passed all 78 again; native backend typecheck exited
zero, the source digest matched and task-owned cleanup was empty. The retained
`privacy0951-clock-verification.json` binds these results to the tested head/tree.
This qualifies the private store's clock behavior on SQLite and the local blob
adapter. It is not a full gate, provider qualification, public admission or P2
completion. The separate consent-generation boundary and remaining rollout
requirements above still apply.

### P2.2 consent visibility/finalization preparation — 2026-10-28

Architecture track A: this extends the existing consent and analytics owners;
there is no new route, storage system or wire contract. The source audit found
that replay reads still trusted an index row after a failed withdrawal callback.
That callback runs after the authoritative refusal and cannot be the read fence.

`consentService.getStrictGrantGeneration` reads the current explicit generation
on both sides of the existing subject and linked-session erasure checks. A
withdrawal/re-grant changes the generation; a legacy boolean has none. Storage
errors propagate. This helper is an observation of the consent owner, not a
cross-row transaction or a bearer token, and it is never returned to a visitor.

The private replay store pins that generation in its durable reservation. Later
chunks must retain it; a new grant requires a new recording identity. Reads and
list results consult the live generation even when physical cleanup failed.
Legacy recordings without a pinned generation remain available to erasure but
cannot be read or adopted by a new grant.

The write protocol rechecks after reservation and before the first blob PUT,
before finalization, and after the replay CAS. This addresses a withdrawal scan
that finished before the first reservation appeared, and a refusal between the
last consent check and replay CAS. The replay CAS itself can still commit in
that interval: **the committed bit does not publish content**. Independent live
generation checks deny reads, and the post-check refuses success and fences/
deletes known completed writes. A lost finalization acknowledgement may only be
recognized as success while the same consent generation is still current. A
confirmed refusal is distinguished from a storage outage; an outage must not
delete otherwise acknowledged content. Unknown provider PUT outcomes retain
their existing durable pending receipts.

The prepared two-client SQLite witnesses cover missing/legacy grants, failed
withdrawal cleanup and re-grant, the empty-scan/reservation race, consent changes
during reads, legacy recordings, finalization races, lost acknowledgements,
both erasure identities, and consent-store failure. Existing storage fixtures
now create an explicit visitor grant before recording; they do not bypass the
new boundary. Qualification must run the original store against these witnesses,
remove individual guards, restore the exact source, and run all privacy suites
plus typecheck when the client-report gate releases this Mac.

**Prepared, not executed at this checkpoint.** This is not complete public
admission or physical-erasure qualification. A crashed writer or failed callback
still needs bounded reconciliation of revoked-generation rows; provider
settlement, organization-disable generations, expiry checks on playback,
per-org admission budgets, authorized/audited byte release and browser capture
remain required before recording can be offered. A future playback route must
recheck after fetching bytes and before responding; an earlier index lookup is
not permission for a later fetch. No public replay choice or ingest was added.

### P2.2 qualification and revoked-generation reconciliation — 2026-10-28

**Fence qualification (d3, `6a15e9082`).** `de39cd21` did not qualify as handed
over: its six-suite candidate run was 88 passed / 1 failed, because a chunk-budget
witness read a legacy row through `getReplaySession`, which the new fence hides.
That assertion was stale, not the product; `6a15e9082` asserts the raw row is
byte-identical and the fenced reader returns null. At `6a15e9082` the prepared
qualification (run from a rebound copy) gave: old source 11 behavioural reds,
candidate 89/89, eight guard-removal controls each red on its named witness,
restored 89/89, backend typecheck 0. The prepared script's literal
`'AssertionError'` check was widened to accept vitest `.rejects` failures while
still rejecting TypeError/ReferenceError/SyntaxError/missing-module errors.

**Reconciliation.** `sweepExpiredReplays` (the default-window sweep, already a
censused `asserts` lane) now also deletes recordings whose pinned consent
generation is no longer current — the bytes a failed withdrawal callback or a
crashed writer left behind — without waiting for the retention window.

- Bounded: a rotating window of `REPLAY_RECONCILE_MAX_PER_SWEEP` (200) rows per
  sweep, one generation read per subject.
- Only a confirmed mismatch deletes. A consent-store error logs
  `replay_reconcile_consent_unavailable` and leaves the row for a later sweep.
- Legal holds retain the row, which stays unreadable through the read fence.
- Legacy rows without a pinned generation stay with the retention window.
- A revoked row with an unsettled pending write is fenced and its visible bytes
  deleted; its erasure completes once provider settlement lands (next item).

Witnesses: `test/adr0951-p2-revoked-reconcile.test.ts` (6 cases, two SQLite
clients). Removing the reconciliation, deleting on a consent-read error,
ignoring the hold, removing the window bound, or dropping the per-subject read
each turned the intended witness red, and the restored source passed.
Remaining: provider unknown-PUT settlement, org-disable generations, admission
budgets, expiry/access/audit before byte release, masked capture and viewer,
full gate and review. Recording is still not offered.

### P2.5 unknown-PUT settlement — 2026-10-28

A replay chunk upload whose outcome is unknown keeps a durable receipt (P2.5
above), and until now nothing could ever clear one: erasure of that recording
failed forever, and a live recording kept the receipt's bytes against its
session budget and its 32-receipt cap.

- **A real bound on the upload.** `putReplayChunk` passes
  `AbortSignal.timeout(REPLAY_PUT_DEADLINE_MS)` (60 s) to the blob `put`. The GCS
  and S3 adapters forward it to the upload request, so a stalled upload is
  aborted rather than left to land later. A crashed process takes its
  connection with it.
- **Receipts carry host time.** New receipts record `reservedAt`. A receipt
  from before this change has none; the first settlement pass stamps
  `observedAt` and waits a full window from that.
- **Settlement.** After `REPLAY_SETTLE_AFTER_MS` (10 min: the deadline plus
  provider commit lag and clock skew between instances) the upload can no
  longer land. Settlement deletes the chunk key it targeted, then drops the
  receipt by CAS. Erasure settles before it reports "awaits unsettled blob
  writes", and the default-window sweep settles live recordings (bounded per
  sweep) so their capacity returns.
- **Only where the bound is real.** `gcs`, `s3` and `memory` enforce the
  deadline. Any other blob backend keeps its receipts and erasure keeps
  reporting them: an honest open item, not a silent clear.

Witnesses: `test/adr0951-p2-put-settlement.test.ts` (6 cases, two SQLite
clients, real memory-blob bytes) plus one forwarding case each in
`adr0867-gcs-blob.test.ts` and `s3-blob.test.ts`. Controls, each red on the
intended case then restored: no deadline; settling regardless of age; settling
on any backend; treating an unstamped receipt as already due; skipping the blob
delete; dropping the sweep's settlement; and each adapter not forwarding the
signal. Remaining: org-disable generations, admission budgets,
expiry/access/audit before byte release, masked capture and viewer, full gate
and review. Recording is still not offered.

### P2.5 replay disable: fence at once, delete, never revive — 2026-10-28

David's decision: deletion on withdrawal **or disable**. Before this, turning
`analytics.session-replay` (or `analytics`) off fenced nothing: recordings stayed
readable and writable until they aged out, and turning it back on would have
served them again.

- **Epoch.** `analytics:replay-enablement` holds one row per tenant
  `{epoch, disabled}`. When replay is observed OFF the row gets a fresh epoch.
  Every reservation pins the tenant's current epoch. A recording is readable or
  writable only while replay resolves ON **and** its pinned epoch is current
  (`fencesHold`, checked beside the consent generation at every read, every
  write boundary and the lost-acknowledgement path). Re-enabling keeps the
  epoch set at the disable, so earlier recordings stay fenced.
> **Corrected 2026-10-30 (P2 architecture review #1).** The listener below
> re-read LIVE state, so a late, crashed or out-raced listener lost the OFF.
> The seam now carries the write itself and a pre-write intent; see "P2
> architecture review fixes". The rest of this section stands.

- **The gate is the live check, not a listener.** The ISWF-8 lesson ("a listener
  is a side effect, not a gate") holds: reads and writes re-resolve the toggles
  themselves, under every narrowing (cohort, tenant override, kill). A listener
  is still needed for one case only: OFF then ON with no read in between would
  otherwise never record the OFF. So the toggle write seam ADR 0734 removed is
  restored, as its note prescribed, **whole** and wider than before: it fires
  after every stored write (save, delete, retire, tenant enable/disable, tenant
  purge) with the tenant on tenant-scoped writes, passes no before/after
  verdict, and a failing listener is logged without failing the toggle write.
  The sweep re-observes every tenant with recordings, so a missed notification
  costs at most one sweep interval.
- **Deletion.** The default-window sweep deletes recordings whose epoch is not
  current (same hold rules as consent reconciliation: a legal hold retains them,
  unreadable).
- **Outage is not OFF.** A toggle read error, an unregistered toggle or
  unconfigured storage is `unknown`: recordings are unreadable for that request,
  but no epoch moves and nothing is deleted.
- Residue: a code-default change shipped by a deploy is observed by the next read
  or sweep, not by the seam (defaults are not stored writes).

Witnesses: `test/adr0951-p2-disable-fence.test.ts` (6 cases: immediate fence,
no revival, sweep deletion, per-tenant override isolation, missed notification
caught by the sweep, toggle outage deletes nothing) and
`test/feature-toggle-write-listener.test.ts` (every write path fires with the
tenant; no-op writes do not; a failing listener does not fail the write). The
replay store suites now turn both toggles on through `test/helpers/replayToggles.ts`
(the real toggle service). Controls, each red on the intended case then restored:
listener body disabled; epoch ignored (state only); toggle error read as OFF;
sweep deletion removed; reservation not pinning the epoch; and in the toggle
service, each of disable/purge/retire not notifying, tenant not passed, and a
listener error propagating. Related suites 235/235, tsc 0.
Remaining: admission budgets, expiry/access/audit before byte release, masked
capture and viewer, full gate and review. Recording is still not offered.

**Why restoring the ADR 0734 seam is safe now (review note, 2026-10-28).**
ADR 0734 deleted `ToggleStatusListener` whole because it had no registrant and
was unsound as a gate (ISWF-8: it fired only on a global `status` change, so
`on → beta`, a narrowed cohort and a tenant override escaped it). The restored
`ToggleWriteListener` differs on each count: (1) it is not a gate: replay's
reads and writes re-resolve the toggles themselves under every narrowing, and
the listener only records an OFF that no read observed; (2) it fires on every
stored write, tenant writes included, and passes no verdict to misread;
(3) failures are logged and never fail the write; (4) each listener gets at
most `TOGGLE_WRITE_LISTENER_BUDGET_MS` (2 s) of the write's latency, after which
the write returns and the listener finishes on its own, so a slow listener
cannot wedge an admin save or the account-deletion `purgeTenantOverrides`;
(5) listeners run in registration order and are independent (none reads
another's effect); (6) its only registrant is `analytics-replay`, and the sweep
backstops a missed or late notification. Budget witness: the write returns at
the budget while the listener is still pending (red when the wait is unbounded).
An `/architect` pass on this seam is owed before the P2 PR merges.

### P2.3 admission budgets — 2026-10-28

The approved ceilings now hold before any byte is stored:

- **Sample.** A new session is admitted only if a deterministic SHA-256 of
  (tenant, org, consented subject, session) falls in `REPLAY_SAMPLE_PERCENT`
  (10). A retried first chunk gets the same answer. An unsampled visit stores
  nothing, writes no row and is not counted (409 `not_sampled`). The operator may
  set `OPENWOP_REPLAY_SAMPLE_PERCENT` (integer 0–100; anything else is 10):
  sampling changes how many consented visits are kept, never who may be
  recorded. A client choosing session ids can shift which of its visits are
  sampled, so the sample is a cost control; the daily ceiling is the hard bound.
- **Daily ceiling.** `analytics:replay-admission` keeps one counter per
  (tenant, client org, UTC day), incremented by CAS before a new session's first
  reservation, so `REPLAY_MAX_SESSIONS_PER_ORG_DAY` (2,000) holds across
  instances. A reservation that then fails leaves the count high, never low.
  Over the ceiling: 429 `daily_limit`, nothing stored. Later chunks of an
  admitted session are never counted again. The sweep drops counters older
  than two days.
- **Session length.** A chunk more than `REPLAY_MAX_SESSION_MS` (30 min) after
  the server-recorded start is refused (409 `session_length`); a client clock
  cannot extend it. The 5 MiB / 2,048-chunk / 256 KiB ceilings (above) stand.

Three retention witnesses wrote a second chunk days after the start to prove a
late chunk cannot extend retention; the session limit now refuses that chunk.
They now write it 20 minutes in, with the start 10 minutes past the cutoff, so
a window keyed on `updatedAt` would still keep the row: re-sabotaged (retention
keyed on `updatedAt`), all three go red.

Witnesses: `test/adr0951-p2-admission.test.ts` (5 cases). Controls, each red on
the intended case then restored: no sampling; a blind counter write instead of
CAS (racing sessions pass the ceiling); counting every chunk; no session limit;
the limit measured from the client's start; a non-integer or out-of-range sample
accepted. Related suites 241/241, tsc 0. Remaining: expiry/access/audit before
byte release, masked capture and viewer, full gate and review. Recording is
still not offered.

### P2.4 audited playback read path — 2026-10-28

`readReplayChunkForViewer` is the one function a future playback route may call
to release recording bytes. There is still no route or viewer; this is the
store-side contract they will sit on.

1. The viewer must hold `host:analytics:replay` on the **exact** org
   (`assertOrgScope`: live membership, built-in owner/admin only). No viewer: 401.
2. The recording must be visible (committed, not erasing, consent generation
   and disable epoch current) and inside its fixed expiry from the server start.
   Missing, fenced, expired and uncommitted all answer the same 404.
3. The view `{orgId, sessionId, chunkIndex, viewer, at}` is appended to the
   tenant's hash chain (`auditChainService`, kind `analytics.replay.viewed`)
   **before any byte is read**. If the append fails, the content is refused
   (503). The `governance.decision.access` row is also written, best effort as
   that log always is; the chain is the record that gates release.
4. The bytes must match the receipt's size and SHA-256, or nothing is released.
5. Authorization and visibility are checked again after the fetch, so a
   demotion, withdrawal or disable that lands while bytes are in flight wins.

Witnesses: `test/adr0951-p2-playback.test.ts` (6 cases, real orgs and
memberships, the real audit chain, two-stage fetch faults). Controls, each red on
the intended case then restored: no authorization; no visibility check; no
expiry; audit best effort; audit after the bytes; no post-fetch authorization;
no post-fetch visibility (its witness first passed for the wrong reason, because
the withdrawal hook deleted the bytes; it now fails the hook so only the re-check
can refuse); no digest check. Related suites 275/275, tsc 0.
Remaining: masked capture, the ingest and playback routes, the viewer, full gate
and review (with the owed `/architect` pass on the toggle write seam). Recording
is still not offered.

### P2 replay HTTP lanes — 2026-10-28

- **Upload** `POST /host/openwop-app/public-analytics/:orgId/replay/:sessionId/chunk`
  (public prefix, org-derived tenant, the per-org beacon budget). Body
  `{index, content, consentToken, sessionKey?, automation?}`; `content` is the
  base64 gzip chunk. The server decodes it through the closed P2.1 format and
  stores **only the re-encoded validated result**, never the client's bytes.
  A malformed chunk is a 400 that never echoes its content. Every other
  refusal (replay off, no consent token, no explicit grant, bot, not sampled,
  daily limit, session length, writes fenced) is the same `202 {recorded:false}`:
  the recorder stops and the lane says nothing about why. The subject is the
  consent token's `visitor:` subject, the key the strict grant is recorded under.
  D2's server-side PII pattern scan is moot for this format: it carries no string
  at all, so there is nothing for a card, email or phone pattern to match.
- **Playback** `GET /host/openwop-app/analytics/orgs/:orgId/replay/sessions`
  (no visitor identifier in the list) and `…/replay/sessions/:sessionId/chunks/:index`
  (the audited `readReplayChunkForViewer`, re-validated on the way out). Both
  require `host:analytics:replay` on the exact org, `no-store`.

Witnesses: `test/adr0951-p2-replay-routes.test.ts` (4 cases through the real app
and a real public-consent token, in a shared workspace so membership roles apply:
an editor member gets 403 on both reads). A first draft used a personal-workspace
tenant, where every test-signed-in user is the implicit owner, so the editor
case passed for the wrong reason; it was caught by the weak-scope control and
fixed. Controls, each red on the intended case then restored: storing the
client's bytes; skipping the format check; no bot check; refusal reasons leaking
as errors; the list gated on `workspace:read`. Analytics, replay and route census
suites 258/258. The replay choice is still not offered on the public consent
lane or the banner, so nothing can record yet.

### P2 recorder and viewer — 2026-10-28

**Recorder** (`frontend/react/src/features/site/replayCapture.ts`). D2 named rrweb
with masking options; the P2.1 contract supersedes that. The recorder serializes
**geometry only** and never reads text, values or attribute contents: layout
becomes boxes, and each text run, form control, image, media element, SVG,
frame and contenteditable becomes one fixed 64×16 placeholder (its subtree is
never visited). Everything is snapped to the 8 px / 10 ms grids and kept inside
the P2.1 limits. It loads by dynamic import from `FrontPage` only on an explicit,
server-recorded yes to `analytics.replay` (`replayAllowedFor`), never runs on a
page with a password, card, one-time-code or `data-owx-sensitivity` field or a
`data-owx-replay="off"` marker (checkout and account pages are not CMS pages),
re-reads the choice before every send, and stops for the visit on any
`recorded:false`. The 10-second chunks are gzipped with `CompressionStream`; a
browser without it records nothing.

**Viewer** (`ReplayPanel.tsx`, lazy, on the Analytics page). It renders only for
callers whose effective access on **this** org includes `host:analytics:replay`
with replay on, so other members never call the endpoint (a 403 from the plain
analytics client would otherwise be read as a plan refusal). It uses its own
fetch helper for the same reason. A recording is drawn as SVG `rect`/`circle`
elements from numbers: no markup, link, style, image or request comes from
recording data. A 403 while loading stops the player. The playback route now
returns `{chunkIndex, version, events}` (flattened).

Witnesses: `replayCapture.test.ts` (4: a page with text, a typed email, an image
and contenteditable yields no words and only P2.1-valid nodes; never-record
pages; the POSTed chunk gunzips to the closed format and a `recorded:false` stops
it; no start without the choice and a withdrawal stops before the next send) and
`replayPanel.test.tsx` (4). Controls, each red then restored: placeholders sized
by the element, no quantization, password pages allowed, refusals ignored, no
withdrawal re-check, text added to a box; in the viewer, no 403 state, the root
drawn, masks drawn as boxes, scroll ignored, and a press that sticks after
release (the last two were green on the first draft of the witness, which never
scrolled or moved after a release; both cases were added). Frontend build gate
green; site and analytics suites 148/148.

Still owed before enablement: offering the choice to visitors, the full gate,
`/code-review` and `/architect` (including the toggle write seam), and the
real-browser masking check on a live capture.

### P2 offering the choice; the health/finance exclusion — 2026-10-28

**Exclusion.** David approved excluding health and finance (Q3). Nothing in the
host classifies a client's category, and "do not infer safety from a missing
field label" (P2.1) rules out guessing. So a client organization is **excluded
until an owner/admin attests it is in neither** (`analytics:replay-org-eligibility`,
`PUT …/analytics/orgs/:orgId/replay/eligibility`, `host:analytics:replay`, a
checkbox in the Analytics behavior-capture card). The default is excluded.

Each attestation carries a fresh `attestationId`, and every reservation pins the
id in force (`privacy.eligibilityId`, kept through every privacy rebuild like
the epoch). A recording is covered only while its pinned id is current.
Withdrawing fences the org's recordings at once in every read and write, and the
sweep deletes them. Renewing mints a new id, so earlier recordings never come
back. Re-attesting an already-eligible org is a no-op and fences nothing. An
unreadable attestation is unknown: nothing is deleted.

> **Correction (same day):** the first draft compared the recording's server
> start time with `attestedAt`. Its witness went red: a withdrawal and renewal
> inside one millisecond left an equal timestamp, so renewal revived the
> recording. A clock comparison cannot order events in the same millisecond;
> the pinned id can.

Witnesses: `test/adr0951-p2-org-eligibility.test.ts` (5) and two route cases in
`adr0951-p2-replay-routes.test.ts` (the owner attests through the route; an
editor cannot; the posture offers recording only while attested; withdrawal
refuses the next chunk and empties the list). Store tests mark their orgs
through `test/helpers/replayToggles.ts` `attestReplayOrg` (the production row
shape). Controls, each red then restored: no read fence; coverage ignoring the
pinned id (renewal revives); the offer ignoring eligibility; no sweep deletion.
Removing the early write-path check stayed green because the pre-PUT fence
refuses the same write before any byte is stored: it is defence in depth, not a
gap. Related backend suites 463/463; frontend site/analytics 148/148; frontend
build gate green.

**Offering.** `registerVisitorChoiceProvider('analytics.replay', …)` is now
registered: the public posture offers the separate recording choice only for an
attested org with replay ON, storage configured, and consent management on. The
visitor-choice seam now passes the site's `orgId` (`offeredVisitorChoices(tenantId,
orgId?)`), and this provider offers nothing without it. With the default
toggles OFF, nothing is offered anywhere.

### P2 independent review and fixes — 2026-10-29

An independent review of the whole branch found no critical defect and
confirmed: no revival path, correct RBAC on every new route, an inert viewer,
correct blob abort pass-through, and sound concurrency under single-row CAS.
Fixed from its findings (each with a witness that goes red without the fix):

- **HIGH — an entitlement outage read as OFF.** `resolveOne` returns
  `enabled:false, blockedBy:'unresolved'` when the entitlement read throws;
  `toggleState` treated that as OFF, minting an epoch and deleting the tenant's
  recordings. It is now `unknown`. A real plan refusal stays OFF.
- **HIGH — unbounded list.** `GET …/replay/sessions` now uses
  `listReplaySessionsForOrg`: narrowed to the org, committed, active, unexpired
  and fence-current before any read; org fences read once; consent once per
  visitor; pages of `REPLAY_LIST_PAGE` (50) with a cursor.
- **MEDIUM — sweep cost and growth.** Set lookups replace O(N·M) `includes`;
  eligibility is read once per org per sweep; erased fences carry `erasedAt`
  and are dropped after a day (legacy ones are stamped first).
- **MEDIUM — text length leaked through boxes.** An element that carries words
  gets no box, only the fixed placeholder; its child elements still lay out.
- **MEDIUM — orphan epoch rows.** An OFF with no epoch row and no recordings
  writes nothing (account deletion purges, then notifies).
- **MEDIUM — revocations lost to contention.** P2's removal of the blind consent
  fallthrough is kept; a revoke-only merge now gets 25 backed-off CAS attempts
  (`MERGE_REVOKE_ATTEMPTS`) so a STOP keyword or unsubscribe lands under
  contention, and still never writes blind.
- **LOW:** replay also requires the `consent` toggle (with it off a visitor
  cannot withdraw); concurrent attestations mint one id (`putIfAbsent`); a late
  writer never deletes a chunk committed with its digest; the upload route
  refuses a tokenless or bot caller before decompressing; the recorder re-checks
  never-record fields before every send; the viewer skips a missing chunk and
  starts at the first event.

Accepted residue: a client that omits `sessionKey` keeps a DSAR on the analytics
key from reaching the recording (the visitor-subject key still does); a plan
lapse (`blockedBy:'plan'`) is an OFF and deletes, as for any disable.

### P2 architecture review fixes — 2026-10-30

A second, independent architecture review of the branch (at `08e37deee`) found
two blocking defects, five medium and four low. Each was first shown with a
witness that failed on the code as it stood, then fixed, then checked by
reverting the fix (the witness went red) and restoring it.

| # | Finding | Verdict | Commit | Witness |
|---|---|---|---|---|
| 1 | A toggle OFF could be lost: the listener re-read live state, so a listener past its budget, a crash before it ran, or an ON within seconds meant the sweep saw ON and the recording came back | real | `7772b4032` | `adr0951-p2-toggle-write-reconcile` (late listener; listener never runs; first recording after OFF-then-ON is not fenced; ON and rejected writes fence nothing), `feature-toggle-write-listener` (intent before the row, write carried, `resolveWrittenToggle`) |
| 2 | O(tenant) scans on public and hot paths: every explicit public reject, the viewer list, the hourly sweep and global toggle writes | real (the toggle-write half was already closed by #1) | `ee2eaba7c` | `adr0951-p2-scan-bounds` (storage list prefixes: a reject reads no recording, a withdrawal uses the pointer, the list reads one org, no cross-tenant list) |
| 3 | `fencesHold` cost ~10 reads and re-read the session row; `putReplayChunk` called it at every boundary | real: 45 reads per follow-on chunk | `c5baf93a3` | `adr0951-p2-chunk-reads` (21 reads now, bound 25) |
| 4 | Playback appended to the hash chain per chunk; the viewer fetched every chunk before showing anything | real | `5a7147274`, `ed508951f` | `adr0951-p2-playback` "playback grant" (two chunks one entry; expiry re-audits; no bytes when the audit fails; a grant does not bypass access), `replayPanel` (plays after the first chunk) |
| 5 | Attest and withdraw left no durable evidence; withdraw lost who attested and when | real | `f672fc5d3` | `adr0951-p2-org-eligibility` "eligibility evidence" |
| 6 | Two "may this visit be recorded" predicates; the unused one said yes to a legacy grant with no generation | real (the real gate was already right) | `25ec6b84e` | `adr0951-p0-replay-privacy` (legacy grant refused at the real gate; one gate) |
| 7 | A mixed write (grant + refusal) got 5 CAS attempts, and the SPA did not retry the 409 | real | `3c7c2b968` | `adr0951-p2-consent-generation` (mixed write survives 12 conflicts), `visitorConsent` (one retry on `consent_write_contended`, none on another 409) |
| 8 | Upload `sessionKey` unbounded | real | `d5fc6bac0` | `adr0951-p2-replay-routes` (257 chars, blank, non-string: 400 naming the field, nothing stored) |
| 9 | Unconfigured storage was a 503, not the uniform refusal; org fences ran after gunzip and parse | real | `d5fc6bac0` | `adr0951-p2-replay-routes` (202 `recorded:false`; a malformed chunk to an unattested org is refused undecoded) |
| 10 | Org deletion: is there a cascade to register with? | no seam exists, and none is needed: `deleteOrg` refuses while any org-scoped host row exists (RI-7), so replay rows block the delete instead of orphaning | `e0c552224` | `adr0951-p2-org-eligibility` "org deletion" (pins the guard; passes on the reviewed code) |
| 11 | The viewer ignored `nextCursor` | real | `ed508951f` | `replayPanel` (loads older recordings with the cursor) |

**Decisions.**

- **#1, the seam stays generic.** `host/featureToggles/service.ts` resolves
  nothing for a feature. Each write carries a `writeId` and `rows` (each id's
  stored row after the write; `null` when the override was removed); an
  optional INTENT is awaited before the store write (a throw fails the write)
  and told, best-effort, when the write did not land (a lost CAS).
  `resolveWrittenToggle` is the same pure resolution as a live read, applied
  to the written row. Replay's intent writes a marker
  (`analytics:replay-toggle-writes`); every observation applies pending
  markers before it trusts an ON, so an ON can never be accepted ahead of an
  OFF written before it. The sweep applies them everywhere and drops them
  after the settle window. A tenant's first recording after an OFF-then-ON is
  not fenced by the old OFF: the writes its observation saw are seeded as
  applied, except the newest write of each toggle (its marker precedes its
  row, so it may not have landed yet).
- **#2, an enablement row per recording tenant.** It is written before the
  tenant's first reservation, so it doubles as the list of tenants a global
  write and the sweep visit. Erasure reads subject pointers
  (`analytics:replay-subject`, keyed by a digest of the identity, written after
  admission and before the reservation); a pointer with no row fences that id.
  The consent seam is unchanged: it still calls the hook on an explicit
  refusal, and the hook costs one empty prefix read when the visitor was never
  recorded. **Migration:** a one-time, sentinel-guarded backfill in the first
  sweep gives older rows a pointer and an enablement row. P2 was never deployed
  with recordings (replay toggles are OFF in production), so in practice it
  finds none; it is there so a dev or staging store stays erasable.
- **#3, which fences are re-read.** The org fences are read once per upload and
  pinned on the row. A disable or a withdrawn attestation that lands while a
  chunk is in flight leaves that chunk unreadable (every read re-checks every
  fence) and the sweep deletes it. Consent is re-read at every boundary.
- **#4, the grant.** One `analytics.replay.viewed` entry per (viewer,
  recording) per 10 minutes (`REPLAY_PLAYBACK_GRANT_MS`), appended before the
  grant row exists. The entry no longer names a chunk index.
- **#5, permission.** Withdraw keeps `host:analytics:replay` (built-in
  owner/admin only). Attesting is the risky direction, and it is audited before
  it takes effect. Withdrawing only stops recording and deletes; requiring more
  permission to delete than to watch would make the protective act the harder
  one. History lives on the hash chain (the withdrawal entry carries the
  superseded `attestationId`, `attestedBy`, `attestedAt`), not in a lingering
  row, which would also block org deletion (#10). A CAS that loses to a
  concurrent change leaves its entry as a recorded attempt.

**Residue.**

- #1: two admin writes of the same replay toggle in the same millisecond on
  different instances may order wrongly for the "newest write" seeding rule;
  the cost is a first recording fenced (the safe side). A write whose marker
  outlives `APPLIED_KEEP_MS` (3 h, only if its sweep keeps failing) may fence
  again, also the safe side.
- #2: a pointer can briefly outlive its erased recording (crash between the
  erase and the pointer delete); erasure skips it and the sweep prunes it.
- #10: no org-delete cascade for replay. The RI-7 guard means an org with
  replay rows must have its attestation withdrawn (the sweep then deletes the
  recordings and, after two days, the admission counters) before it can be
  deleted.


### P2 release-review follow-up: a toggle store write that throws — 2026-10-30

The release manager found this while reviewing #5398. Two toggle writes did not use compare-and-swap: `saveConfig` without a revision, and `purgeTenantOverrides`. When the store step of either write threw, the write intent was never abandoned. The replay intent records its marker before the store write. So an OFF that failed to save left a marker behind, which fenced the tenant and let the sweep delete its recordings while replay stayed ON. That leans toward privacy, but it loses data for nothing. The compare-and-swap paths abandoned only on a clean `false`, never on a throw.

A store step that throws has an unknown outcome, because the store may have committed before it failed. Abandoning blindly could drop the marker for an OFF that did land, which is the failure the marker exists to prevent. So every store step in `host/featureToggles/service.ts` now runs through `storeToggleWrite`. On a throw, it reads the rows back:

| Rows read back | Action |
|---|---|
| none landed | abandon the intents |
| all landed | notify the listeners |
| some landed | prepare an intent for the landed rows, then abandon the original |
| read-back failed | keep the intent (conservative) |

The step's error is rethrown in every case. `prepareToggleWrite` also abandons when a later intent's `prepare` throws, so an earlier intent's marker is not left behind.

| Finding | Witness |
|---|---|
| An OFF that never landed fenced the tenant and the sweep deleted its recordings | `adr0951-p2-toggle-write-reconcile.test.ts` "a write that never landed…": red on the old service |
| An OFF that landed and then threw must still fence | same file, "a write that landed and then threw…": green on both, so the change does not over-abandon |
| Seam behaviour for put, compare-and-swap, delete, part-way multi-row writes, failed read-backs and prepare failures | `feature-toggle-write-listener.test.ts` "a throwing store step": 5 of its 6 cases are red on the old service |
