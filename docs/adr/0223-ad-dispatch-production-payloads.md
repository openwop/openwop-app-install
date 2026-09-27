# ADR 0223 — Ad dispatch: production payloads, media upload, Customer Match completion, and the LinkedIn strategy

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `host/adsAdapter.ts` (all four `PlatformStrategy` pipelines + `syncAudience`), `feature.campaign-channels.nodes.publish-ad-variants` (new inputs), `executor/types.ts` `ctx.ads` |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5C **C1** — finishes ADR 0167's payload seam; also closes ADR 0217's Google Customer Match member-upload deferral |
| **Depends on** | ADR 0167 (the ads-dispatch adapter + every invariant below), ADR 0217 (`syncAudience` + the approval gate), ADR 0007 (media library — the byte source for the upload legs), RFC 0095 (the `linkedin-ads` connection pack already ships in `examples/connection-packs/`) |
| **RFC gate** | **None.** Same posture as ADR 0167: rides Accepted RFC 0045/0046/0047/0079/0095. This is payload-shape + one more strategy on the existing host seam — nothing touches the wire. |

## Context

ADR 0167 shipped the ads-dispatch **architecture** — broker-composed egress, created-PAUSED,
hardcoded hosts, the fork-stable idempotency ledger, dry-run parity, provenance — but its
"Known limitation" was explicit: the per-platform create bodies were **the dispatch seam, not
production-complete payloads** (they would 400 against the live APIs). Separately, ADR 0217
deferred the Google Customer Match **member upload** (`offlineUserDataJobs`) to this pass, and
the `linkedin-ads` connection pack existed with no dispatch strategy behind it.

## Decision

**Author every create body to the platform's current public API doc shape ("documented-complete"),
add the media-upload legs (Meta, TikTok), complete Customer Match, and add a LinkedIn
`PlatformStrategy` — changing NOTHING about the ADR 0167 spine or its invariants.**

### Honesty statement (read this before claiming "production-ready")

The payloads are **documented-complete**: authored to the platforms' current public API
documentation (Meta Graph v21, Google Ads v18, TikTok Business v1.3, LinkedIn versioned REST
`202506`). **Live-sandbox verification remains an operator step** — none of these bodies has
been posted to a real sandbox ad account from this host; the C1 acceptance criterion ("a
dry-run plan posted verbatim to a sandbox account creates without 400") is the operator's
runbook item, not something this ADR asserts. The safety posture makes that honest: a live
rejection **fails closed** (created-PAUSED throughout, no idempotency record on failure, no
spend), so the worst case of a doc-drift 400 is a clean retry after a payload fix.

### Per-platform deltas

| Platform | What changed |
|---|---|
| **Meta (Graph v21)** | Pipeline is now `[adimages →] campaigns → adsets → adcreatives → ads`. The **real creative object**: `POST act_<id>/adcreatives` with `object_story_spec: { page_id, link_data: { message, name: headline, link: landingUrl, call_to_action: { type, value: { link } }, image_hash? } }` — so **`pageId` is REQUIRED** (a page-published story is the only documented link-ad shape); dispatch AND preview fail closed `missing_page_id` without it (an argument, not host config — unlike the Google developer-token, a plan built without it would be un-postable). The ad now references `creative: { creative_id }` (the inline seam shape is gone). The CTA `type` is a Meta enum — free-text copy CTAs fall back to `LEARN_MORE`. **Media leg:** `mediaAssetId` resolves bytes HOST-side (media-library `assetId` → `storageRef`, or a raw RFC 0055 serve token; tenant-checked) and posts `{ bytes: <base64> }` to `adimages`, threading the returned `image_hash` into `link_data`. Unresolvable ⇒ `media_asset_not_found`, zero platform calls. |
| **Google (Ads v18)** | `landingUrl` is now **REQUIRED** (`finalUrls` is mandatory on a responsive search ad) — fails closed `missing_landing_url` before any call, both modes. The campaign create carries `advertisingChannelType: 'SEARCH'`, `status: 'PAUSED'` (unchanged literal) and explicit `networkSettings` (Google Search + search partners, no Display). The RSA keeps the padded ≥3 headlines / ≥2 descriptions and now always sends `finalUrls: [landingUrl]`. **Customer Match completion (closes the ADR 0217 deferral):** `syncAudience`'s google leg, after `userLists:mutate`, now runs the member upload — `offlineUserDataJobs:create` (`type: 'CUSTOMER_MATCH_USER_LIST'`, `customerMatchUserListMetadata.userList` bound to the created list) → `:addOperations` (`create.userIdentifiers: [{ hashedEmail }]`, **≤ 20 identifiers per operation** per the v18 `UserData` limit; one `:addOperations` call carries all batches at this scale) → `:run`. Hashes only, as before; every leg sends Bearer + `developer-token`; provenance stamped once on the successful `:run`. |
| **TikTok (Business v1.3)** | The adgroup gains the v1.3 required delivery fields: `placements: ['PLACEMENT_TIKTOK']`, `schedule_type: 'SCHEDULE_FROM_NOW'`, `optimization_goal: 'CLICK'`, `billing_event: 'CPC'`, plus `budget_mode: 'BUDGET_MODE_DAY'` + `budget` (major units) when `dailyBudgetMinor` is set. The ad creative gains the **REQUIRED posting identity** — `identity_id: args.identityId` + `identity_type: 'CUSTOMIZED_USER'` (fail closed `missing_identity_id`) — plus `landing_page_url` when a landing URL is present. **Media leg:** `POST /file/image/ad/upload/` with base64 `image_file` (+ `advertiser_id` in the body, as everywhere) → `image_id` → the creative's `image_ids`. |
| **LinkedIn (NEW strategy)** | Host `https://api.linkedin.com` — a hardcoded const like the other three, with the same TEST-ONLY env override (`OPENWOP_LINKEDIN_ADS_API_BASE`). Versioned REST: every call sends `LinkedIn-Version: 202506` + `X-Restli-Protocol-Version: 2.0.0` via `brokeredPost` `extraHeaders` (the broker remains the sole `Authorization` authority — the extraHeaders strip stands). Pipeline: `POST /rest/adCampaignGroups` (**status `DRAFT`** — the non-spending literal at this level) → `POST /rest/adCampaigns` (**status `PAUSED`**, `campaignGroup` urn, `type: 'SPONSORED_UPDATES'`, `costType: 'CPC'`, `locale`, `dailyBudget: { amount: '<major units string>', currencyCode }` when set) → `POST /rest/creatives` (inline `content.textAd` with the copy + `landingPage`, **`intendedStatus: 'PAUSED'`**). **Rest.li id extraction:** LinkedIn returns created ids in the `x-restli-id` (legacy `x-linkedin-id`) **response header**, not the body — the strategy reads the header and chains urns (`urn:li:sponsoredCampaignGroup/…Campaign:<id>`) between steps. LinkedIn's hierarchy maps campaignGroup→campaign→creative onto the adapter's campaignId/adSetId/adId result slots. No rollback (the TikTok posture): a half-built hierarchy is DRAFT/PAUSED = no spend. `PLATFORM_PROVIDER` gains `linkedin: 'linkedin-ads'` (the RFC 0095 pack already ships); `AdPlatform` and both `ctx.ads` inline unions gain `'linkedin'`; the publish node's platform allow-set gains `linkedin`. `getMetrics`/`updateBudget`/`syncAudience` honestly report `unsupported` for linkedin (dispatch-only today). |

### New `PublishAdArgs` (threaded through the node + `ctx.ads`)

`pageId?` (Meta, required for dispatch), `identityId?` (TikTok, required for dispatch),
`mediaAssetId?` (Meta/TikTok optional media leg). `feature.campaign-channels.nodes.
publish-ad-variants` (pack v1.1.0) reads all three from its inputs and passes them through;
its manifest description now documents the per-platform requirements (the fail-closed
`missing_page_id` / `missing_identity_id` / `missing_landing_url` contracts).

### Invariants preserved (the ADR 0167 table, re-affirmed)

- **created-PAUSED is a literal in each mapper**, never an input — Meta/Google `PAUSED`,
  TikTok `DISABLE`, LinkedIn `DRAFT`/`PAUSED`/`intendedStatus: PAUSED`.
- **Hardcoded egress hosts only** — `api.linkedin.com` joins the constant set; the
  `OPENWOP_*_API_BASE` overrides remain TEST-ONLY.
- **Fork-stable idempotency** — `idemKeyFor` now hashes the creative-affecting inputs
  (`pageId`, `mediaAssetId`, `identityId`) **additively** (only when set), so pre-C1 records
  keep matching unchanged inputs while a creative change mints a NEW key (witnessed: a
  different `pageId` on the same brief creates a second campaign, no false reuse).
- **Dry-run parity** — plans include the NEW steps (media upload, `adcreatives`) with
  `<placeholder-id>` chaining (`<image_hash>`, `<adcreatives-id>`, `<image_id>`,
  `<adCampaignGroups-id>`) and ZERO platform calls; media bytes are **REDACTED** from plans
  (plans ride node outputs — never token or creative bytes). The Meta/Google/TikTok
  argument-validation failures (`missing_page_id` / `missing_landing_url` /
  `missing_identity_id`) apply to previews too — an invalid-by-construction plan is not a
  preview worth rendering (config-not-ready, e.g. `no_developer_token`, still previews fine).
- **`stampConnectionUse` per successful pipeline**; no token/creative bytes in
  outputs/events; failures fail closed (no idempotency record → a corrected retry proceeds).

## Alternatives rejected

- **Default targeting specs** (Meta adset `targeting`, LinkedIn `targetingCriteria`) — both
  platforms document targeting as required-or-strongly-defaulted at activation; inventing a
  default geo/audience here is a **spend-shaping decision** the host must not make. Left to
  the operator at activation time (everything is created paused/draft); named below.
- **Multipart upload for TikTok media** — the base64 `image_file` JSON body is the documented
  no-multipart path and keeps `brokeredPost` (JSON-only) as the single egress seam.
- **A LinkedIn rollback leg** — Rest.li DELETEs would need the versioned headers on
  `brokeredFetch` and buy nothing: DRAFT/PAUSED orphans cannot spend (the TikTok precedent).

## Known limitations (honest-incomplete, by name)

1. **No live-sandbox witness** — see the honesty statement; the operator runbook item stands.
2. **Targeting is not authored** — Meta ad sets and LinkedIn campaigns are created without a
   targeting spec; the platforms will require one at activation (which is already a human,
   on-platform step). LinkedIn `locale`/`dailyBudget.currencyCode` assume `en-US`/`USD`
   (the account's real currency wins at activation review). **RESOLVED by ADR 0245
   (2026-07-04):** `PublishAdArgs.targeting` is now an OPERATOR-AUTHORED opaque pass-through
   forwarded verbatim to Meta adset `targeting` / LinkedIn `targetingCriteria` (the host
   never invents a default — spend-shaping is the operator's; validated plain-object +
   size-bounded; additive + canonical in the idempotency key).
3. **Google media assets** — the Google leg has no media upload (the RSA is text-only by
   design here); the Asset service is a follow-on if image/video RSAs are wanted.
4. **LinkedIn reads** — `getMetrics`/`updateBudget`/`syncAudience` report `unsupported` for
   linkedin; dispatch-only until a reporting follow-on.

## Verification

`ads-adapter-meta.test.ts` (8) — creative pipeline + `object_story_spec`, `creative_id`
reference, media upload → `image_hash`, `missing_page_id`, `media_asset_not_found`,
creative-change mints a new idem key, fork-stable reuse, rollback, no_connection.
`ads-adapter-google.test.ts` (7) — networkSettings + mandatory finalUrls,
`missing_landing_url`, the full Customer Match pipeline (job create → 20/20/5 identifier
batches → run) behind the ADR 0217 approval gate, dev-token fail-closed, auth-override guard.
`ads-adapter-tiktok.test.ts` (8) — adgroup delivery fields + budget, identity requirement,
media upload → `image_ids`, raw Access-Token, fork-stable reuse.
`ads-adapter-linkedin.test.ts` (5, NEW) — DRAFT/PAUSED pipeline + versioned headers,
header-id extraction (incl. legacy `x-linkedin-id`), urn chaining, fork-stable reuse,
fail-closed-no-rollback, no_connection.
`ads-adapter-dryrun.test.ts` (7) — all four platforms' plans incl. the new steps, redacted
bytes, placeholder chaining, zero calls.
Plus `campaign-channels-publish-docs.test.ts` (pass-through + linkedin allow-set),
`campaign-sync` / `campaign-audience-suppression` / `campaign-channels-publish` /
`ads-metrics-budget` regressions. Backend `tsc --noEmit` clean.
