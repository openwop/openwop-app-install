# ADR 0956 — Attribution and incrementality: multi-touch, lift tests, UTM governance, AdMap, ROAS reconciliation

Status: Proposed

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
| P0 | `host/trackedUrl.ts` + pack migration; UTM policy + `utm-lint` in pre-publish; unattributed triage; ledger gains `orgId`/`landingUrl`/`adRef` | A link violating the policy blocks publish with a typed failure; new dispatches record their landing URL |
| P1 | Touch-path cache + eraser/retention + rule-based models + `sessionLastClick` column | Credits sum exactly to value (property test); manifest test includes the path eraser |
| P2 | Reconciliation report + AdMap projection (ad grain where ADR 0907 provides it) + match score via 0933 | Fixture with three platforms claiming one conversion shows the overlap and the inflation flag |
| P3 | Audience holdouts + geo tests through ADR 0949 (`geoLift`), enforcement through 0952, calibration factors; Markov model | Unverifiable geo exclusion gives `invalid_enforcement`; seeded bootstrap is stable on replay |
| P4 | Offline conversion sources (deals, orders) with advertising consent; match-rate reporting | Replayed deal-won run relays once (dedup witness) |

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
