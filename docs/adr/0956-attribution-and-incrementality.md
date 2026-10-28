# ADR 0956 — Attribution and incrementality: multi-touch, lift tests, UTM governance, AdMap, ROAS reconciliation

Status: Accepted (P0–P2 implemented, P2's match score owed to ADR 0933; P3–P4 open)

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 3. Net-new from David's 2026-10-19
request to "manage ad budgets" and "drive traffic" to the winners. Budget decisions are
only as good as the measurement under them. Extends `campaign-intel` (ADR 0219
attribution floor, ADR 0248 email opens, ADR 0297 conversions relay) and
`campaign-connectors` (ADR 0907). Reuses ADR 0949 for incrementality tests. Feeds 0952
(budget reallocation), 0957 (client reports) and 0960 (cockpit).

## Context

Agencies are asked two questions they cannot answer well today: "which touches
produced this revenue?" (attribution) and "would it have happened without the ads?"
(incrementality). Every platform answers the first in its own favour: Meta, Google and
TikTok each claim the same conversion. The only honest answer to the second is an
experiment with a holdout. Meta Conversion Lift and Google geo experiments exist, but
each measures only its own platform, and each needs a minimum spend.

The app already has an honest floor: a last-click join that reports platform and web
conversions side by side and never sums them. This ADR builds on it without breaking
that rule.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `packs/` or `docs/`.

- **Attribution floor:** `features/campaign-intel/attribution.ts:128` `buildAttribution`,
  a read-time projection over campaigns, the performance store, analytics conversions
  (uncapped `listConversions`, `:131-135`) and email engagement. Platform and web
  conversions are side by side and never summed (`:20-22`). Every row carries lineage.
  Shared UTM keys are attributed once and named (`:174-183`).
- **A-1: the floor is converting-hit last-touch, not session last-click.** A
  conversion is matched on its own `e.utm?.campaign` (`attribution.ts:196`). The beacon
  stores `utm` per event (`features/analytics/analyticsService.ts:151`). A visitor who
  lands with UTMs and converts on a later page without them counts as
  `unattributedConversions`, unless the client re-sends the UTMs. Multi-touch needs
  session or contact paths, which do not exist yet.
- **Identity for paths:** `contactForSession` (`features/analytics/identityLinkService.ts:92`),
  a deterministic session→contact link (ADR 0226/0857). No probabilistic matching (a
  recorded non-goal at `attribution.ts:52-53`).
- **Performance grain is campaign × ad set × day**, natural key
  `platform|campaignName|adSet|date` (`features/campaign-connectors/performanceService.ts:28-29`).
  **There is no ad-level grain**, which an ad→page map needs.
- **Ad dispatch ledger:** `AdDispatchRecord` (`host/adsAdapter.ts:221-236`) keeps
  platform campaign, ad set and ad ids and `briefId`, but **not `landingUrl` or
  `orgId`**. The landing URL is passed in `PublishAdArgs.landingUrl` (`:95-98`) and then
  dropped. The ledger is capped at the newest 500 rows per tenant (`:1630-1632`).
- **UTM stamping is a pack helper, not a host seam:** `packs/feature.campaign-channels.nodes/index.mjs:627-629`
  appends a brief's UTM schema to outbound URLs. The schema is `BriefUtm`
  (`features/campaign-brief/types.ts:64-70`), carried onto the campaign
  (`features/campaign-orchestration/types.ts:33-34`). Forms capture `utm_*`
  (`features/forms/routes.ts:43`). There is no vocabulary, naming policy or linter.
- **Conversions relay (ADR 0297, deepened by 0907):** `relayConversion`
  (`features/campaign-connectors/pixelService.ts:130-157`), with email hashed
  server-side, `eventId` dedup and an honest `queued` status. Delivery goes through
  `AdsAdapter.sendConversion`. ADR 0907 owns TikTok auth, Google
  `uploadClickConversions` and the health route. **This ADR does not redesign the relay.**
- **Holdout primitives:** journey `bucketHoldout`
  (`features/campaign-journeys/surface.ts:17-21`); ADR 0949 owns the unified model and
  stats. Region of a visitor: `visitorRegionOf` (`features/consent/visitorRegion.ts:49`).
- No multi-touch, time-decay, position-based, Markov or Shapley code exists anywhere
  (grep for `multi-touch|attributionModel|time-decay|position-based`, 2026-10-19).

## Decision

### D1 — Touchpoint paths as a derived cache (the prerequisite)

- `campaign-intel:touch-path` rows, one per converting unit and conversion:
  `{orgId, conversionEventId, unit: {kind: 'session' | 'contact', id}, touches:
  [{at, channel, source, medium, campaign, content, clickIdKind?, adRef?}], value,
  currency, lookbackDays}`.
- A touch is any analytics event that carries UTMs or click ids, or an email click
  (ADR 0226 token), within the lookback window (default 30 days, per client org, 1–90).
  Sessions join into contact paths **only** through the deterministic identity link.
  Without one, the path is session-scoped, and the report says what share of paths
  that is.
- The cache is built by a sweep and rebuilt idempotently (the `funnelStats.ts`
  pattern). The source of truth stays the analytics store. Only consented visitors'
  events exist to build from. Paths are `confidential-pii`: a retention purger and a
  subject eraser are registered and added to `EXPECTED_SUBJECT_ERASERS`
  (`host/subjectEraserManifest.ts:212`).
- This also fixes A-1. The existing last-click row gains a `sessionLastClick` column
  computed from paths, beside the unchanged converting-hit column, so the change is
  visible rather than silent.

> **Correction (2026-10-20, P1 build, after `/architect`): no path cache.** Paths are
> computed at READ time from the analytics events, and there is no
> `campaign-intel:touch-path` store. The attribution report already does one
> tenant-indexed scan of the event store; `listAttributionEvents` returns the
> conversions and the touch events from that same scan, so paths cost no extra I/O. The
> session→contact links are read once per report (`contactsBySession`, one bounded
> prefix read) instead of once per session. A cache would hold confidential-pii rows
> that need their own eraser, retention purger and rebuild sweep. Between sweeps it
> could also serve a touch the analytics eraser had already removed. With no cache, the
> analytics eraser and retention purger are the only copies to clean, so there is **no
> path eraser to add to `EXPECTED_SUBJECT_ERASERS`**. The P1 exit criterion "manifest
> test includes the path eraser" becomes an erasure witness instead: erasing a session's
> events removes its touches from every path (`adr0956-attribution-models.test.ts`).
> Revisit this only if the report's scan cost becomes the bottleneck, and then build the
> cache together with its eraser.
>
> Other decisions in the P1 build:
> - Consecutive identical touches from ONE session collapse to the first. Sites that
>   re-send UTMs on every page would otherwise multiply one visit's credit under the
>   linear and decay models.
> - A touch whose `utm_campaign` maps to no campaign is credited to an `unmapped` row,
>   never dropped, so every path's credit still adds up.
> - The channel is `email` for an email-click token, `paid:<platform>` for an ad click
>   id, else the `utm_medium`. Credit is per campaign in P1; channel is recorded for the
>   P3 Markov model.
> - Conversion value: `props.valueMinor` (integer minor units) or a commerce
>   `props.total` (major units), each with a 3-letter `props.currency`. Otherwise only
>   the conversion count is credited.
> - Lookback, half-life and the default model are a per-org settings row
>   (`campaign-intel:attribution-settings`, closed-world, CAS). Its editor is tombstoned
>   by the campaign-intel eraser.

### D2 — Multi-touch models alongside last-click, never instead

- Rule-based models in a pure module `features/campaign-intel/attributionModels.ts`:
  `last_click` (existing), `first_touch`, `linear`, `time_decay` (half-life 7 days,
  configurable), `position_based` (40/20/40). Credit is fractional and sums to exactly
  the conversion's value per path, using minor-unit integer arithmetic. Rounding goes to
  the last touch.
- **Data-driven model (P3):** a Markov removal-effect model over the paths, computed
  deterministically (no sampling), reported only when there are at least 300 converting
  paths and 30 per channel, with a confidence interval from a seeded bootstrap. Below
  that it shows `insufficient_data`, never a number.
- **Presentation rules** (the existing honesty rule, extended): the report shows one
  model at a time with a model selector, plus a comparison table. Platform-reported
  conversions are never added to modelled credit. No model is labelled "true". The
  default is chosen per client org, recorded and shown on every report (ADR 0957).

> **Correction (2026-10-20, P1 build): integer weights, BigInt split.** Every model
> produces integer weights. time_decay scales `2^(-age/halfLife)` to 1e6 and gives
> every touch at least 1. `allocate` floors each share with BigInt and gives the
> remainder to the last touch. Float weights cannot guarantee an exact sum: a share
> computed a hair above an integer floors up, and the remainder goes negative.
> Conversions are credited in micro-units (`CONVERSION_UNITS` = 1e6 per conversion), so
> a three-touch path splits exactly. The model report runs behind the
> `campaign-intel.multi-touch` sub-toggle, which is OFF by default. The session-last-click
> column rides the base toggle, because it is the A-1 fix, not a model.

### D3 — Incrementality: holdout and geo tests are ADR 0949 experiments

- **Audience holdout** (owned channels: email, SMS, journeys): an ADR 0949 Decide
  experiment with `unit: 'contact'`, arms `exposed` and `holdout` (default 10%), and
  metric = conversions or revenue per contact. Assignment is the run-start-frozen
  contact split (ADR 0949 D3). Lift and iROAS come from the same stats engine.
- **Geo test** (paid): an ADR 0949 experiment with `unit: 'geo'`. Geos are regions
  from the platform's targeting vocabulary. Assignment is a matched-pair randomization
  over pre-period outcome, deterministic with the experiment salt (`bucketOf` per pair).
  Analysis is a difference-in-differences with a synthetic-control check, added to
  `host/experiments/stats.ts` as `geoLift`, with a pre-period fit diagnostic. A poor
  pre-period fit returns `inconclusive_design`.
- **Enforcement is on the platform.** Holdout geos are excluded from targeting through
  ADR 0952's governed launch. The change is a side effect behind ADR 0942 (action class
  `ads.budget` / `ads.launch`), with verification read back from the platform. A geo test whose
  exclusion cannot be verified is `invalid_enforcement`, never analysed.
- **Platform lift studies** (Meta Conversion Lift, Google conversion lift) are imported
  as results with `unit: 'platform'` and labelled as the platform's own measurement.
- **Results feed calibration:** a passing lift test writes an incrementality factor
  per channel and client org, with an expiry (default 180 days). Reports may show
  "attributed × factor" beside the raw model, always labelled with its test id.

### D4 — Conversion relay: compose ADR 0907, add offline conversions

- No new relay. This ADR adds two sources to the existing queue: a **CRM deal won**
  (ADR 0008 pipelines) and a **commerce order paid** (`funnelRef`, ADR 0296). Both
  enter through `relayConversion` with a deterministic `eventId` (`deal:<id>` /
  `order:<id>`), so a retried or replayed run cannot double-send.
- Offline relay requires `isPermittedForPurpose(…, 'advertising')` for the contact
  (`features/consent/consentService.ts:374`). No permission means no relay, counted
  by reason.
- **Match-rate reporting:** the relay health route (ADR 0907) gains per-platform
  match rate and dedup rate, which the reconciliation in D6 uses.

### D5 — UTM governance: one helper, one policy, one linter

- **Host seam** `host/trackedUrl.ts` `buildTrackedUrl(base, campaign, {channel,
  variantKey, adRef})`. It moves the pack helper (`index.mjs:627`) into the host, and
  the pack calls the host through `ctx`. Every outbound link from ads (0952), email
  (0955), social (0953) and pages uses it. Experiment arm and ad ref go into
  `utm_content` and `utm_id`.
- **Policy per client org** (`campaign-intel:utm-policy`): allowed `source` and
  `medium` vocabularies, a required-parameter set, a `campaign` naming template (default
  `{campaign.slug}`), and a case rule. The default policy is generated from the GA4
  channel-grouping vocabulary.
- **Linter node** `utm-lint` (read) runs in the ADR 0942 pre-publish checks: a link
  that breaks the policy is a typed failure (`utm_policy_violation`) that blocks the
  publish gate. It is not auto-rewritten.
- **Unattributed triage:** the report lists the top unmatched `utm_campaign` values and
  their counts. The Reporting Analyst (ADR 0943) can propose a mapping, which a human
  confirms (an alias table, never a rewrite of events).

> **Correction (2026-10-20, P0 build, after `/architect`).** What P0 actually ships
> differs from the text above in five places; the text is kept for the reasoning trail.
>
> 1. **Signature.** `buildTrackedUrl(url, utm, {fallbackCampaign, variantKey?, adRef?})`.
>    The pack's `appendUtm` rules carry over unchanged (a parameter already on the URL
>    wins, a relative URL stays relative, `utm_campaign` falls back to the brief id).
>    The pack reaches it through `ctx.features['campaign-brief'].trackedUrl`, because
>    campaign-brief owns `BriefUtm`. A host without that method makes
>    `publish-ad-variants` fail with `host_capability_missing`; it never sends an
>    untracked link. Only the ad path stamped links before P0. Email (0955) and social
>    (0953) adopt the helper when they build their outbound links.
> 2. **Where the linter bites in P0.** The ADR 0942 pre-publish chain does not exist on
>    `main` yet. So `trackedUrl` lints inline, and `publish-ad-variants` refuses a
>    violating link with `utm_policy_violation` BEFORE `ctx.ads.publishAd`. The
>    `utm-lint` node ships now for that chain to use. Linting runs only while
>    `campaign-intel` is ON for the tenant, which is OFF by default. That way existing
>    publishes are not newly blocked by a feature the tenant never enabled. When it is
>    ON, a policy that cannot be read is an error, never "no violations" (fail closed).
> 3. **Naming template deferred.** The `{campaign.slug}` template is not in P0. The
>    `case: 'lower'` rule and the required set cover the GA4 hygiene failures that
>    matter. A template is additive on the policy row (closed-world parse, new field).
> 4. **Default sources are open.** GA4's default channel grouping matches sources by
>    pattern lists (e.g. its social-sites list), which a closed vocabulary cannot honour
>    without false refusals. The default policy pins the GA4 mediums and leaves
>    `sources` empty (any). An org can close it.
> 5. **No agent writes an alias in P0.** Aliases are a route-only, human act
>    (`workspace:write`), audited. An alias may not name a value that is already a
>    campaign's join key (409 `utm_alias_conflicts_join_key`), because that would
>    attribute one conversion twice. Its target must be one of the org's campaigns.
>    The Reporting Analyst's propose-a-mapping tool lands with ADR 0943's agent work.

### D6 — AdMap (ad↔page mapping) and ROAS reconciliation

- **Ledger extension (additive):** `AdDispatchRecord` gains `orgId`, `landingUrl`,
  `adRef` (our variant id from ADR 0946) and `experimentId?`. The ledger cap moves from
  500 newest per tenant to a per-org cap with archival of ended campaigns' rows to the
  map projection, because AdMap must not lose old ads silently.
- **Ad-level metrics:** ADR 0907's reader gains an ad grain, behind its per-platform
  flags. The natural key becomes `platform|campaignName|adSet|ad|date`, with existing
  rows read as `ad = '(adset)'` (the same additive-label precedent as
  `CAMPAIGN_LEVEL_ADSET`, `features/campaign-connectors/syncService.ts:161`).
- **AdMap projection:** ad → landing URL → resolved CMS page or funnel step (through
  the custom-domain map, ADR 0906 and the unmerged custom-domain edge-ownership ADR) → experiment arm. Each pair shows spend,
  clicks, landing sessions, conversions under the selected model, a click-to-session
  loss rate, and a **message-match score**. The score comes from ADR 0933 content rules
  (headline, offer and CTA consistency between ad copy and page H1/hero), as a recorded
  node output, so an agent never grades it ad hoc. Instapage AdMap parity, plus
  experiment and model awareness.
- **Reconciliation report** per campaign, channel and client org: platform-reported
  conversions and ROAS beside measured (modelled) conversions and ROAS, plus the
  incrementality-calibrated figure when a valid test exists. The **inflation ratio**
  (reported ÷ measured) is flagged when it exceeds 1.5× for 7 days. Every number keeps
  its lineage (rows, key, freshness, model, test id). The sum of the platforms' claims
  is shown as an "overlap" figure against the measured total, which makes double
  counting visible. ADR 0952's reallocation suggestions must name which figure they
  use, and they default to measured.

> **Correction (2026-10-20, P2 build).** What P2 ships differs from the bullets above in
> five places.
>
> 1. **No ad grain yet.** ADR 0907's reader still reads campaign × ad set × day, so the
>    AdMap reports per-ad spend and clicks as `null` (`metricsGrain: 'campaign'`), and
>    the click-to-session loss rate as `null`. It never splits a campaign's spend across
>    its ads. The ad grain is still ADR 0907 work.
> 2. **The ad→visit join is `utm_id`.** P0's `buildTrackedUrl` stamps the ad reference as
>    `utm_id`. Analytics ingest now keeps `utm.id` (additive), and the AdMap counts a
>    landing session and credits a conversion through it. A site's beacon must send
>    `utm.id`, as it already sends the other UTMs.
> 3. **Landing resolution.** A link resolves to a CMS page by slug on the org's own site:
>    a relative path, a custom host bound to the org (ADR 0906), the platform site org's
>    `/p|/blog|/docs/<slug>`, or the vendor `…/public/<org>/pages/<slug>` path. A funnel
>    step is found as the step whose `pageId` is that page, because funnel steps render
>    CMS pages. A host bound to another client is `other_org`; anything else is
>    `external`. A pre-P0 ledger row with no `orgId` is placed by its brief's org, else
>    counted as `unplacedLegacyRows`.
> 4. **Match score owed.** The message-match score needs ADR 0933 content rules (a0's
>    0933 P0, not built). Each AdMap row carries `messageMatch: {status: 'owed'}` rather
>    than a score computed ad hoc.
> 5. **Ledger cap unchanged** (open question 4 is still open). The AdMap reports
>    `ledgerCapped` when the tenant's ledger is at its cap, because an older ad may be
>    missing.
>
> **Reconciliation decisions.**
> - A touch's platform comes from its ad click id, else its `utm_source` (facebook,
>   instagram → meta; google, youtube → google; and so on).
> - "Above 1.5× for 7 days" is evaluated as the 7-day rolling window ending on each of
>   the last 7 days. Every window must contain a claim and be above 1.5×. A window with
>   claims and no measured conversions counts as above, and the row says `measuredZero`.
> - Measured ROAS uses only credited value in the campaign's own currency. Other
>   currencies are listed, never converted.
> - The model is last click unless the multi-touch sub-toggle is on. A named model
>   otherwise is a typed `validation_error`. The route and the surface share one helper
>   (`resolveReadModel`).
> - `calibration` is `null` with reason `no_valid_lift_test` until P3.

> **Correction (2026-10-20, P0 build).** P0 adds `orgId`, `landingUrl` and `adRef` to
> `AdDispatchRecord` and to the `DispatchLedgerRow` projection allowlist. `adRef` is
> NOT part of the dispatch idempotency key: a retry with a different ad ref is the same
> dispatch. Neither is `landingUrl` (true before P0 too; `/code-review` found the P0
> comment claiming otherwise and corrected it). So a re-run that changes only the link
> reuses the earlier dispatch and the ledger keeps the first link. Adding the link to
> the key would mint a duplicate paused campaign for every pre-P0 record on its next
> re-run. That call belongs to P2, when AdMap first reads the field. `landingUrl` is the tracked link actually sent. `experimentId` and the ledger
> cap change wait for P2/P3, which consume them. Rows written before P0 have no `orgId`
> and are not backfilled. A reader keyed on org must treat a missing `orgId` as
> "unknown", never as a match.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Extends `features/campaign-intel/` (paths, models, reconciliation, AdMap, UTM policy) and `features/campaign-connectors/` (offline sources, ad grain). Host seam `host/trackedUrl.ts`. Geo stats added to ADR 0949's `host/experiments/stats.ts`. No new package. |
| 2 | Toggle | No new top-level toggle: rides `campaign-intel` (OFF, tenant). Sub-toggle `campaign-intel.multi-touch` (OFF, tenant; an `extraToggleDefaults` entry of `campaign-intel` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code with `campaign-intel`)) gates the path sweep, so its storage cost is opt-in. Incrementality needs `experiments` (ADR 0949). Ad-grain reading inherits ADR 0907's per-platform flags. |
| 3 | Workflow surface | `ctx.features.campaignIntel.{attribution(model), reconciliation, adMap, utmLint}` (read; `orgId` required, run stamp checked). |
| 4 | Node pack | `feature.campaign-intel.nodes` gains `attribution-report`, `reconcile`, `ad-map`, `utm-lint` (read) and `apply-incrementality-factor` (side-effect, keyed by test id). Chain `campaign-intel.weekly-measurement` (rebuild paths → reconcile → Reporting Analyst narrative → notify). |
| 5 | Envelopes | None. |
| 6 | Agent pack | Extends `vendor.openwop-app.campaign-intel.agents.intelligence-analyst` with the read tools; the Reporting Analyst and Media Buyer (ADR 0943) use the same tools. Narratives cite tool fields only (prompt parity test). |
| 7 | Public surface | None new. Offline conversions arrive through authed CRM and commerce events, not a public lane. |
| 8 | RBAC | Reports: `workspace:read` on the client org. UTM policy, aliases and incrementality factors: `workspace:write`. Geo-test enforcement goes through ADR 0942/0952 gates. Uniform 404 on wrong org. |
| 9 | Replay / fork | Models and reconciliation are pure over a snapshot recorded in node output. Factor writes and alias writes are keyed side effects. Geo enforcement is ADR 0952's side-effect node; a fork never re-targets. |
| 10 | Frontend | Campaign Studio → Performance: model selector + comparison, reconciliation table with the inflation flag, AdMap grid (ad thumbnail → page thumbnail → metrics + match score), UTM policy editor and unattributed triage, incrementality test results linked to the ADR 0949 experiment. |

## Why this is our advantage

- **Measurement and spend in one governed loop.** A lift test is an experiment run,
  its enforcement is a gated side effect, and its result calibrates the reallocation
  that ADR 0952 proposes and a human (or policy) approves. Northbeam, Triple Whale and
  Rockerbox measure. Smartly and Madgicx spend. None closes the loop with logged gates.
- **Every figure is replayable and carries lineage.** The ROAS a client saw on a given
  date can be reproduced from the recorded snapshot, model and test id.
- **Platform-neutral by construction** (open protocol, agency-side). We are not Meta or
  Google grading our own homework, and the reconciliation report says so with numbers.
- **Per-client isolation** of paths, policies and factors (ADR 0921) for agencies.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `host/trackedUrl.ts` + pack migration; UTM policy + `utm-lint` in pre-publish; unattributed triage; ledger gains `orgId`/`landingUrl`/`adRef` | **Implemented (2026-10-20)** — see the P0 record below. A link violating the policy blocks publish with a typed failure; new dispatches record their landing URL |
| P1 | Touch-path cache + eraser/retention + rule-based models + `sessionLastClick` column | Credits sum exactly to value (property test); manifest test includes the path eraser |
| P2 | Reconciliation report + AdMap projection (ad grain where ADR 0907 provides it) + match score via 0933 | Fixture with three platforms claiming one conversion shows the overlap and the inflation flag |
| P3 | Audience holdouts + geo tests through ADR 0949 (`geoLift`), enforcement through 0952, calibration factors; Markov model | Unverifiable geo exclusion gives `invalid_enforcement`; seeded bootstrap is stable on replay |
| P4 | Offline conversion sources (deals, orders) with advertising consent; match-rate reporting | Replayed deal-won run relays once (dedup witness) |

### P0 implementation record (2026-10-20)

| Item | Where | Witness |
|---|---|---|
| One tracked-URL helper + linter (pure) | `backend/typescript/src/host/trackedUrl.ts` | `adr0956-utm-governance.test.ts` (pure block); the two ported AUDIT-9 cases in `campaign-channels-publish.test.ts` |
| Pack migration (`appendUtm` removed) | `packs/feature.campaign-channels.nodes` 1.13.0 → 1.14.0; `campaign-brief/surface.ts` `trackedUrl` | "publish-ad-variants refuses a link that breaks the policy BEFORE dispatch" (sabotage: dropping the violation check → red) |
| Per-org policy, CAS + closed-world | `features/campaign-intel/utmGovernance.ts`; routes `GET/PUT …/campaign-intel/orgs/:orgId/utm-policy` | policy case (sabotage: skipping the version check → 4 red; dropping the write scope check → 4 red) |
| Lint route + `utm-lint` node | `POST …/orgs/:orgId/utm-lint`; `packs/feature.campaign-intel.nodes` 1.2.0 → 1.3.0; surface `utmLint` (floors the run's person on the org) | lint route + node cases |
| Off-by-default lint | `trackedUrl` reads `resolveOne('campaign-intel')` | "unlinted while campaign-intel is off" (sabotage: always skipping → 2 red) |
| Unattributed triage + aliases | `attribution.ts` `unattributedByCampaign`, `lineage.aliasedConversions`; routes `GET/PUT/DELETE …/utm-aliases` | alias case (sabotage: dropping aliased conversions → red; dropping the join-key guard → red) |
| Ledger fields | `host/adsAdapter.ts` | `ads-adapter-meta.test.ts` "records its org, landing URL and ad reference" |
| Subject erasure | `features/campaign-intel/erasure.ts`, `subjectEraserManifest.ts` | erasure case; `subject-eraser-manifest` |

Ratchets moved: `feature-dependency-parity` 99 → 100 (`campaign-brief → campaign-intel`,
undeclared, justified inline). `adr0832-org-scope-subject` reviewed readers gain
`features/campaign-intel/surface.ts`. The `pack-surface-arg-parity` fixture was
regenerated. The side-effect floor, served set, steward manifest and
FEATURE-DEPENDENCIES were regenerated with their generators.

Reviews (2026-10-20). `/code-review`: no banned patterns, no wire change, routes gated
(toggle + org scope, writes `workspace:write`). Two fixes applied. A comment wrongly
claimed `landingUrl` is in the dispatch idempotency key (see the D6 correction). The
`utmLint` surface did not bound each URL's length the way the route does. Noted, not
changed: the brief surface's `trackedUrl` does not floor the run's person on the
brief's org, the same as its sibling methods (`getBrief`, `assembleContext`).
`/grade-workflows` (scoped, no chain in P0): `publish-ad-variants` is role `action`
(not on the replay floor, unchanged from `main`). A fork therefore re-executes it, and
it now reads the CURRENT policy and toggle. Double dispatch is still prevented by the
ads ledger's idempotency key. The policy that judged the link is now recorded
(`outputs.utmCheck` / `error.policyVersion`), so a divergence between a source run and
its fork is visible. `utm-lint` is role `read` and re-executes live by design. Its
output carries `policyVersion`. Typed failures throughout: `host_capability_missing`,
`tracked_url_failed`, `utm_policy_violation`. `/ux-review`: N/A, P0 has no UI. The
policy and alias editors land with the reporting UI.

Security correction (2026-10-20, after #5123). `trackedUrl` first shipped tenant-only, like
the brief surface's other by-id methods. #5123 then org-scoped every by-id method on that
surface. This PR is rebased onto #5123, and `trackedUrl` now resolves its brief through the
same `scopedBrief` helper. A brief outside the run's org, or outside the orgs the run's
person may read, is a uniform `not_found`. A run for client A therefore cannot mint client
B's tracked link or read B's UTM policy verdict. Witness: "trackedUrl is org-scoped" in
`adr0956-utm-governance.test.ts`, driven through the real seam. Sabotaging it back to a
tenant-only read turns that case red.

### P1 implementation record (2026-10-20)

| Item | Where | Witness |
|---|---|---|
| Read-time touch paths | `features/campaign-intel/touchPaths.ts`; `analytics/analyticsService.ts` `listAttributionEvents`; `analytics/identityLinkService.ts` `contactsBySession` | pure path cases (sabotage: drop the contact join → 3 red; drop the collapse → 2 red; drop the lookback → 2 red) |
| Rule-based models, exact credit | `features/campaign-intel/attributionModels.ts` | seeded property test, 1 000 random paths × 5 models, every sum exact (sabotage: drop the remainder → 3 red) |
| `sessionLastClick` + `pathCoverage` | `attribution.ts` `buildAttribution` | "sessionLastClick credits the landing campaign" (sabotage: converting-hit-only last touch → 2 red) |
| Model report + sub-toggle | `buildModelReport`; route `GET …/orgs/:orgId/attribution/models`; surface `attributionModels`; node `attribution-models` (`feature.campaign-intel.nodes` 1.3.0 → 1.4.0); toggle `campaign-intel.multi-touch` | refused while off on the route AND the surface (sabotage each → red); exact sum per model |
| Per-org settings | `attributionSettings.ts`; routes `GET/PUT …/orgs/:orgId/attribution-settings` | CAS, closed-world, 403 for a non-member (sabotage: skip the version check → red) |
| Erasure | no path store; `erasure.ts` covers the settings editor | erasing a session's events removes its touches from every path |
| UI | `CampaignIntelPage.tsx` column + note; `MultiTouchSection.tsx` (model selector, comparison, make-default); 4 locales | `multiTouchSection.test.tsx` |

Ratchets: the `pack-surface-arg-parity` fixture was regenerated. The side-effect floor
(declared set) and the steward manifest were regenerated. No new cross-feature edge:
campaign-intel already read analytics.

Reviews (2026-10-20):
- `/code-review`: no banned patterns, no wire change, and the new routes are gated
  (toggle + sub-toggle + org scope; writes need `workspace:write`). Two fixes: an
  unchecked cast on the model selector's value, and a doc on what `sessionPaths` counts.
- `/ux-review`: three fixes.
  - The selector shows the model being loaded at once and marks the card `aria-busy`.
  - Failed loads and failed saves now show localized copy, never a raw server string.
    The save failure names its two causes: a stale version or a missing permission.
  - Failure and success notices are announced (`check-notice-announce`).
- `/grade-workflows` (scoped, no chain): `attribution-models` is role `read`, off the
  replay floor by design. A fork re-reads the live events, and its output carries
  `settingsVersion`, `coverage` and `computedAt` for lineage. One fix: a misspelt
  `model` was silently replaced by the org default. It is now a typed
  `validation_error`, matching the route's 400. Open, not P1: no agent tool exposes the
  model report yet; the Reporting Analyst (ADR 0943/0957) is the consumer.

### P2 implementation record (2026-10-20)

| Item | Where | Witness |
|---|---|---|
| Shared context (paths, settings, credit) | `attribution.ts` `loadAttributionContext`, `creditTouches` | the model report, reconciliation and AdMap tests all read through it |
| Reconciliation | `features/campaign-intel/reconciliation.ts`; route `GET …/orgs/:orgId/reconciliation`; surface `reconciliation`; node `reconciliation` | **exit fixture:** three platforms claim one conversion: claims 3, measured 1, overlap 2, every platform flagged (sabotage: no subtraction → red; flag on any day → red; null revenue read as 0 → red) |
| AdMap | `features/campaign-intel/adMap.ts`; route `GET …/orgs/:orgId/admap`; surface `adMap`; node `ad-map` | joins on `utm_id`, resolves page + funnel step, places a pre-P0 row, excludes another client's ad (sabotage: each → red) |
| `utm.id` at ingest | `analytics/analyticsService.ts` | AdMap session count |
| Model gate | `attributionSettings.ts` `resolveReadModel` | route 400 and surface `validation_error` while the sub-toggle is off (sabotage → red) |
| UI | `ReconciliationSection.tsx`, `AdMapSection.tsx`, 4 locales | `measurementSections.test.tsx` |
| Match score | owed to ADR 0933 | `messageMatch.status === 'owed'` |

Pack: `feature.campaign-intel.nodes` 1.4.0 → 1.5.0. Ratchets: `feature-dependency-parity`
100 → 101 (`campaign-intel → funnels`, undeclared, justified inline). The cms read
counts as always-on. The parity fixture, side-effect floor, steward manifest and
FEATURE-DEPENDENCIES were regenerated. Test seam: `__putDispatchRecordForTests` in
`adsAdapter.ts`, read by the P2 test.

Reviews (2026-10-20):
- `/code-review`: no banned patterns, no wire change, and the new routes are org-scoped
  (`workspace:read`; a non-member gets 403, witnessed).
  - One fix: measured ROAS showed `0.00×` when the site recorded no conversion value. It
    is now `null`, because a conversion without a value says nothing about return.
  - Noted, not changed (pre-existing): `listTenantDispatchRecords` scans the whole
    `ads:` prefix across tenants before filtering. The AdMap inherits that cost from the
    sync reader; an indexed ledger read belongs with open question 4.
  - `utm.id` comes from the public beacon like every other UTM, so AdMap session counts
    are only as trustworthy as that beacon.
- `/ux-review`: one fix. A missing ROAS now says why: the platform reports no revenue,
  the site recorded no value, or there was no spend. Before, all three read "Not
  available".
- `/grade-workflows` (scoped, no chain): `reconciliation` and `ad-map` are role `read`
  and re-execute live on a fork. Reconciliation reads the clock for `asOf`, and both
  carry `computedAt`, so a fork's divergence is visible. A misspelt or unavailable model
  is a typed `validation_error`. Missing surface methods fail `host_capability_missing`.

## Alternatives weighed

- **Replace last-click with a "best" model.** Rejected: it breaks continuity of
  reports, and no model is ground truth. Models run alongside.
- **Buy an MTA vendor (Northbeam, Rockerbox) as the engine.** Rejected for v1: the
  measurement would leave per-client isolation and replay. It remains a possible
  connection pack for clients who already pay for one.
- **Probabilistic cross-device identity.** Rejected (an existing recorded non-goal):
  deterministic links only.
- **Marketing-mix modelling now.** Deferred: it needs months of spend history per
  client. Recorded as a follow-on that would reuse the same calibration factors.

## RFC verdict

**Host extension, no RFC.** All routes are under `/v1/host/openwop-app/campaign-intel/*`
and `…/campaign-connectors/*`. Ad-platform calls go through the existing connection
packs and broker. Nothing is advertised.

## Open questions

1. **(David)** Default attribution model shown to clients: keep last-click as the
   default with models alongside (recommended for continuity), or position-based?
2. **(David)** Geo tests spend real money on control regions (opportunity cost). Does
   a geo test always need an explicit client approval in the ADR 0924 portal, whatever
   the campaign's autonomy level?
3. **(David)** Offline conversion relay sends hashed CRM data to ad platforms. Should
   it be opt-in per client org (recommended) on top of per-contact advertising consent?
4. The ledger cap: per-org cap plus archival (D6), or move dispatch records to a
   tenant-indexed store with retention like other ledgers?
5. Which platform geo vocabulary is the unit (Meta regions, Google geo targets, US
   DMAs)? Proposed: per-platform, with a mapping table, and a single-platform test in v1.

## Planning rows

**ROADMAP (Campaign Studio program table):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| T3-d | **Attribution + incrementality** ([ADR 0956](docs/adr/0956-attribution-and-incrementality.md)): touch paths + first/linear/time-decay/position/Markov models beside last-click; audience and geo lift tests as 0949 experiments with 0952-enforced holdouts; offline conversions into the 0907 relay; UTM policy + linter + one `buildTrackedUrl`; AdMap; platform-vs-measured ROAS reconciliation | `campaign-intel` (+ `campaign-intel.multi-touch`) | 0219, 0248, 0297, 0907, 0949, 0952, 0933 | `feature.campaign-intel.*` | Host extension | 🔵 Proposed |

**FEATURES "Future features":**

- **Attribution and incrementality (ADR 0956, Proposed)**: a consented touch-path cache
  (deterministic identity only) feeds first-touch, linear, time-decay, position-based
  and a data-driven Markov model, all shown beside the existing last-click floor and
  never summed with platform claims. Audience holdouts and geo lift tests run as ADR 0949
  experiments, with holdouts enforced through ADR 0952's gated launch. CRM deals and paid
  orders join the ADR 0907 conversions relay under advertising consent. One
  `buildTrackedUrl` helper plus a per-client UTM policy and pre-publish linter. AdMap
  maps each ad to its landing page with a message-match score. A reconciliation report
  shows platform-reported vs measured ROAS with an inflation flag. Rides `campaign-intel`
  (+ sub-toggle `campaign-intel.multi-touch`). Host-ext, no RFC.


### Recovery corrections — 2026-10-25 (validation pending)

The original P0/P1/P2 history is preserved. Recovery composes it with current
main's launch approval CAS, account currency validation, spend caps, campaign
ownership back-links and explicit requester narrowing. The combined channels
pack is 1.15.0 and intel pack 1.6.0; generated metadata still needs regeneration
in the serialized validation slot.

AdMap landing sessions now use every org-scoped tracked event, including a visit
that never converts. A tracking reference shared by multiple distinct ads (or
missing entirely) cannot uniquely assign per-ad credit: its measurements are
null and the UI states that limitation. Unknown tenant legacy rows are excluded
rather than counted for a client. CMS/funnel source reads now check their live
feature gates; retained rows do not mean the feature is enabled. Malformed URL
escapes return unresolved rather than throwing. The shared tracked-URL helper
preserves protocol-relative destinations and refuses executable or empty URLs
before a publish, including when policy linting is off.

These source corrections and regression tests are authored, not validated yet;
the ADR0942 canonical gate owns the local heavy-work slot. P3 incrementality and
calibration remain pending, and no production toggle or paid call changed.


Recovery composition note — 2026-10-25: The composed AdMap now validates HTTP(S), protocol-relative host ownership and percent escapes before resolving a public page path. An unrelated host cannot impersonate this client’s CMS page by copying its URL path. The new regression cases are source-only pending the serialized checks.


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
