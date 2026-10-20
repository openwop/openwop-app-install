# ADR 0953 — Social publishing and scheduling

Status: Proposed

**Date:** 2026-10-19
**Program:** Campaign Studio (ADRs 0941–0962), Tier 2. Plan: the program brief
(David, 2026-10-19). Net-new planning, not a MyndHyve port.
**Feature:** **new feature-package `social-publishing`** (toggle `social-publishing`,
OFF, tenant) plus a host adapter `host/socialAdapter.ts`. Generation stays in
`campaign-channels`.
**Depends on:** 0941 (canonical campaign), 0942 (autonomy gate), 0945 (provenance and
AI-disclosure stamp), 0933 (content rules). **Composes:** 0157/0166 social drafts, 0024
connections broker, RFC 0095 connection packs, 0309/0787/0803 scheduler, 0619 egress
ledger, 0924 version-bound approval, 0921 client accounts, 0448 capability tokens,
0377 dashboard tiles. **Integrates with, not depends on:** 0956 (UTM governance;
until it lands, links use the existing pack UTM helper). **Feeds:** 0949 (social
experiments), 0956 (attribution), 0957
(client reports), 0960 (command center).
**RFC verdict:** **host-extension — no RFC.** See § RFC verdict.

## Context

Campaign Studio can generate social posts and route them through a review gate, but it
cannot publish them. The `publish-social-posts` node writes a Markdown "social calendar"
document for a human to paste into each platform. There is no schedule, no calendar view
and no engagement data.

Competitive frame (brief): GoHighLevel's Social Planner, HubSpot, Hootsuite and Sprout
schedule and post, and HubSpot Breeze offers "review before send vs send automatically".
None of them bind the approval to the exact content version, run each post as a
replayable step with a named agent, or isolate brand, connections and approvals per
client inside one agency workspace.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths under `backend/typescript/src/`.

**What exists (single owners):**

| Concept | Owner | Evidence |
|---|---|---|
| Post generation | `campaign-channels` | channel `social_posts`, per-item refine (`features/campaign-channels/channelWorkflows.ts:28`); chain `campaign-studio.channel.social-posts` (`examples/workflow-chain-packs/campaign-channels/pack.json:233`) |
| "Publish" today | `feature.campaign-channels.nodes.publish-social-posts` | writes a DRAFT `campaign-social-calendar` document, "no live social dispatch" (`packs/feature.campaign-channels.nodes/pack.json`; ADR 0166 `:45`) |
| Brokered egress | `host/brokeredEgress.ts` | `brokeredPost` (`:70`, string body), `brokeredFetch` with `apiHosts` pinning (`:146-175`) |
| Egress dedup | `host/egressSentLedger.ts` | `EgressChannel = sms \| push \| voice \| chat \| data \| a2a` (`:47`), reserve/record/release (used by `host/smsAdapter.ts:90-106`) |
| Platform adapter pattern | `host/smsAdapter.ts`, `host/adsAdapter.ts` | sms: one provider, ledger-keyed (`smsAdapter.ts:45-108`); ads: per-platform strategy table (`adsAdapter.ts:825`), provenance stamp, hardcoded hosts |
| Scheduler | `host/schedulingService.ts`, `host/scheduleDaemon.ts` | `registerJob` (`schedulingService.ts:583`), one-shot sentinel `ONE_SHOT_CRON` + `firstFireAtMs` (`:61`, ADR 0309), horizon 366 days (`host/cronSchedule.ts:34`), fire-once (`scheduleDaemon.ts:95`, ADR 0787) |
| One-shot precedent | `features/scheduled-agent-chats/agentTools.ts` | `cronExpr: ONE_SHOT_CRON` (`:137`) |
| Approvals | `host/approvalService.ts` | `APPROVAL_KINDS` incl. `content-publish` (`:40-52`) |
| Inbound webhooks | `features/connections/inboundWebhooks.ts` | `registerInboundObserver` (`:323`); `InboundProvider` is a closed union (`:65`) |
| Connection packs | `examples/connection-packs/` | `meta-ads`, `linkedin-ads`, `tiktok-ads`, `google-ads` (ads scopes only); built-in `google` provider (`features/connections/providerRegistry.ts:140`). **No** Pages/Instagram publish, X, TikTok Content, or YouTube provider |
| Analytics | `features/analytics/analyticsService.ts` | `EventType = pageview \| event \| conversion` (`:36`) |
| Dashboard | `frontend/react/src/features/dashboard/allTiles.ts` | dashboard-owned tile registry (ADR 0377) |
| Month grid UI | `frontend/react/src/features/crm/BookingMonthGrid.tsx` | CRM-local; not in `ui/` |

**Findings:**

| # | Finding | Evidence |
|---|---|---|
| S1 | ADR 0166 calls live social dispatch "RFC-gated". ADR 0167 later showed the same claim for ads was wrong (outbound actions ride Accepted RFC 0045/0046/0047/0079/0095). The same reasoning applies to social | `0166…md:23-25,80,100`; `0167…md:9,13-19` |
| S2 | No social provider or pack exists; the ads packs carry only ads scopes | `meta-ads/pack.json` scopes `ads_read`, `ads_management` |
| S3 | The broker sends string bodies only; video upload to YouTube, LinkedIn and X needs binary or resumable upload | `brokeredEgress.ts:51-53,153-160` |
| S4 | `EgressChannel` has no `social` value | `egressSentLedger.ts:47` |
| S5 | No calendar primitive in `ui/`; the only month grid is CRM-specific | `BookingMonthGrid.tsx` |
| S6 | `campaign-brief`'s free-text product and the creative pipeline give posts no product-image provenance; ADR 0945 owns the fix, this ADR consumes it | brief § seam map |

**Precedent kept:** ADR 0404 built the webinars connector as a new adapter and
deliberately did **not** overload `AdsAdapter` (`features/webinars/feature.ts:1-8`).
Organic posting is a different contract from paid dispatch (no spend, a different
consent, a different rate-limit model), so it gets its own adapter on the same broker.

## Decision

### D1 — `socialAdapter` on the brokered-egress spine

```ts
// host/socialAdapter.ts — ctx.social (host API; not wire)
export type SocialPlatform = 'facebook-page' | 'instagram' | 'linkedin' | 'x' | 'tiktok' | 'youtube';
interface PublishPostArgs {
  platform: SocialPlatform; accountRef: string;        // page id, IG user id, org urn, channel id…
  text: string; link?: string;                          // link already UTM-stamped (0956)
  media?: Array<{ mediaAssetId: string; kind: 'image' | 'video' }>;
  aiDisclosure: { aiGenerated: boolean; label?: string };
  idempotencyKey: string;                               // `social:<postId>:<contentHash>`
}
type PublishPostResult =
  | { outcome: 'published'; platformPostId: string; url?: string }
  | { outcome: 'processing'; platformRef: string }      // async video containers
  | { outcome: 'no_connection' } | { outcome: 'unsupported'; platform: SocialPlatform; reason?: 'not_sandbox_verified' | 'app_not_audited' }
  | { outcome: 'rate_limited'; retryAfterS?: number } | { outcome: 'failed'; error: string };
interface SocialAdapter {
  publishPost(a: PublishPostArgs): Promise<PublishPostResult>;
  getPostStatus(a: { platform: SocialPlatform; platformRef: string }): Promise<…>;
  getPostMetrics(a: { platform: SocialPlatform; platformPostId: string }): Promise<…>;
  deletePost(a: { platform: SocialPlatform; platformPostId: string }): Promise<…>; // gated, D4
}
```

- **Per-platform strategies**, each owning its wire shape, with a pinned version table
  like `adsWire.ts` and a sandbox-verify harness. Hosts are hardcoded; tokens never
  leave the broker; `stampConnectionUse` on every success (RFC 0079 provenance).
- **Dedup:** `EgressChannel` gains `'social'` (S4). `publishPost` reserves the ledger key
  before the call and records the platform post id on success, the `smsAdapter.ts:90-106`
  pattern. A retry, a re-fire of the same job or a `:fork` can never post twice.
- **Media.** v1 posts by **pull-from-URL** where the platform supports it (Instagram,
  Facebook, TikTok `PULL_FROM_URL`): the media asset is exposed through a short-lived,
  single-asset capability URL (ADR 0448), revoked after the post. LinkedIn, YouTube and X
  need binary or resumable upload; the broker gains a `brokeredUpload` (Buffer body,
  chunked, same `apiHosts` pinning, ADR 0167's `authHeaderName` precedent). Until that
  ships those platforms are text/link-only and say so.
- **Honest platform limits.** TikTok's Content Posting API and YouTube uploads from an
  unaudited/unverified app can only post privately. The adapter reports
  `unsupported: app_not_audited` rather than posting privately and calling it published.

### D2 — Connections: extend where the vendor app is the same, new packs where not

| Platform | Pack | Change |
|---|---|---|
| Facebook Page + Instagram | `meta-ads` (provider `meta-ads`) | add write scope group `social.publish` (`pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`) |
| LinkedIn | `linkedin-ads` | add scope group `social.publish` (`w_organization_social`, `r_organization_social`) |
| TikTok | **new** `tiktok-content` | TikTok for Developers (a different app and host from the Business API pack) |
| X | **new** `x` | OAuth 2.0 PKCE, `tweet.write`, `tweet.read`, `users.read`, `media.write` |
| YouTube | **new** `youtube` | Google OAuth with `youtube.upload`, `youtube.readonly`; separate from the built-in `google` provider so consent is explicit (Q3) |

Scope groups are consented incrementally (ADR 0024 Phase C), so an ads-only connection
never gains publish rights silently. Connections are pinned **per client org** (ADR 0921
D4); a post for client A cannot resolve client B's page token. Every pack ships with
no secrets; the operator supplies app credentials host-side (ADR 0024 §7).

### D3 — Data model and state machine

```ts
// features/social-publishing — DurableCollection('social:post'), key tenant::orgId::postId
interface SocialPost {
  postId: string; tenantId: string; orgId: string;
  campaignId?: string;                     // MarketingCampaign.id (0941)
  source?: { runId: string; nodeId: string; itemIx: number };   // the generating run
  platform: SocialPlatform; connectionId: string; accountRef: string;
  text: string; link?: string; media: Array<{ mediaAssetId: string; kind: 'image' | 'video' }>;
  contentHash: string;                     // sha256 over text, link, media ids, accountRef
  provenance?: AssetProvenanceRef;         // from 0945; drives aiDisclosure
  aiDisclosure: { aiGenerated: boolean; label?: string };
  scheduledFor?: string;                   // ISO; absent = publish when approved
  status: 'draft' | 'pending_approval' | 'scheduled' | 'publishing' | 'processing'
        | 'published' | 'failed' | 'canceled';
  approval?: { approvalId: string; contentHash: string; decidedBy?: string };
  jobId?: string;                          // the one-shot scheduler job
  platformPostId?: string; url?: string; publishedAt?: string;
  lastError?: { code: string; at: string };
  version: number; createdBy: string; createdAt: string; updatedAt: string;
}
```

Every transition is a `compareAndSwap` on `version`, not a check-then-write: a legal
transition table only rejects writes it sees. **Any edit to text, link, media or account
changes `contentHash`, voids the approval and returns the post to `draft`** (ADR 0924's
version-bound approval).

### D4 — The 0942 gate, per post

Action class `social.post` (ADR 0942 D1). The campaign's frozen policy decides per post:
`auto` (within limits, e.g. organic only, no regulated category), `approve(role, quorum,
SLA)`, `notify-after`, or `blocked`. Approval binds `contentHash`. At fire time the
publish node re-reads the post and refuses with `approval_stale` if the hash moved.
Deleting a published post is its own gated action (`social.post` with `op: delete`),
because a delete is also public. Content rules (ADR 0933) run before the approval
request, so the approver sees the rule results.

### D5 — Scheduling rides the one scheduler

Scheduling a post registers **one one-shot job** (`ONE_SHOT_CRON`, `firstFireAtMs =
scheduledFor`, `featureId: 'social-publishing'`, `ownerSubject` = the scheduling user)
that fires the chain **`social.publish-post`** with `inputs: { postId }`. This is the ADR
0309 / scheduled-chats precedent. Rescheduling deletes and re-registers the job under a
CAS on the post. Fire-once comes from ADR 0787; the ledger key in D1 is the second guard.
Posts beyond the 366-day horizon are refused at schedule time.

`social.publish-post` (chain pack `core.openwop.workflows.social-publishing`):
`get-post` → `content-rules` (re-check; content may predate a rule change) →
`feature.campaign-orchestration.nodes.autonomy-gate` (0942, class `social.post`;
`approval_stale` / `blocked` end the run as typed failures) →
`publish-post` (`role: side-effect`) → `record-result`. A `processing` result (video
containers) schedules a bounded status poll on the same chain.

Bulk calendars (hundreds of posts) are a known cost of one job per post. ADR 0803 keeps
the daemon from scanning every job each tick; the open question is a per-org cap (Q5).

### D6 — Generation hands off; it does not post

`campaign-channels` stays the generator. `publish-social-posts` gains a mode: when the
org has a connected, verified social account and `social-publishing` is on, it creates
`SocialPost` drafts (deterministic `postId` from `runId:nodeId:itemIx`) instead of only a
document. The document handoff stays as the honest fallback when nothing is connected.
The ADR 0166 "RFC-gated" note gets a correction pointing here (S1).

### D7 — Content calendar

`/social` → a calendar (month/week) plus a list, filtered by client org, campaign,
platform and status. Drag to reschedule (CAS + job re-register), approve/reject inline
through the one approvals inbox, and a preview per platform with character and media
limits from `platformLimits.mjs` (`packs/feature.campaign-channels.nodes/`).

The calendar is **cross-channel but read-only for others**: a registry seam
`registerCalendarSource(id, fn)` in `social-publishing` lets ADR 0955 (email/SMS sends),
ADR 0952 (ad flights) and the CMS scheduled publish (`features/cms/publishSweep.ts`)
contribute entries without social-publishing importing them. Each entry links back to
its owner's editor; only social posts are edited here. The month grid is promoted from
`BookingMonthGrid` into `ui/` if the shapes fit (Q6); otherwise a new `ui/` component.

### D8 — Engagement read-back

Chain `social.metrics-sync` (scheduled, every 6 h; 1 h for posts under 48 h old) calls
`getPostMetrics` and writes daily rows to `DurableCollection('social:post-metric')`:
`{ postId, day, impressions, reach, likes, comments, shares, saves, clicks, videoViews }`,
each **`number | null`**, where null means the platform did not report it (ADR 0907's
honesty rule). This is NOT the ads performance store: that store's `spend` and
`AdPlatform` semantics would make an organic post's spend read as a measured zero.
Clicks to our pages arrive through UTM-stamped links into analytics and 0956
attribution. A `social` dashboard tile is registered in `allTiles.ts`. Metrics are
retained 13 months and erased with the post.

### D9 — AI disclosure

`aiDisclosure.aiGenerated` is **derived** from the 0945 provenance stamp; a user cannot
set it to false for media the stamp says is generated. On platforms whose API exposes a
flag (TikTok's AIGC flag, YouTube's synthetic-media status field), the strategy sets it,
after sandbox verification of the exact field. Elsewhere the org's brand kit chooses a
caption label (default "Made with AI"), and C2PA metadata from 0945 travels with the
media where the platform keeps it. The publish result records which mechanism was used.

### D10 — Agent

No new persona (ADR 0943 owns the roster). The posting tools ship in this
feature and are pack-allowlisted on two existing roles: the **Copywriter** gets
`openwop:social.list-posts`, `openwop:social.get-post` (read) and
`openwop:social.draft-post`; the **Producer** also gets
`openwop:social.schedule-post` (a schedule request; scheduling an unapproved post
sends it into the gate). Neither has a publish tool. Each reads before it writes
(the brief, the brand kit, the post).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | New `src/features/social-publishing/` (service, routes, feature.ts, surface, agentTools, erasure); `host/socialAdapter.ts` (host may not import features); appended to `BACKEND_FEATURES` / `FRONTEND_FEATURES`. |
| 2 | Toggle | `social-publishing`, default OFF, `bucketUnit: 'tenant'`, `dependsOn: ['campaign-channels']`, `recommends: ['campaign-orchestration', 'media']`. Each platform is also gated on its pack being configured and sandbox-verified. |
| 3 | Workflow surface | `ctx.social` (adapter); `ctx.features['social-publishing']`: `getPost`, `createDraft`, `requestSchedule` (no publish method). |
| 4 | Node pack | `feature.social-publishing.nodes`: `get-post`, `create-draft`, `request-schedule`, `publish-post` (side-effect), `poll-status`, `sync-metrics`, `record-result`. Chains: `social.publish-post`, `social.metrics-sync`. |
| 5 | AI chat + envelopes | Chat tools only (D10). No new envelope kind. |
| 6 | Agent pack | None new; the ADR 0943 Copywriter and Producer get the D10 tools by allowlist. |
| 7 | Public surface | None, except the short-lived single-asset media URLs (ADR 0448 capability tokens, revoked after post, rate-limited per ADR 0934). |
| 8 | RBAC | Routes `/v1/host/openwop-app/social/orgs/:orgId/…` through `authorizeOrgScope`; read `workspace:read`, draft/schedule `workspace:write`; approve per the 0942 role; connections pinned per client org; by-id reads compare `orgId` first (uniform 404). |
| 9 | Replay / fork | Policy frozen at run start; `postId` and ledger key deterministic; `publish-post` is side-effect and ledger-deduped, so a fork returns the recorded post id. |
| 10 | Frontend | `features/social-publishing/`: calendar + list, composer with per-platform preview, approval inline, metrics per post; nav under Marketing; 4 locales; tokens only. |

## Why this is our advantage

- **Each post is a replayable run step** with the generating agent, the rule checks and
  the human approval on one record (thesis 1–3). "Who approved this caption, against
  which rules, from which source image?" has an answer.
- **Approval bound to the exact content**: edit a word and the approval is gone. Breeze's
  per-play review and GHL's planner approve a post, not a version.
- **Per-client isolation in one agency workspace** (thesis 4): connections, approvals and
  brand disclosure rules are the client org's own.
- **Open interfaces** (thesis 5): ADR 0962 can expose the same draft/schedule tools to an
  external agent under the same gate.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | Feature skeleton, `SocialPost` store + CAS state machine, routes, erasure | route tests: cross-org 404; edit voids approval; `viewer` cannot schedule |
| P1 | `socialAdapter` + Facebook Page strategy (text, link, image by URL); `EgressChannel 'social'`; `meta-ads` scope group | sandbox row green; double fire posts once |
| P2 | Scheduler wiring + `social.publish-post` chain + 0942 gate + content rules | stale-approval fire refused; reschedule re-registers one job |
| P3 | D6 handoff from `campaign-channels`; calendar + composer UI | generated posts land as drafts; calendar edits round-trip |
| P4 | Instagram, LinkedIn strategies | sandbox rows green |
| P5 | `brokeredUpload`; video for Facebook/Instagram/LinkedIn | resumable upload test; `processing` poll terminates |
| P6 | X, TikTok, YouTube (each after its app audit; `app_not_audited` until then) | no private-only post reported as published |
| P7 | D8 metrics sync + dashboard tile; D9 platform disclosure flags | null-vs-zero honesty test; disclosure mechanism recorded |
| P8 | `registerCalendarSource` consumers (0952, 0955, CMS) | entries render, deep-link to owners |

## Alternatives weighed

- **Add posting to `AdsAdapter`.** Rejected: different contract (no spend, different
  consent and limits); the ADR 0404 precedent.
- **A third-party scheduler (Buffer/Ayrshare) as the only egress.** Rejected as the
  default: per-client isolation and approval binding would live outside our runs. It can
  ship later as one more strategy if David wants breadth fast (Q2).
- **One recurring drain job per org instead of one job per post.** Viable and cheaper at
  volume, but it needs its own claim logic. The per-post job reuses ADR 0309 and 0787
  unchanged. Revisit if Q5's cap is hit.
- **Engagement metrics in the ads performance store.** Rejected (D8).
- **Calendar owned by `campaigns` hub.** Rejected: the hub would import every channel
  feature; the source registry inverts that dependency.

## RFC verdict

**Host-extension — no RFC.** Outbound posting is an RFC 0045 action through the RFC
0046/0047 credential broker with RFC 0079 provenance and RFC 0095 packs, all Accepted,
the same basis as ADR 0167. Scheduling uses the existing scheduler; chains are RFC 0013.
Routes are under `/v1/host/openwop-app/*`. No wire field, event or capability changes.
ADR 0166's "RFC-gated" note is stale and gets a correction (S1).

## Open questions

1. **(David)** Vendor apps and review. Meta App Review (`pages_manage_posts`,
   `instagram_content_publish`), LinkedIn Community Management API access, TikTok
   Content Posting audit, YouTube API verification and X API paid access each need an
   account, an application and sometimes a fee. Every platform ships **disabled /
   `unsupported`** until David supplies credentials and approves.
2. **(David)** Is breadth-first through an aggregator (Ayrshare-style) acceptable as a
   stopgap, given it puts tokens with a third party?
3. YouTube as a separate pack versus a scope group on the built-in `google` provider.
   Proposed: separate, for explicit consent.
4. **(David)** Default autonomy preset for organic posts: proposed `approve(client
   reviewer)` for client orgs and `notify-after` for the agency's own org.
5. Per-org cap on scheduled posts (and so scheduler jobs). Proposed: 1,000 pending.
6. Promote `BookingMonthGrid` into `ui/`, or build a new calendar component?
7. Comment/DM inbox (reply to engagement) is out of scope here; ADR 0926's inbox is the
   likely owner if it is ever wanted.

## Planning rows

- **ROADMAP Overview row:** `| 0953 | Social publishing + scheduling | \`social-publishing\` | 0941, 0942, 0945, 0933 (composes 0157/0166/0024/0309/0787/0924) | \`feature.social-publishing.nodes\`, \`core.openwop.workflows.social-publishing\` | 🔵 Proposed | — (net-new) |`
- **FEATURES "Future features" row:** **Social publishing + scheduling (ADR 0953,
  Proposed)** — new `social-publishing` (OFF, tenant, depends on `campaign-channels`):
  a `socialAdapter` on the brokered-egress spine (ledger-deduped, provenance-stamped),
  Facebook Page/Instagram/LinkedIn via scope groups on the existing packs and new X,
  TikTok and YouTube packs, posts scheduled as one-shot jobs on the one scheduler,
  each post gated per the 0942 policy with approval bound to the content hash, a
  cross-channel content calendar, engagement read-back with null-not-zero honesty, and
  AI disclosure derived from provenance. Every platform ships disabled until its vendor
  app is approved and sandbox-verified.
