# ADR 0907 — Ad metrics depth + server-side conversions: extend `campaign-connectors`, sandbox-verify, close CSG-CON-1

**Status:** Accepted (2026-10-17). **Track 1 (P0–P5) implemented 2026-10-18** — see § Implementation record. Track 2 (P6 sandbox verification → honest-ON, P7 LinkedIn CAPI) waits on § Open decisions for David; until P6 the TikTok/LinkedIn readers and the TikTok/Google senders are built but `unsupported` (`not_sandbox_verified`), and scheduled delivery is behind an OFF-by-default sub-toggle.
**Date:** 2026-10-17
**Feature:** `campaign-connectors` (extends ADRs 0159, 0167, 0215, 0223, 0297, 0357). No new toggle.
**Origin:** MyndHyve port, capability 4 of 4 — lowest priority (gap analysis 2026-10-17: "Ad metrics /
Conversions API — MyndHyve ahead; TikTok and LinkedIn readers deferred (CSG-CON-1)"). MyndHyve read at
`7246fb1ce`.
**RFC verdict:** **host-extension — no RFC.** Ad-platform calls, the performance store, the conversion
relay and its chain are host-extension surfaces; the chains are ordinary RFC 0013 packs and the
schedule is RFC 0052 as already used. ADRs 0215/0297/0357 reached the same verdict for this surface.

## Context

The gap report frames this as "MyndHyve ahead". Read from code, it is mixed: MyndHyve has wider
**reads**, openwop-app has the better **architecture** (brokered credentials, consent-gated relay,
natural-key upserts, one scheduler) — and both have defects. This ADR ports MyndHyve's breadth onto
openwop's shape. It does **not** port MyndHyve's `conversions-api` service, dedup store or token store.

### MyndHyve baseline (`7246fb1ce`)

| Area | Mechanism | Citation |
|---|---|---|
| Sync schedule | `every 24 hours` America/New_York, retry 2, 540 s; all `connected` connectors sequentially; Sync Now with 15 min cooldown | `functions/src/ad-platform-sync/syncScheduler.ts:18,28-75,130-140` |
| Range | `lastSyncAt` (or −30 d) → today; no look-back, no backfill | `syncExecutor.ts:71-75,178-182` |
| APIs | Google Ads `v17` `googleAds:searchStream` (ad_group, `segments.date`); Meta `v21.0` `/insights` `level=adset`, `time_increment=1`; LinkedIn `/rest/adAnalytics` `202401` `pivot=CAMPAIGN`; **no TikTok** | `syncExecutor.ts:218-254` |
| Schema | daily per campaign × ad set: spend, impressions, clicks, conversions, revenue + derived ctr/cpc/cvr/cpa/roas; Meta conversions from an `actions[]` allow-list | `normalizers/base.ts:8-52`; `metaAds.ts:41-69` |
| CAPI | public `POST /track` (Firebase ID token, 100/min/user); Meta CAPI `v21.0`; TikTok Events `v1.3`; Google Ads `v17` `:uploadClickConversions` (gclid + user identifiers) | `functions/src/conversions-api/index.ts:42-84,143`; `platforms/{meta,tiktok,google}.ts` |
| Dedup | global Firestore `conversion_events_dedup/{eventId}`, 48 h TTL, fail-open | `deduplication.ts:13-55` |
| Hashing | SHA-256; email lower/trim; phone digits **and `+`**; names a–z | `hashing.ts:15-64` |
| Tokens | `users/{uid}/adPlatformTokens/{platform}`, AES-GCM with KMS-wrapped key, AAD `{userId,platformId,accountId}` | `ad-platform-tokens/tokenService.ts:46-97`; `tokenEncryption.ts:95-157` |

**Warts — never inherit (verified):**
1. Google sync can never succeed: tokens stored under `google_ads`, read under `google`
   (`syncExecutor.ts:209,217` vs `types.ts:16`), which 401s and marks the connector `revoked`.
2. Sync never refreshes tokens (`getValidToken` without `refreshFn`, `syncExecutor.ts:209`).
3. Rows deduped by id-exists, so late conversion updates are dropped; 32-bit id hash can collide
   (`base.ts:54-63`; `syncExecutor.ts:90-93`).
4. Only page 1 read; only `data[0]` of the Google stream (`syncExecutor.ts:230`).
5. **Ad-platform access tokens come from the browser** in the `/track` body (`types.ts:96-124`;
   `serverSideTracker.ts:77,119`).
6. Google upload: event name as `conversionAction`, the `token|devtoken` string sent as the Bearer,
   server-local timestamps, unhashed name/address (`google.ts:38-47,66,106-107,158-186`).
7. Meta `fbc` built from `Date.now()`, not the click time (`meta.ts:62`); phone hash keeps `+`.
8. **No consent check** anywhere in `conversions-api/`.
9. Sync Now checks sign-in, not workspace membership (`syncScheduler.ts:102-114`).
10. LinkedIn cost ÷100 assumes cents (`linkedInAds.ts:57`); `costInLocalCurrency` is in major units.

### openwop-app today (`4cdb132c3`)

| Concern | Owner | Finding |
|---|---|---|
| Platform calls | `host/adsAdapter.ts:56-83` | Meta `v21.0`, Google Ads `v18`, TikTok `v1.3`, LinkedIn `/rest` `202506`, all through the Connections broker; hard-coded hosts; Google developer token is operator config. |
| Metrics read | `adsAdapter.ts:829-889,1191-1195` | `getMetrics` per campaign, `lifetime`/`yesterday`, impressions/clicks/spend/ctr/cpc only. **Meta + Google only; TikTok/LinkedIn `unsupported` = CSG-CON-1** (ADR 0357:92-95, deferred until sandbox-verified). Platform date captured (CONN-1). |
| Sync | `features/campaign-connectors/syncService.ts:147-206`; `routes.ts:70-78` | **Only campaigns in openwop's dispatch ledger** (`:158-161`), always `yesterday`, **conversions and revenue hard-coded 0** (`:184-185`); 15 min atomic cooldown; route accepts meta/google. |
| Store | `performanceService.ts:38-76` | natural-key upsert — a re-pull **replaces** the row (MyndHyve wart 3 already avoided). |
| Cadence | `examples/workflow-chain-packs/campaign-sync/pack.json` (`core.openwop.workflows.campaign-sync@1.1.3`, chain `campaign-sync.daily-metrics`); `host/scheduleDaemon.ts:211-216` | sync → notify → pacing chain on an RFC 0052 schedule; scheduled runs carry `actingUserId` so the broker resolves a connection. ADR 0215 forbids a sync daemon. |
| Conversions | `pixelService.ts:23-163`; `routes.ts:152-226`; `adsAdapter.ts:972-1061` | Public relay `POST /host/openwop-app/public/:orgId/conversions`, **marketing-consent gated** (unreadable = refuse); email hashed server-side; dedup `${tenant}:${org}:${eventId}`; age-based retention purger (`:90-100`). Delivery = **user-triggered** `POST …/conversions/dispatch` — Meta + TikTok only, resumable, never double-fires. Google/LinkedIn `unsupported`. Payload: `event_id`, hashed `em`, value, currency only. |
| Defects | `adsAdapter.ts:1042-1050` vs `:670` | **TikTok `sendConversion` uses the default Bearer header**; the TikTok publish path correctly uses `authScheme:'raw', authHeaderName:'access-token'` — so TikTok conversions cannot authenticate. Its body uses `pixel_code` + top-level `event`; Events API 2.0 expects `event_source`/`event_source_id`/`data[]`. |
| Match quality | `pixelService.ts`; `analytics/analyticsService.ts:36-53,152` | No IP / user agent / `fbc` / `fbp` / `ttclid` / `gclid` on relayed events, although analytics already captures fbclid/gclid/ttclid/li_fat_id. |
| Erasure | `features/campaign-connectors/` | **No subject eraser** for relay rows. A hashed email is still personal data; only the age purger touches them. |
| Ownership | ADR 0262 ruling #3; ADR 0266 §1; `hostCapabilityGates.ts:73` | **One ad-egress owner: `campaign-connectors`.** CDP `destination-sync` handles non-ad destinations only. CDP does **not** forward conversions. |
| Attribution | `campaign-intel/attribution.ts:1-23` (ADR 0219) | last-click join; platform-reported and web conversions shown side by side, never summed. |
| Packs | `packs/feature.campaign-connectors.nodes@1.2.1` | `import-csv`, `sync`, `audience-sync`. No conversions node. |
| Tokens | `features/connections/refreshDaemon.ts:64-84`; `examples/connection-packs/{meta,google,tiktok,linkedin}-ads` | central refresh; brokered per user/org/workspace. MyndHyve's token store has no role here. |

### Boundaries audit

- **Ad egress owner:** `campaign-connectors` + `adsAdapter` (ADRs 0262/0266). Every new read and send
  lands there. No CDP destination, no new `conversions` feature.
- **Credential owner:** Connections broker + `refreshDaemon`. No token store.
- **Recurrence owner:** RFC 0052 schedules over chain packs (ADR 0215). No daemon.
- **Consent owner:** `consentService.isAllowed` / `isPermittedForPurpose` (ADRs 0020/0268/0849).
- **Dedup owner:** the relay's keyed store (`pixelService.ts:106-116`) plus the platforms' own
  `event_id` dedup. No second dedup store.
- **Route collision:** new `POST …/campaign-connectors/orgs/:orgId/sync/backfill` and
  `GET …/conversions/health`; `git grep` → none.

## Decision

**D0 — Un-retire the API versions (P0, architect G1 — a live defect this ADR first missed).**
`adsAdapter.ts:64` pins Google Ads **`v18`**; Google sunsets each Ads API version about a year after
release, so by Google's published sunset schedule v18 is past its sunset and every Google read and
upload fails today. LinkedIn `202506` (`:76`) and Meta `v21.0` (`:61`) are checked in the same PR.
Bump to the current supported versions and add a **version-age tripwire test** (a table of pinned
version → sunset date, red 60 days before a sunset) so this cannot rot silently again.

**D1 — Fix TikTok conversions first (P0).** `sendConversion` for TikTok uses
`authScheme:'raw', authHeaderName:'access-token'` and the Events API 2.0 body:
`{event_source:'web', event_source_id:<pixel code>, data:[{event, event_time, event_id,
user:{email:[sha256], phone:[sha256], ip, user_agent, ttclid}, properties:{value,currency},
page:{url}}]}`. Both shapes are confirmed against TikTok's current docs in the P0 PR, and the change
lands with a wire-body test.

**D2 — Sandbox verification is the gate for "honest-ON".** ADR 0357's rule holds: a platform reader or
sender is `unsupported` until exercised against that platform's test surface — Meta `test_event_code`
(Events Manager), TikTok `test_event_code`, Google Ads **test account** with
`validateOnly:true` for uploads, LinkedIn test ad account. Each verification is a recorded,
re-runnable script (`scripts/ads-sandbox-verify.mjs <platform>`) whose transcript is cited in the ADR's
implementation record. This needs real ad accounts (Open decision 1).

**D3 — Metrics depth, through the existing seam.** `getMetrics` gains an **account-scope** form
(`{adAccountId, level:'campaign'|'adset', since, until}`), paged to exhaustion, returning daily rows.
- **Which campaigns:** the connection's ad account(s), not only the dispatch ledger — an agency's
  pre-existing campaigns are the point. Opt-in per connection (`syncScope:'dispatched'|'account'`,
  default `dispatched` so nothing changes silently).
- **Columns:** conversions + revenue. Meta: `actions` / `action_values` filtered by a per-connection
  `conversionActionTypes` list (default `offsite_conversion.fb_pixel_purchase`, `lead`,
  `complete_registration`); Google: `metrics.conversions`, `metrics.conversions_value`.
  The `0` placeholders go away; a platform that cannot report them writes `null`, never `0`.
- **Window:** every daily run re-pulls a rolling **7-day look-back** (late conversions settle);
  the natural-key upsert replaces rows. **Backfill:** a bounded one-off (≤ 90 days, budgeted, resumable)
  via the new route.
- **Rate limits:** the per-tenant/platform circuit breaker (`adsAdapter.ts:1320-1328`) wraps reads too,
  with `429`/`Retry-After` honoured.

**D4 — Close CSG-CON-1: TikTok + LinkedIn readers.** TikTok `report/integrated/get/`
(`report_type:BASIC`, `data_level:AUCTION_CAMPAIGN`, `stat_time_day`), LinkedIn `/rest/adAnalytics`
(`q=analytics`, `pivot=CAMPAIGN`, `timeGranularity=DAILY`), with `costInLocalCurrency` taken as major
units (MyndHyve wart 10 not ported). Honest-ON only after D2.

**D5 — Google conversions via Google Ads `uploadClickConversions`.** Per pixel config:
`conversionAction: customers/{cid}/conversionActions/{id}` (an id, never an event name — wart 6),
`gclid`/`gbraid`/`wbraid` from the analytics click capture, hashed `userIdentifiers`
(email, E.164 phone) for enhanced conversions for leads, `conversionDateTime` in the account's
timezone format `yyyy-mm-dd hh:mm:ss±hh:mm`, `partialFailure:true` with per-row error mapping. The
developer token stays operator config (unchanged); the OAuth token stays brokered. EEA consent
signals (`consent.adUserData`, `consent.adPersonalization`) are mapped from the relay's consent
state for every row — confirmed against Google's current upload docs in the P4 PR.
LinkedIn Conversions API is **net-new beyond the MyndHyve baseline** and is P7, optional.

**D6 — Match quality without new PII exposure.**
- The relay intake records the request's **IP** (from the trusted-proxy chain, ADR 0851) and
  **user agent** — Meta requires both for `action_source:'website'` — plus click ids passed by the
  pixel snippet: `fbc` built as `fb.1.<click-ms>.<fbclid>` from the **click** time (wart 7),
  `fbp`, `ttclid`, `gclid`/`gbraid`/`wbraid`.
- Phone normalised to E.164 then hashed **without `+`** for Meta/TikTok; Google uses its documented form.
- All of it sits under the existing confidential-PII retention class; IP and UA are dropped from the
  row once every platform has the event (`delivered` for all targets), so they live hours, not days.

**D7 — Scheduled conversion delivery as a chain, consent re-checked at send.** New chain
`campaign-sync.conversions-dispatch` in the `campaign-sync` pack (1.2.0), node
`feature.campaign-connectors.nodes.dispatch-conversions`, declared `role:"side-effect"` +
`capabilities:["side-effectful"]` with `SERVED-SET-BASELINE.json` regenerated — the ADR 0627 D1 guard
is the classification. A `mode:'replay'` fork serves the recorded outcome; a `branch` fork re-runs
live by design and is safe because delivery is per-row resumable and never fires a platform twice
(`pixelService.ts:137-163`). Paired with an RFC 0052 schedule, **hourly** by default (a 15-minute
cadence is 96 runs per org per day against the run quota, mostly empty; Meta accepts events up to 7
days old). Before sending each queued event the node **re-checks consent** with the intake's
`marketingAllowedOrUnreadable` (unreadable = refuse), which is **hoisted from `routes.ts:37` into
`pixelService.ts`** so the route and the node call one function, not a copy; a withdrawn consent drops the
row instead of sending. The existing manual dispatch route stays.

**D8 — Erasure.** Register a subject eraser for relay rows keyed by the consent visitor key and by
email hash (ADR 0464 store census), and add the store to the census test so the completeness check
covers it.

**D9 — Daily metrics chain picks up the new readers.** `campaign-sync.daily-metrics` 1.1.0:
`platform` enum gains `tiktok`, `linkedin` (only once honest-ON), new `syncScope` param; the
schedule pairing is unchanged. Insights consumers (`campaign-intel`, attribution) read conversions
from the store and keep the never-sum rule (ADR 0219).

### Rejected

- **Port MyndHyve's `conversions-api` service, `/track` endpoint or `conversion_events_dedup`.** A
  second ad-egress owner, contradicting ADR 0262 #3, and the existing relay is already consent-gated.
- **Port the per-user KMS token store.** The broker + refresh daemon own credentials; wart 5
  (browser-held tokens) is the exact failure the broker exists to prevent.
- **Route conversions through CDP `destination-sync`.** ADR 0266 §1 keeps ad destinations out of it.
- **GA4 Measurement Protocol instead of Google Ads upload.** A web-analytics hit, not an ads
  conversion; attribution to a click requires the Ads upload.
- **A sync daemon / Cloud Scheduler job.** ADR 0215 — the chain + schedule is the one recurrence.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `features/campaign-connectors/` + `host/adsAdapter.ts` (existing owner). No core edits. |
| 2 | Toggle + admin UI | `campaign-connectors` unchanged. Per-connection `syncScope`, `conversionActionTypes`, Google `conversionActions` map in the existing connector settings. |
| 3 | Workflow surface | `ctx.ads.getMetrics` gains the account-scope form; `ctx.ads.sendConversion` gains Google. Both behind the existing toggle + `workspace:write` for sends. |
| 4 | Node pack | `feature.campaign-connectors.nodes` 1.3.0: `dispatch-conversions` (new, `side-effect` + `side-effectful`); `sync` gains `syncScope` + look-back. |
| 5 | AI chat + envelopes | None new. The Analyst agent reads conversions through its existing performance tools. |
| 6 | Agent pack | Unchanged; its tool descriptions mention conversions now populated (prompt parity test). |
| 7 | Public surface | Relay intake gains optional `fbc`/`fbp`/click-id fields; same consent gate, payload caps and 202-never-error behaviour. |
| 8 | RBAC | Sync/backfill/dispatch `workspace:write`; health `workspace:read`; scheduled runs act as the schedule owner (broker connection resolution, existing). |
| 9 | Replay / fork | Send node classified `side-effect` (recorded outcome on replay forks; row-state idempotent on branch forks); sync is idempotent by natural key, so a replayed sync converges. |
| 10 | Frontend | Connector settings fields; performance views show conversions/revenue/ROAS with "platform-reported" labels; a conversions health card (queued / delivered / failed by platform, last error). |

## Implementation plan — one mergeable PR per phase

Each phase is an independently mergeable PR off `origin/main`, gated by `npm run ci`, citing
`ADR 0907 P<k>` in its commits, and adding a row to an implementation record in this ADR when it
lands. **Track 1 needs no new spend, vendor account or credential and is ordered first so it ships
regardless; Track 2 phases wait on the named Open decision.** Phases within one ADR that touch
the same large file (noted) merge serially, not in parallel. A pack version bump in any phase
needs the registry republish that `check-pack-version-bump` names.

**Honesty rule for every phase:** code may merge before sandbox verification, but a reader or sender
stays `unsupported` (honest-OFF) until its D2 sandbox transcript is recorded — so Track 1 merges are
safe without accounts, and Track 2 is only the flip to ON.

### Track 1 — no new spend or accounts (ship in this order)

**P0 — live defects + erasure.** (S, 2 d) · David: no.
- Owns: `host/adsAdapter.ts` (D0 version bumps — Google Ads to the current supported version, LinkedIn
  and Meta checked; D1 TikTok `access-token` header + Events API 2.0 body); new
  `test/fixtures/ads-api-versions.json` (pinned version → sunset date);
  `features/campaign-connectors/pixelService.ts` (subject eraser + hoisted
  `marketingAllowedOrUnreadable`); `features/campaign-connectors/routes.ts` (imports it).
- Tests: `test/ads-api-version-age.test.ts` (red 60 days before a sunset); `test/ads-tiktok-conversion-wire.test.ts`
  (header + body golden); `test/campaign-connectors-relay-erasure.test.ts`; erasure census
  (`missingSubjectErasers`) green with the new store.

**P1 — sandbox-verification harness.** (S, 1–2 d) · David: no to merge (runs later with accounts).
- Owns: new `scripts/ads-sandbox-verify.mjs <platform> <check>` (Meta/TikTok `test_event_code`, Google
  `validateOnly`, LinkedIn test account; writes a transcript under the session scratchpad, never prod).
- Tests: `test/ads-sandbox-verify-script.test.ts` (fake platform servers; refuses a non-test account id).

**P2 — metrics depth (Meta, Google).** (M, 4–5 d) · David: no to merge.
- Owns: `host/adsAdapter.ts` (`getMetrics` account-scope form, paging, conversions/revenue, `null` not
  `0`, breaker on reads, `Retry-After`); `features/campaign-connectors/syncService.ts` (`syncScope`,
  7-day look-back, backfill ≤ 90 d resumable); `features/campaign-connectors/routes.ts`
  (`…/sync/backfill`); `features/campaign-connectors/types.ts`; connector settings FE
  (`CampaignConnectorsPage.tsx`, `campaignConnectorsClient.ts`, `i18n/*`);
  `examples/workflow-chain-packs/campaign-sync` 1.2.0 (`syncScope` param) + `packs/feature.campaign-connectors.nodes`
  1.3.0 (`sync` args).
- Tests: `test/ads-metrics-account-scope.test.ts` (pages to exhaustion; late update replaces;
  `null` conversions); `test/campaign-sync-backfill.test.ts` (resume, cap, cooldown); chain-config
  conformance + pack parity tests.

**P3 — TikTok + LinkedIn readers (code).** (M, 3–4 d) · David: no to merge; stays `unsupported` until P6.
- Owns: `host/adsAdapter.ts` (TikTok `report/integrated/get/`, LinkedIn `adAnalytics` with
  `costInLocalCurrency` as major units) behind a per-platform verified flag.
- Tests: `test/ads-metrics-tiktok-linkedin.test.ts` (fake servers; unit handling; still `unsupported`
  while unverified).

**P4 — Google click conversions + match quality (code).** (M, 4 d) · David: no to merge; Google send
stays `unsupported` until P6.
- Owns: `host/adsAdapter.ts` (`uploadClickConversions`, conversion-action mapping, timezone format,
  `partialFailure`, EEA consent fields); `features/campaign-connectors/pixelService.ts` (IP/UA/click
  ids/E.164, IP+UA dropped once delivered); `features/campaign-connectors/routes.ts` (relay intake
  fields, trusted-proxy IP); pixel settings FE.
- Tests: `test/ads-google-conversion-upload.test.ts` (wire golden, id not name, timezone, consent
  fields); `test/conversion-match-quality.test.ts` (fbc from click time, phone hashing per platform,
  IP/UA lifetime).

**P5 — scheduled consent-rechecked delivery.** (S–M, 2–3 d) · David: no.
- Owns: `packs/feature.campaign-connectors.nodes` (`dispatch-conversions`, `role:"side-effect"` +
  `side-effectful`) + `SERVED-SET-BASELINE.json` + floor regen; `examples/workflow-chain-packs/campaign-sync`
  (chain `campaign-sync.conversions-dispatch`, hourly suggestion); `features/campaign-connectors/surface.ts`;
  conversions health card FE + `GET …/conversions/health`.
- Tests: replay-fork witness through the real executor (sends nothing); branch fork sends only queued
  rows; withdrawn consent drops the row; health route `workspace:read`.

### Track 2 — needs David

**P6 — sandbox verification → honest-ON.** (S per platform, 1 d each) · David: **yes** — test ad
accounts + Google developer token + LinkedIn MDP access (Q1). Run `ads-sandbox-verify.mjs` per
platform, attach transcripts, flip each verified reader/sender ON (closes CSG-CON-1 for TikTok and
LinkedIn).

**P7 — LinkedIn Conversions API (optional, net-new).** (S–M, 2–3 d) · David: **yes** — product scope (Q3)
+ LinkedIn access.

## Implementation record

Track 1 shipped as one ordered merge train: each phase is a PR whose branch contains the phases before it.
Every reader and sender is tested against local fixture servers: no real ad platform was called and no
real token was used.

| Phase | PR | Commit | What landed |
|---|---|---|---|
| P0 + P1 | #4920 | merged `eec6dda99` | D0: the version table `host/adsWire.ts` `ADS_API_VERSIONS` (Google Ads v18 → **v26**, Meta Marketing API v21.0 → **v25.0**, LinkedIn 202506 → **202610**, TikTok v1.3 with a review-by date) and the 60-day tripwire `test/ads-api-version-tripwire.test.ts`. D1: TikTok `Access-Token` header, the Events API 2.0 body, and a 200 with a non-zero `code` treated as failure. D8: `eraseCampaignConversions` (manifest + census ledger). P1: `scripts/ads-sandbox-verify.mjs`, written and not run (test: `ads-sandbox-verify-script.test.ts`, fake servers). |
| P2 | #4935 | merged `a0bb212e6` | D3: `getAccountMetrics` (Meta/Google, paged by cursor/`pageToken`, `truncated`, conversions + revenue, `rate_limited`, breaker on reads); connector settings (`dispatched` default / `account`); 7-day look-back with legacy-row replacement; resumable backfill ≤ 90 d. D9: chain `daily-metrics` 1.1.0, node pack 1.3.0. |
| P3 | #4936 | merged `9722222e6` | D4: TikTok + LinkedIn readers, `unsupported` until `OPENWOP_ADS_VERIFIED_READERS`; `conversions`/`revenue` are `number \| null` end to end; `brokeredFetch` gains `authHeaderName`. |
| P4 | #4937 | `7aa0b2599` | D5: Google `uploadClickConversions`; D6: IP/UA/fbc/fbp/ttclid/E.164 phone; `conversionDelivery.ts`; TikTok + Google senders `unsupported` until `OPENWOP_ADS_VERIFIED_SENDERS`. |
| P5 | #4938 | `f5912902c`, `3bf83bd69`, `9343feb0a`, `0ca4db887` | D7: chain `campaign-sync.conversions-dispatch` + node `dispatch-conversions` (`side-effect` + `side-effectful`, served set + floor regenerated); consent re-checked at send; health route + card; the lead amendment (below). |

**Corrections to the decisions above, from implementation (the reasoning trail is kept, not rewritten):**

- **D0: the Meta premise was half right.** Marketing API v21.0 expired 2025-09-09, but Meta began
  auto-upgrading expired versions on 2026-07-29. So v21 may not have been failing hard when this ADR was
  written. It was bumped anyway, and the table marks its v25.0 sunset as `estimated` with a review-by date,
  because Meta lists it as TBD.
- **D0 found a second Google defect the ADR missed.** Since 2026-04-01 Google refuses any campaign create
  that lacks `containsEuPoliticalAdvertising`, on every API version. `publishAd` now takes
  `euPoliticalAdvertising`. It is never defaulted, because it is an attestation: a live Google dispatch
  without it fails closed (`missing_eu_political_declaration`) before the spend gate. Passing it through
  the `campaign-channels` publish node is a gap filed against that feature. *(Closed 2026-10-19: `publish-ad-variants` 1.3.0 passes `euPoliticalAdvertising`
  through as given. It refuses a malformed value, maps a missing one to a typed
  `eu_political_declaration_required`, and never defaults it. No campaign or org field exists to
  default from.)*
- **D1 fixed the TikTok sender but did not switch it on.** Per D2, a sender with no sandbox transcript
  stays `unsupported`. The fixed TikTok sender has never been exercised against TikTok, so P4 gated it
  together with Google. Meta CAPI (ADR 0297) stays live.
- **D3 shape:** account scope is a separate `getAccountMetrics` method, not an overload of `getMetrics`.
  It has a different result union and its own `ADS_METHOD_FEATURE` gate entry.
- **D3 `null`:** no Meta or Google column needed `null`. **TikTok revenue is `null`**, because no TikTok
  revenue metric could be confirmed against documentation. The KPI computes ROAS/CPA only over reporting
  rows and returns `unreported`. campaign-intel leaves null-revenue rows out of the optimizer; without
  that, it cut TikTok's budget by 60% for "ROAS 0×", witnessed.
- **D5 consent:** both Google signals map from the relay's marketing consent. A row exists only with
  that consent, and P5 re-checks it at send.
- **D7 placement:** the `marketingAllowedOrUnreadable` hoist landed in P5 with its second caller, not in P0.
- **D7 lead amendment (2026-10-17).** Delivering Meta conversions hourly from deploy would be a
  production behaviour change and could flush an old backlog, so:
  - (a) scheduled delivery is OFF by default behind the `campaign-connectors.scheduled-conversions`
    sub-toggle (`resolveOne`, AND-ed with the parent). While off, the run is a `disabled` no-op.
  - (b) no event older than its platform's window is sent (Meta/TikTok 7 d, Google 90 d). It becomes
    `expired` / `outside_platform_window`.
  - (c) a row the manual ADR 0297 path already delivered is never re-sent, and a re-posted eventId stays
    one row.
- **Pack pins:** since ADR 0919 the node-pack versions this train bumps (1.3.0 → 1.4.0 → 1.5.0) live in
  `features/packPins.ts`, not in `feature.ts`.
- **No second compliance path:** ADR 0933 (campaign-ops content rules) owns ad-copy compliance. 0907
  adds no rule and no gate. `publishAd` still asks only the existing `setAdsComplianceChecker` hook, and
  the EU political declaration above is a Google API attestation, not a content rule.
- **Seeded-chain ceiling:** `campaign-sync.conversions-dispatch :: orgId` is a declared +1 (124 → 125) in
  `seeded-chain-unfilled-params.test.ts`. It is schedule-paired, there is no honest default org, and a
  param-less copy fails closed with a typed `validation_error` (witnessed). a0's #5022 adds its own +2;
  whichever lands second carries the sum.
- **Gaps found, not fixed here:** `packs/vendor.myndhyve.ads-publish-{meta,google}` still pin `v21.0` /
  `v18`. That is a second, signed ad-egress path, and the tripwire does not cover it. The vendored chain
  and node packs are registry-pinned in production, so they need a registry publish to ship. *(CORRECTED 2026-10-19: false. Prod's `OPENWOP_INSTALL_PACKS` names no campaign pack.
  `feature.campaign-connectors.nodes` ships in the image (`Dockerfile` `COPY packs`). `campaign-sync` ships from
  `examples/workflow-chain-packs`, and the loader's version-aware tie-break (WF-DUP-2) would prefer the newer
  vendored copy even over an installed registry copy. Neither needs a registry publish; `check-pack-pin-drift`
  reports none unshipped. The claim came from that script's docstring without checking whether these packs are pinned.)*

**Track 2 is still open** (§ Open decisions for David):
- **P6:** run `ads-sandbox-verify.mjs <platform> conversion|metrics|google-upload` on test accounts,
  attach the transcripts here, then list the platforms in `OPENWOP_ADS_VERIFIED_READERS` /
  `OPENWOP_ADS_VERIFIED_SENDERS`.
- **P7:** LinkedIn CAPI.
- Enabling `campaign-connectors.scheduled-conversions` per workspace is a separate product decision.

## Tests

Per-phase tests are named in the implementation plan above. Every phase lands red-first:
the failing test is committed before the fix, so each PR shows the defect and its closure.

## Open decisions for David

1. **Vendor accounts + credentials:** test ad accounts for Meta (Events Manager test code), TikTok
   (advertiser sandbox), Google Ads (test manager account + an approved **developer token** —
   Basic access needs Google's application review) and LinkedIn (Marketing Developer Platform
   access). Without them, D2 cannot pass and readers stay honest-OFF.
2. **Product scope:** is ads in scope for the agency product at all right now? The gap analysis
   recommended "archive; port later if the product expands to ads". This ADR is ready either way;
   P0 (a live auth defect + an erasure gap) is worth doing regardless.
3. **Product scope:** LinkedIn Conversions API (P7) — yes/no.

## Architect review (2026-10-17)

`/architect`, Track A + Track B check. Independent adversarial review; findings verified in code and
**folded into the decisions above**.

| # | Sev | Dimension | Finding | Resolution |
|---|---|---|---|---|
| G1 | HIGH | Failure modes | Google Ads `v18` is pinned (`adsAdapter.ts:64`) and is past Google's published sunset schedule — every Google call fails today. LinkedIn `202506` likely too. | D0: version bump + version-age tripwire in P0. |
| X2 | HIGH | Replay | "Fork-guarded per ADR 0627" misread the ADR (the guard is the classification). | D7: `side-effect` + `side-effectful`; replay-fork witness test. |
| G2 | MEDIUM | Duplication | `marketingAllowedOrUnreadable` is route-local (`routes.ts:37`). | D7: hoisted into `pixelService.ts`. |
| G3 | MEDIUM | Compliance | Google uploads expect EEA consent signals. | D5: mapped from relay consent; confirmed in P4. |
| G4 | MEDIUM | Cost | A 15-minute chain is 96 runs/org/day. | D7: hourly. |
| G5 | LOW | Confirmed | TikTok auth header/body defect (`:1042-1050` vs `:670`) and the missing eraser (`pixelService.ts:92`) are real. | D1, D8. |

**Boundaries:** one ad-egress owner (`campaign-connectors`, ADR 0262 #3 / 0266 §1), broker-owned
credentials, chain + schedule recurrence, one dedup store. MyndHyve's parallel `conversions-api`,
dedup store and token store are rejected, not ported.
**RFC (Track B):** confirmed host-extension.
**Verdict:** Accepted as a plan. P0 is worth doing regardless of the ads product decision: it fixes
live defects (retired Google version, TikTok auth) and an erasure gap.
