/**
 * Ads-dispatch egress adapter (ADR 0167; production-payload completion + LinkedIn
 * per ADR 0223) — `ctx.ads.publishAd`. Turns an approved ad draft into a real, PAUSED
 * ad-platform campaign through the Connections broker, following the slack/sms/email
 * adapter precedent: it composes `brokeredPost`/`brokeredFetch` (the broker resolves
 * the acting human's ad-platform Connection + injects the OAuth token in-header)
 * rather than adding a second credential path.
 *
 * Structure: a small **shared spine** (`publishAd`) owns the fork-stable idempotency
 * lookup/record + the RFC 0079 provenance stamp; the per-platform create pipeline is a
 * `PlatformStrategy` (Meta = [image →] campaign→adset→creative→ad; Google =
 * budget→campaign→adGroup→ad `:mutate`; TikTok = [image →] campaign→adgroup→ad;
 * LinkedIn = campaignGroup→campaign→creative). A new platform adds a strategy, not a
 * branch in the spine.
 *
 * Payload honesty (ADR 0223): the create bodies are authored to each platform's
 * CURRENT public API doc shape ("documented-complete") — live-sandbox verification
 * remains an operator step; a live rejection still fails closed (created-PAUSED, no
 * spend, no idempotency record).
 *
 * Load-bearing invariants (the /architect fixes):
 *  - **created PAUSED** — the status literal is owned by each strategy's mapper, never
 *    an input → a dispatched campaign can never auto-spend.
 *  - **host pinned** — `brokeredPost` does NOT pin the destination, so each strategy
 *    builds the URL from a HARDCODED platform host constant; only the public account id
 *    is caller-supplied (path-only, never the host).
 *  - **fork-stable idempotency** — the platform assigns the resource id, so the
 *    deterministic-local-id trick can't apply; the adapter keeps its OWN durable
 *    idem-key → platform-id map keyed on a HASH of `tenant:briefId:platform:adHash`
 *    (NEVER runId → a `:fork` reuses the recorded ids, no duplicate paid campaign).
 *  - **explicit provenance** — every successful pipeline stamps RFC 0079 `connectionUse`.
 *  - **broker is the sole credential authority** — the per-user OAuth token is injected
 *    by the broker; app-level static headers (Google's `developer-token`) ride
 *    `extraHeaders`, which the broker strips of any `authorization` override.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import { stampConnectionUse } from './connectionInjection.js';
import { brokeredPost, brokeredFetch, type BrokeredEgressDeps } from './brokeredEgress.js';
import { connectionExists, circuitStatus, reportConnectionFailure, reportConnectionSuccess } from '../features/connections/connectionsService.js';
import { resolveMediaAsset } from './inMemorySurfaces.js';
import { getAssetByIdForTenant } from '../features/media/mediaService.js';
import { DurableCollection } from './hostExtPersistence.js';
import { getGovernancePolicy } from './governanceService.js';
import { createCampaignSpendApproval, getApproval } from './approvalService.js';
import { emitHostEvent } from './hostEventDispatcher.js';
import {
  ADS_API_VERSIONS, LINKEDIN_VERSION, metaApiBase, googleApiBase, tiktokApiBase, linkedinApiBase,
  buildMetaConversionBody, buildTiktokConversionBody, adsReaderEnabled, buildTiktokReportUrl, buildLinkedinAnalyticsUrl,
  buildGoogleClickConversionBody, adsSenderEnabled, GOOGLE_CONVERSION_ACTION_RE,
  type AdPlatform, type AdsApiVersionPin, type ConversionBodyArgs, type GoogleConsent,
} from './adsWire.js';

// Re-exported so callers keep importing the ads surface from one module.
export {
  ADS_API_VERSIONS, LINKEDIN_VERSION, metaApiBase, googleApiBase, tiktokApiBase, linkedinApiBase,
  buildMetaConversionBody, buildTiktokConversionBody, type AdPlatform, type AdsApiVersionPin,
};

const log = createLogger('connections.ads');

type Provenance = Parameters<typeof stampConnectionUse>[2];

/** The ONE platform → connection-pack provider-id mapping. Every strategy and the
 *  dry-run readiness check source the provider from here, so the id can't drift
 *  between the dispatch call and the preview's connection check. */
const PLATFORM_PROVIDER: Record<AdPlatform, string> = { meta: 'meta-ads', google: 'google-ads', tiktok: 'tiktok-ads', linkedin: 'linkedin-ads' };

/** Google Ads developer-token — an APP/manager-account-level credential (one per
 *  integration, NOT per-user BYOK), so it lives host-side as operator config, mirroring
 *  `OPENWOP_OAUTH_*_CLIENT_SECRET`. Read through this seam (not `process.env` at the call
 *  site) so a future per-tenant override slots in behind the same signature. */
function resolveDeveloperToken(_tenantId: string): string | undefined {
  return process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined;
}


export interface AdCopyVariant {
  headline: string;
  description?: string;
  bodyText?: string;
  ctaText?: string;
}

/** What the publish node passes to `ctx.ads.publishAd`. `briefId` is the fork-stable
 *  idempotency anchor; `adAccountId` is the public account id (Meta `act_<id>` / Google
 *  customer id). */
export interface PublishAdArgs {
  platform: AdPlatform;
  briefId: string;
  adAccountId: string;
  campaignName: string;
  objective?: string;
  copy: AdCopyVariant;
  dailyBudgetMinor?: number;
  /** REQUIRED by Google (`finalUrls` on the responsive search ad — dispatch fails
   *  closed `missing_landing_url` without it); Meta/TikTok/LinkedIn thread it into the
   *  creative's link/landing-page field when present. */
  landingUrl?: string;
  /** Meta ONLY (ADR 0223): the Facebook Page that publishes the ad creative's story
   *  (`object_story_spec.page_id`). REQUIRED for a Meta dispatch — fails closed
   *  `missing_page_id` without it. Creative-affecting → part of the idempotency key. */
  pageId?: string;
  /** TikTok ONLY (ADR 0223): the identity the ad posts under (`identity_type:
   *  'CUSTOMIZED_USER'`). REQUIRED for a TikTok dispatch — fails closed
   *  `missing_identity_id` without it. Creative-affecting → part of the idempotency key. */
  identityId?: string;
  /** Optional media leg (ADR 0223): a media-library asset (`assetId` or serve token)
   *  whose bytes are resolved HOST-side and uploaded platform-side (Meta `adimages`
   *  → `image_hash`; TikTok `/file/image/ad/upload/` → `image_ids`). Unresolvable ⇒
   *  `media_asset_not_found` (fail closed). Creative-affecting → part of the
   *  idempotency key. Bytes NEVER appear in outputs/events/dry-run plans. */
  mediaAssetId?: string;
  /** Media-kind discriminator (ADR 0411 §P3c). Defaults to `image` (every pre-P3c
   *  caller). `video` routes the media leg to the platform VIDEO surface: Meta
   *  `advideos` → `object_story_spec.video_data`; TikTok `/file/video/ad/upload/`
   *  → an `ad_format: 'SINGLE_VIDEO'` creative. A dry-run PREVIEWS the documented
   *  video plan; a LIVE video dispatch FAILS CLOSED `video_dispatch_live_pending`
   *  — the multipart/chunked upload transport, Meta `video_status=ready` poll, and
   *  thumbnail/cover generation are live-smoke-pending, and this is a money path
   *  where a guessed live call could spend on a malformed creative. Google/LinkedIn
   *  are not reel targets → `video_unsupported_platform`. As defence-in-depth, the
   *  LIVE image leg also fails closed `media_asset_wrong_kind` if the resolved asset
   *  is actually `video/*` (never POST video bytes to the image endpoint).
   *  Creative-affecting → part of the idempotency key. */
  mediaKind?: 'image' | 'video';
  /** OPERATOR-AUTHORED targeting spec (ADR 0245), forwarded VERBATIM to the
   *  platform-native slot: Meta adset `targeting`, LinkedIn campaign
   *  `targetingCriteria`. The host NEVER invents a default (targeting is a
   *  spend-shaping decision the operator owns); absent ⇒ no targeting field (the
   *  platform requires one at activation — a human step). Validated only as a
   *  plain, size-bounded object. Spend-affecting → part of the idempotency key. */
  targeting?: Record<string, unknown>;
  /** Google ONLY (ADR 0907 P0): the operator's EU political-advertising declaration
   *  (`Campaign.containsEuPoliticalAdvertising`). Google refuses every campaign
   *  create without it since 2026-04-01 (`EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED`).
   *  It is a legal attestation, so the host NEVER defaults it: a LIVE Google
   *  dispatch without it fails closed `missing_eu_political_declaration` before
   *  any platform call; a dry-run shows the gap in its plan. Not creative-affecting,
   *  so not part of the idempotency key. */
  euPoliticalAdvertising?: 'contains' | 'does_not_contain';
  /** Preview mode (ADR 0167): build the exact create payloads and return them as a
   *  `plan` WITHOUT calling the platform — so a human can review precisely what would
   *  be created (status, budget, copy) before any real, money-spending dispatch.
   *  Makes ZERO platform calls and creates nothing. */
  dryRun?: boolean;
}

/** Dry-run plans must show the media-upload step WITHOUT the bytes (plans ride node
 *  outputs — never a token, never creative bytes). */
const REDACTED_MEDIA_BYTES = '<media-asset bytes (base64) — redacted from plan>';

/** Resolve a media asset's bytes for the platform upload legs. Accepts either the
 *  media library's `assetId` (resolved to its `storageRef` token) or a raw RFC 0055
 *  serve token; tenant-checked either way (a foreign asset reads as not-found). */
async function resolveAdMediaBase64(tenantId: string, mediaAssetId: string): Promise<{ base64: string; contentType: string } | null> {
  const asset = await getAssetByIdForTenant(tenantId, mediaAssetId).catch(() => null);
  const token = asset?.storageRef ?? mediaAssetId;
  const entry = await resolveMediaAsset(token).catch(() => null);
  if (!entry || entry.tenantId !== tenantId) return null;
  return { base64: entry.contentBase64, contentType: entry.contentType };
}

/** One create step in a dry-run plan: the resource/edge + the exact body that would
 *  be POSTed (inter-step ids appear as `<…>` placeholders since nothing is created). */
export interface AdPlanStep {
  step: string;
  body: Record<string, unknown>;
}

/** Pad a seed list of strings to `min` non-empty entries (Google RSA needs ≥3
 *  headlines / ≥2 descriptions), de-duped + bounded to `cap` chars. */
function padText(seed: Array<string | undefined>, min: number, cap: number, filler: string): string[] {
  const out: string[] = [];
  for (const s of [...seed, filler, `${filler} ·`, `${filler} ✦`]) {
    const t = (s ?? '').trim().slice(0, cap);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= min) break;
  }
  return out;
}

export type PublishAdResult =
  | { outcome: 'no_connection' }
  | { outcome: 'failed'; error: string }
  | {
      // Spend governance (§5B B3): the tenant's ad-spend policy requires a human
      // sign-off for this dispatch. The approval sits in the ONE approvals inbox
      // (kind 'campaign-spend'); once approved, re-running the same dispatch
      // proceeds (same fork-stable key). Nothing was created on the platform.
      outcome: 'requires_approval';
      approvalId: string;
    }
  | {
      outcome: 'published';
      platform: AdPlatform;
      platformCampaignId: string;
      platformAdSetId: string;
      platformAdId: string;
      reviewStatus: 'pending_review';
      paused: true;
      reused: boolean;
    }
  | {
      // dryRun: the exact create payloads that WOULD be sent — zero platform calls,
      // nothing created.
      //  - `alreadyDispatched` ⇒ a real run would REUSE the recorded ids (the `plan`
      //    would NOT execute — a UI MUST gate on this flag, else it shows a misleading
      //    "would create" plan).
      //  - `connectionReady` ⇒ an authorized connection is present (a real dispatch
      //    won't fail `no_connection`). `false` ⇒ the plan is valid but would fail
      //    closed at real dispatch until the platform connection is wired.
      outcome: 'preview';
      platform: AdPlatform;
      plan: AdPlanStep[];
      alreadyDispatched?: boolean;
      connectionReady?: boolean;
      platformCampaignId?: string;
    };

interface AdDispatchRecord {
  idemKey: string;
  tenantId: string;
  platform: AdPlatform;
  platformCampaignId: string;
  platformAdSetId: string;
  platformAdId: string;
  createdAt: string;
  /** Fields below are additive (campaign gap plan §5B B5) — records written
   *  before them read back undefined and simply don't surface in the
   *  brief-scoped dispatch read. */
  briefId?: string;
  campaignName?: string;
  dailyBudgetMinor?: number;
  adAccountId?: string;
}
const dispatched = new DurableCollection<AdDispatchRecord>('ads:dispatch', (r) => r.idemKey);

/** CS-DATA-11 — the dispatch ledger is capped per tenant like the program's
 *  other trails (brand audit AUDIT_CAP precedent) — but this collection is NOT
 *  only a trail. R2 CO-SP-6 (correction): each row is ALSO the fork-stable
 *  idempotency record this file's header calls load-bearing ("no duplicate paid
 *  campaign"), and the UI's proof that a real platform campaign exists. The
 *  original trim DELETED old rows, so a replay/`:fork` of an old brief's
 *  publish re-created a real platform campaign, and still-live campaigns
 *  silently vanished from the Launch state panel. A correctness guard is never
 *  trimmed: past the cap, rows are TOMBSTONED — the platform ids (the
 *  idempotency + existence facts) are kept, only the display extras
 *  (campaignName / dailyBudgetMinor / adAccountId) are stripped. */
const dispatchLedgerCap = (): number => Math.max(1, Number(process.env.OPENWOP_ADS_DISPATCH_LEDGER_CAP ?? '') || 500);
async function trimDispatchLedger(tenantId: string): Promise<void> {
  const mine = (await dispatched.listByPrefix('ads:'))
    .filter((r) => r.tenantId === tenantId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const stale of mine.slice(dispatchLedgerCap())) {
    if (stale.campaignName === undefined && stale.dailyBudgetMinor === undefined && stale.adAccountId === undefined) continue; // already a tombstone
    const tombstone: AdDispatchRecord = {
      idemKey: stale.idemKey, tenantId: stale.tenantId, platform: stale.platform,
      platformCampaignId: stale.platformCampaignId, platformAdSetId: stale.platformAdSetId,
      platformAdId: stale.platformAdId, createdAt: stale.createdAt,
      ...(stale.briefId !== undefined ? { briefId: stale.briefId } : {}),
    };
    await dispatched.put(tombstone);
  }
}

/** What the campaign hub's launch checklist reads (§5B B5): the dispatch ledger
 *  rows for one brief — ids + platform state only, never a token or creative
 *  bytes. Keys are content hashes, so this is a bounded full-collection scan
 *  filtered by the stored tenantId (checklist read path only — not hot). */
export interface DispatchLedgerRow {
  platform: AdPlatform; platformCampaignId: string; platformAdSetId: string; platformAdId: string;
  briefId?: string; campaignName?: string; dailyBudgetMinor?: number; adAccountId?: string; createdAt: string;
}

export async function listDispatchRecords(tenantId: string, briefId: string): Promise<DispatchLedgerRow[]> {
  return (await listTenantDispatchRecords(tenantId)).filter((r) => r.briefId === briefId);
}

/** Every dispatch row for a tenant (C2 sync iterates these). Bounded scan. */
export async function listTenantDispatchRecords(tenantId: string): Promise<DispatchLedgerRow[]> {
  const all = await dispatched.listByPrefix('ads:');
  return all
    .filter((r) => r.tenantId === tenantId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ platform, platformCampaignId, platformAdSetId, platformAdId, briefId, campaignName, dailyBudgetMinor, adAccountId, createdAt }) => ({
      platform, platformCampaignId, platformAdSetId, platformAdId,
      ...(briefId !== undefined ? { briefId } : {}),
      ...(campaignName !== undefined ? { campaignName } : {}),
      ...(dailyBudgetMinor !== undefined ? { dailyBudgetMinor } : {}),
      ...(adAccountId !== undefined ? { adAccountId } : {}),
      createdAt,
    }));
}

// ── Spend governance (campaign gap plan §5B B3) ──────────────────────────────
// The adapter is the ONE chokepoint every dispatch/budget path funnels through
// (node ctx.ads calls BYPASS the capability-firewall, which only sees chat/agent
// tool loops) — so the ad-spend policy gate lives here. Two policy handles, both
// read from the tenant governance policy (host/governanceService.ts):
//   - actionPolicy['ads.publish'|'ads.budget'] — read DIRECTLY (not through
//     actionPolicyOf, whose unset-default 'approval-required' would silently
//     flip existing flows): 'disabled' refuses, 'draft-only' forces a dry-run.
//   - adSpend.approvalThresholdMinor — at/above it, a live dispatch/budget-set
//     requires an approved PendingApproval (kind 'campaign-spend'), keyed by the
//     SAME fork-stable spend key, so approve-then-rerun proceeds and a :fork
//     can't re-ask. Below it (or unset): allow — created-PAUSED stays the
//     backstop and a human still activates on-platform.

interface SpendApprovalMapRow { spendKey: string; tenantId: string; approvalId: string; }
const spendApprovals = new DurableCollection<SpendApprovalMapRow>('ads:spend-approval', (r) => r.spendKey);

type SpendGateVerdict =
  | { verdict: 'allow' }
  | { verdict: 'draft-only' }
  | { verdict: 'disabled' }
  | { verdict: 'requires-approval'; approvalId: string; approvalStatus: 'pending' | 'rejected' };

// ── ADR 0354 P1 — the brand-compliance checker seam ─────────────────────────
// The HOST must not import features; the brand feature registers this checker
// at boot (the setLaunchStudioDocumentResolver precedent). Absent checker =
// no compliance gating (the pre-0354 behavior). A non-allow verdict funnels
// into the SAME campaign-spend approval machinery as the spend gate — one
// approval UX, fork-stable keys.
export interface AdsComplianceVerdict { verdict: 'allow' | 'requires-approval'; reason?: string; score?: number }
export type AdsComplianceChecker = (tenantId: string, args: { briefId?: string; platform: string; content: string }) => Promise<AdsComplianceVerdict>;
let complianceChecker: AdsComplianceChecker | null = null;
export function setAdsComplianceChecker(fn: AdsComplianceChecker | null): void { complianceChecker = fn; }

/** ADR 0357 P6 — is a strategy failure a TRANSPORT failure the circuit breaker
 *  should count? Matches the adapter's own error vocabulary: `request_failed`,
 *  `timeout`, and the `http_5xx` shape every strategy emits (`http_${status}` —
 *  INTEL-CODE-2 grade fix: the old `HTTP 5\d\d` pattern never matched it).
 *  Platform 4xx rejections (bad payload, auth) are NOT breaker failures. */
export function isBreakerReportableFailure(error: unknown): boolean {
  return /request_failed|timeout|http[_ ]5\d\d/i.test(String(error));
}

async function evaluateSpendGate(
  deps: BrokeredEgressDeps,
  kind: 'ads.publish' | 'ads.budget',
  spendKey: string,
  dailyBudgetMinor: number | undefined,
  describe: { platform: AdPlatform; summary: string; briefId?: string; adAccountId: string; platformCampaignId?: string },
): Promise<SpendGateVerdict> {
  let policy: Awaited<ReturnType<typeof getGovernancePolicy>> = null;
  try { policy = await getGovernancePolicy(deps.tenantId); }
  catch (e) { log.warn('ads spend policy read failed — treating as unset', { error: e instanceof Error ? e.message : String(e) }); }
  const kindPolicy = policy?.actionPolicy?.[kind];
  if (kindPolicy === 'disabled') return { verdict: 'disabled' };
  if (kindPolicy === 'draft-only') return { verdict: 'draft-only' };
  const threshold = policy?.adSpend?.approvalThresholdMinor;
  if (threshold === undefined || (dailyBudgetMinor ?? 0) < threshold) return { verdict: 'allow' };

  const mapped = await spendApprovals.get(spendKey).catch(() => undefined);
  if (mapped && mapped.tenantId === deps.tenantId) {
    const approval = await getApproval(mapped.approvalId);
    if (approval && approval.tenantId === deps.tenantId) {
      if (approval.status === 'approved') return { verdict: 'allow' };
      return { verdict: 'requires-approval', approvalId: approval.approvalId, approvalStatus: approval.status === 'rejected' ? 'rejected' : 'pending' };
    }
  }
  const approval = await createCampaignSpendApproval({
    tenantId: deps.tenantId,
    spendKind: kind === 'ads.publish' ? 'publish' : 'budget',
    platform: describe.platform,
    adAccountId: describe.adAccountId,
    ...(describe.briefId ? { briefId: describe.briefId } : {}),
    ...(describe.platformCampaignId ? { platformCampaignId: describe.platformCampaignId } : {}),
    dailyBudgetMinor: dailyBudgetMinor ?? 0,
    spendIdemKey: spendKey,
    proposal: describe.summary,
  });
  await spendApprovals.put({ spendKey, tenantId: deps.tenantId, approvalId: approval.approvalId }).catch((e) =>
    log.warn('ads spend-approval map write failed', { spendKey, error: e instanceof Error ? e.message : String(e) }));
  recordAdsAction(deps, 'approval-required', {
    platform: describe.platform, kind, approvalId: approval.approvalId,
    ...(describe.briefId ? { briefId: describe.briefId } : {}),
    dailyBudgetMinor: dailyBudgetMinor ?? 0,
  });
  return { verdict: 'requires-approval', approvalId: approval.approvalId, approvalStatus: 'pending' };
}

/** Fork-stable spend key for a budget mutation (mirrors `idemKeyFor`). */
function budgetSpendKey(deps: BrokeredEgressDeps, a: UpdateBudgetArgs): string {
  return `adsbudget:${createHash('sha256').update(JSON.stringify([deps.tenantId, a.platform, a.adAccountId, a.campaignId, a.dailyBudgetMinor])).digest('hex')}`;
}

/** Audit row + lifecycle webhook for an ads action (campaign gap plan §5B B1/B2
 *  — the recordCmsAction precedent). `payload.tenantId` REQUIRED (the governance
 *  read withholds rows without it). Best-effort; ids + amounts only, never a
 *  token or creative bytes. Events fan out through `emitHostEvent` (ADR 0208):
 *  signed webhooks + event→workflow trigger bindings. */
const ADS_EVENT_FOR_ACTION: Record<string, string> = {
  dispatched: 'host.campaign.ads.dispatched',
  'budget-updated': 'host.campaign.ads.budget-updated',
  'audience-synced': 'host.campaign.ads.audience-synced',
};
function recordAdsAction(deps: BrokeredEgressDeps, action: string, fields: Record<string, unknown>): void {
  const at = new Date().toISOString();
  const payload = { tenantId: deps.tenantId, ...(deps.orgId ? { orgId: deps.orgId } : {}), actor: deps.actingUserId ?? 'system', at, ...fields };
  try {
    void deps.storage
      .appendAudit({ timestamp: at, principalId: deps.actingUserId ?? 'system', action: `campaign.ads.${action}`, resource: String(fields.platformCampaignId ?? fields.briefId ?? fields.approvalId ?? ''), outcome: 'success', payload })
      .catch((err) => log.warn('ads audit append failed', { action, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  const eventType = ADS_EVENT_FOR_ACTION[action];
  if (eventType) {
    void emitHostEvent({ type: eventType, tenantId: deps.tenantId, payload });
  }
}

/** Fork-stable: tenant + brief + platform + a hash of the ad content. NO runId.
 *  Components are JSON-encoded before hashing so a `:` inside a tenantId/briefId
 *  cannot collide two distinct tenants' keys (the record still stores tenantId for
 *  the read-side tenant check). */
/** ADR 0245 — order-insensitive JSON for the targeting idempotency contribution:
 *  object keys sorted recursively (arrays keep order) so a re-send with reordered
 *  keys does NOT mint a new PAUSED dispatch. */
function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = norm(o[k]); return acc; }, {});
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

function idemKeyFor(deps: BrokeredEgressDeps, a: PublishAdArgs): string {
  // The creative-affecting C1 inputs (pageId / mediaAssetId / identityId) are hashed
  // ADDITIVELY — only when set — so pre-C1 dispatch records keep matching unchanged
  // inputs, while a creative change (new page/image/identity) mints a NEW key.
  // ADS-1 (grade-code, reviewed & scoped-out): a DUAL-KEY legacy fallback was
  // considered and REJECTED — it would falsely reuse a legacy record across a
  // page/image/identity change (silently NOT dispatching the new creative), a
  // correctness regression strictly worse than the bounded duplicate it prevents,
  // over an effectively-empty pre-C1 population. Residual: a pre-C1 record (if any)
  // may yield ONE bounded PAUSED duplicate on first re-run. Accepted.
  const adHash = createHash('sha256')
    .update(JSON.stringify({
      n: a.campaignName, o: a.objective ?? '', c: a.copy, b: a.dailyBudgetMinor ?? 0, acct: a.adAccountId,
      ...(a.pageId ? { pg: a.pageId } : {}),
      ...(a.mediaAssetId ? { m: a.mediaAssetId } : {}),
      ...(a.mediaKind ? { mk: a.mediaKind } : {}), // P3c: image vs video is creative-affecting; additive so pre-P3c keys are unchanged
      ...(a.identityId ? { idn: a.identityId } : {}),
      // ADS-0245: targeting is spend-shaping, so a change mints a NEW PAUSED
      // dispatch — additively (a record with no targeting keeps matching) and
      // CANONICALLY (a reordered-but-equivalent object must not spuriously mint one).
      ...(a.targeting ? { tgt: canonicalJson(a.targeting) } : {}),
    }))
    .digest('hex')
    .slice(0, 16);
  return `ads:${createHash('sha256').update(JSON.stringify([deps.tenantId, a.briefId, a.platform, adHash])).digest('hex')}`;
}

/** A per-platform create pipeline. Returns the three resource ids + the broker
 *  provenance on success, or a typed failure; owns its own created-PAUSED mapping +
 *  best-effort cleanup. Never throws. */
type StrategyResult =
  | { kind: 'ok'; ids: { campaignId: string; adSetId: string; adId: string }; provenance: Provenance }
  | { kind: 'no_connection' }
  | { kind: 'failed'; error: string }
  | { kind: 'preview'; plan: AdPlanStep[] };
type PlatformStrategy = (deps: BrokeredEgressDeps, args: PublishAdArgs) => Promise<StrategyResult>;

// ── Meta (Phase 1; ADR 0223 production payloads) — [image →] campaign → adset →
//    creative → ad, all PAUSED. The creative is a real page-published story
//    (`object_story_spec`), so a Facebook `page_id` is REQUIRED — dispatch (and the
//    preview, which would otherwise render an un-postable plan) fails closed without
//    one. The optional media leg uploads the host-resolved asset bytes to `adimages`
//    and threads the returned `image_hash` into the creative's `link_data`. ─────────
const metaStrategy: PlatformStrategy = async (deps, args) => {
  if (!args.pageId) return { kind: 'failed', error: 'missing_page_id' }; // an ARG, not host config — a plan without it is not a valid Meta payload
  const acct = `act_${args.adAccountId.replace(/^act_/, '')}`;
  const base = metaApiBase();
  const created: Array<{ kind: string; id: string }> = [];
  const plan: AdPlanStep[] = [];
  let provenance: Provenance | undefined;

  const post = async (edge: string, body: Record<string, unknown>, idFrom: 'id' | 'image_hash' = 'id'): Promise<{ id: string } | { error: string }> => {
    // dryRun: record the exact body + return a placeholder id (so later steps build),
    // never touching the platform.
    if (args.dryRun) { plan.push({ step: edge, body }); return { id: idFrom === 'image_hash' ? '<image_hash>' : `<${edge}-id>` }; }
    const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER[args.platform], url: `${base}/${acct}/${edge}`, body: JSON.stringify(body) });
    if (r.outcome === 'no_connection') return { error: 'no_connection' };
    if (r.outcome === 'insecure_base') return { error: 'insecure_base' };
    if (r.outcome === 'request_failed') return { error: r.timedOut ? 'timeout' : 'request_failed' };
    provenance = r.provenance;
    let json: { id?: string; images?: Record<string, { hash?: string }>; error?: { message?: string } };
    try { json = (await r.res.json()) as typeof json; } catch { return { error: 'bad_response' }; }
    // adimages returns { images: { bytes: { hash } } } (keyed by the upload param), not { id }.
    const id = idFrom === 'image_hash' ? Object.values(json.images ?? {})[0]?.hash : json.id;
    if (!r.res.ok || json.error || typeof id !== 'string' || !id) return { error: json.error?.message ?? `http_${r.res.status}` };
    return { id };
  };
  const fail = async (error: string): Promise<StrategyResult> => {
    // Best-effort host-pinned DELETE cleanup (reverse). Un-deletable objects stay PAUSED — no spend.
    for (const obj of [...created].reverse()) {
      try { await brokeredFetch(deps, { provider: PLATFORM_PROVIDER[args.platform], url: `${base}/${obj.id}`, method: 'DELETE' }); }
      catch (e) { log.warn('ads rollback delete failed (object left PAUSED, no spend)', { kind: obj.kind, id: obj.id, error: e instanceof Error ? e.message : String(e) }); }
    }
    return error === 'no_connection' ? { kind: 'no_connection' } : { kind: 'failed', error };
  };

  // Optional media leg — bytes resolved HOST-side (media library assetId or serve
  // token, tenant-checked), POSTed as base64 to adimages → image_hash. A dry-run
  // shows the step with the bytes REDACTED (plans ride node outputs). VIDEO
  // (ADR 0411 §P3c): a live video request never reaches here (the outer guard
  // fails it closed video_dispatch_live_pending); a video DRY-RUN previews the
  // documented `advideos` upload → `video_data` creative.
  let imageHash: string | undefined;
  let videoPlan = false;
  if (args.mediaAssetId && args.mediaKind === 'video') {
    // Dry-run only (guaranteed by the outer guard). The documented Meta video path:
    // upload the reel to `advideos` (multipart/chunked live; bytes REDACTED in the
    // plan), then a `video_data` creative referencing the video + its poster thumbnail.
    plan.push({ step: 'advideos', body: { title: `${args.campaignName} — Reel`, source: REDACTED_MEDIA_BYTES } });
    videoPlan = true;
  } else if (args.mediaAssetId) {
    let bytes = REDACTED_MEDIA_BYTES;
    if (!args.dryRun) {
      const media = await resolveAdMediaBase64(deps.tenantId, args.mediaAssetId);
      if (!media) return { kind: 'failed', error: 'media_asset_not_found' };
      if (media.contentType.startsWith('video/')) return { kind: 'failed', error: 'media_asset_wrong_kind' }; // never POST video bytes to the image endpoint — use mediaKind:'video'
      bytes = media.base64;
    }
    const img = await post('adimages', { bytes }, 'image_hash');
    if ('error' in img) return fail(img.error);
    imageHash = img.id;
  }

  const campaign = await post('campaigns', { name: args.campaignName, objective: args.objective ?? 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [] });
  if ('error' in campaign) return fail(campaign.error);
  created.push({ kind: 'campaign', id: campaign.id });
  const adset = await post('adsets', { name: `${args.campaignName} — Ad Set`, campaign_id: campaign.id, status: 'PAUSED', billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', ...(args.dailyBudgetMinor ? { daily_budget: args.dailyBudgetMinor } : {}), ...(args.targeting ? { targeting: args.targeting } : {}) });
  if ('error' in adset) return fail(adset.error);
  created.push({ kind: 'adsets', id: adset.id });
  // The real creative object (v21 `adcreatives`): a link ad published as the Page's
  // story. Meta's CTA `type` is an enum — free-text copy CTAs fall back to LEARN_MORE.
  const ctaType = args.copy.ctaText && /^[A-Z][A-Z_]*$/.test(args.copy.ctaText) ? args.copy.ctaText : 'LEARN_MORE';
  const creative = await post('adcreatives', {
    name: `${args.campaignName} — Creative`,
    object_story_spec: {
      page_id: args.pageId,
      // VIDEO (P3c, dry-run only): `video_data` referencing the uploaded reel + its
      // poster thumbnail (`image_url`, from the advideos thumbnail poll live). IMAGE:
      // the existing `link_data` (with the optional image_hash).
      ...(videoPlan
        ? { video_data: {
            video_id: '<video_id>',
            image_url: '<video-thumbnail>',
            title: args.copy.headline,
            message: args.copy.bodyText ?? args.copy.description ?? args.copy.headline,
            ...(args.landingUrl ? { call_to_action: { type: ctaType, value: { link: args.landingUrl } } } : {}),
          } }
        : { link_data: {
            message: args.copy.bodyText ?? args.copy.description ?? args.copy.headline,
            name: args.copy.headline,
            ...(args.landingUrl ? { link: args.landingUrl, call_to_action: { type: ctaType, value: { link: args.landingUrl } } } : {}),
            ...(imageHash ? { image_hash: imageHash } : {}),
          } }),
    },
  });
  if ('error' in creative) return fail(creative.error);
  created.push({ kind: 'adcreatives', id: creative.id });
  // The ad references the created creative by id (no more inline seam shape).
  const ad = await post('ads', { name: `${args.campaignName} — Ad`, adset_id: adset.id, status: 'PAUSED', creative: { creative_id: creative.id } });
  if ('error' in ad) return fail(ad.error);

  if (args.dryRun) return { kind: 'preview', plan };
  return { kind: 'ok', ids: { campaignId: campaign.id, adSetId: adset.id, adId: ad.id }, provenance: provenance! };
};

// ── Google Ads (Phase 2; ADR 0223 production payloads) — budget → campaign →
//    adGroup → ad, all PAUSED. `finalUrls` is MANDATORY on a responsive search ad, so
//    dispatch (and the preview) fails closed `missing_landing_url` without a landing
//    URL; the campaign carries the SEARCH network settings. ─────────────────────
const googleStrategy: PlatformStrategy = async (deps, args) => {
  if (!args.landingUrl) return { kind: 'failed', error: 'missing_landing_url' }; // an ARG, not host config — finalUrls is mandatory (RSA)
  if (!args.dryRun && !args.euPoliticalAdvertising) return { kind: 'failed', error: 'missing_eu_political_declaration' }; // an attestation — never defaulted
  const devToken = resolveDeveloperToken(deps.tenantId);
  // The developer-token is only needed for a real call; a dry-run preview makes none.
  if (!args.dryRun && !devToken) return { kind: 'failed', error: 'no_developer_token' }; // fail closed — never a blank header
  const customerId = args.adAccountId.replace(/[^0-9]/g, '');
  const base = googleApiBase();
  const extraHeaders = { 'developer-token': devToken ?? '' };
  const created: string[] = []; // resourceNames, reverse-removed on failure
  const plan: AdPlanStep[] = [];
  let provenance: Provenance | undefined;

  /** One mutate POST; returns the created resourceName or an error. */
  const mutate = async (resource: string, create: Record<string, unknown>): Promise<{ rn: string } | { error: string }> => {
    if (args.dryRun) { plan.push({ step: resource, body: { operations: [{ create }] } }); return { rn: `customers/${customerId}/${resource}/<id>` }; }
    const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER[args.platform], url: `${base}/customers/${customerId}/${resource}:mutate`, body: JSON.stringify({ operations: [{ create }] }), extraHeaders });
    if (r.outcome === 'no_connection') return { error: 'no_connection' };
    if (r.outcome === 'insecure_base') return { error: 'insecure_base' };
    if (r.outcome === 'request_failed') return { error: r.timedOut ? 'timeout' : 'request_failed' };
    provenance = r.provenance;
    let json: { results?: Array<{ resourceName?: string }>; error?: { message?: string } };
    try { json = (await r.res.json()) as typeof json; } catch { return { error: 'bad_response' }; }
    const rn = json.results?.[0]?.resourceName;
    if (!r.res.ok || json.error || !rn) return { error: json.error?.message ?? `http_${r.res.status}` };
    return { rn };
  };
  const fail = async (error: string): Promise<StrategyResult> => {
    // Best-effort cleanup: remove-mutate each created resource (reverse) via the SAME
    // host-pinned brokeredPost (google-ads has no providerRegistry apiHosts → brokeredFetch
    // would no-op; the hardcoded googleapis base keeps this on-host). PAUSED-safe otherwise.
    for (const rn of [...created].reverse()) {
      const resource = rn.split('/').slice(2, 3)[0] ?? '';
      try { await brokeredPost(deps, { provider: PLATFORM_PROVIDER[args.platform], url: `${base}/customers/${customerId}/${resource}:mutate`, body: JSON.stringify({ operations: [{ remove: rn }] }), extraHeaders }); }
      catch (e) { log.warn('ads google rollback remove failed (object left PAUSED, no spend)', { rn, error: e instanceof Error ? e.message : String(e) }); }
    }
    return error === 'no_connection' ? { kind: 'no_connection' } : { kind: 'failed', error };
  };

  // 1) Budget.
  const budget = await mutate('campaignBudgets', { name: `${args.campaignName} — Budget`, amountMicros: String((args.dailyBudgetMinor ?? 5000) * 10000), deliveryMethod: 'STANDARD' });
  if ('error' in budget) return fail(budget.error);
  created.push(budget.rn);
  // 2) Campaign — PAUSED; SEARCH channel + explicit network settings (Google
  //    Search + search partners, no Display expansion — the documented RSA target).
  const campaign = await mutate('campaigns', {
    name: args.campaignName, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget.rn, manualCpc: {},
    containsEuPoliticalAdvertising: args.euPoliticalAdvertising === 'contains' ? 'CONTAINS_EU_POLITICAL_ADVERTISING'
      : args.euPoliticalAdvertising === 'does_not_contain' ? 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'
        : '<operator declaration required: euPoliticalAdvertising>', // dry-run only — a live call without it failed closed above
    networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
  });
  if ('error' in campaign) return fail(campaign.error);
  created.push(campaign.rn);
  // 3) Ad group — PAUSED.
  const adGroup = await mutate('adGroups', { name: `${args.campaignName} — Ad Group`, status: 'PAUSED', campaign: campaign.rn, type: 'SEARCH_STANDARD' });
  if ('error' in adGroup) return fail(adGroup.error);
  created.push(adGroup.rn);
  // 4) Ad — PAUSED; the approved copy as a responsive search ad. Google requires
  //    ≥3 headlines (≤30c), ≥2 descriptions (≤90c), and finalUrls — pad/derive them.
  const headlines = padText([args.copy.headline, args.copy.ctaText, args.campaignName], 3, 30, args.campaignName).map((t) => ({ text: t }));
  const descriptions = padText([args.copy.description, args.copy.bodyText, args.copy.headline], 2, 90, args.campaignName).map((t) => ({ text: t }));
  const ad = await mutate('adGroupAds', {
    status: 'PAUSED', adGroup: adGroup.rn,
    ad: { finalUrls: [args.landingUrl], responsiveSearchAd: { headlines, descriptions } }, // finalUrls mandatory — validated above
  });
  if ('error' in ad) return fail(ad.error);

  if (args.dryRun) return { kind: 'preview', plan };
  return { kind: 'ok', ids: { campaignId: campaign.rn, adSetId: adGroup.rn, adId: ad.rn }, provenance: provenance! };
};

// ── TikTok Ads (Phase 3; ADR 0223 production payloads) — [image →] campaign →
// adgroup → ad, all DISABLE (paused). TikTok authenticates with `Access-Token:
// <token>` (raw, NOT `Authorization: Bearer`) and returns HTTP 200 + `{ code,
// message, data }` (non-zero `code` is an error, like Slack's `{ok:false}`). No
// rollback (the source app has none; un-cleaned objects are DISABLE = no spend). The
// OAuth token is broker-resolved; the only caller-supplied piece is the public
// `advertiser_id`, placed in the BODY (never the URL). A v1.3 ad requires the posting
// identity, so `identityId` is REQUIRED (fail closed `missing_identity_id`); the
// optional media leg uploads host-resolved bytes to `/file/image/ad/upload/` and
// threads the returned `image_id` into the ad creative's `image_ids`.
const tiktokStrategy: PlatformStrategy = async (deps, args) => {
  if (!args.identityId) return { kind: 'failed', error: 'missing_identity_id' }; // an ARG, not host config — a v1.3 ad create requires the identity
  const advertiserId = args.adAccountId.replace(/[^0-9]/g, '');
  const base = tiktokApiBase();
  const plan: AdPlanStep[] = [];
  let provenance: Provenance | undefined;

  /** One create POST; returns the created id (campaign_id/adgroup_id/ad_id) or an error. */
  const create = async (edge: string, idField: string, body: Record<string, unknown>): Promise<{ id: string } | { error: string }> => {
    if (args.dryRun) { plan.push({ step: edge, body: { advertiser_id: advertiserId, ...body } }); return { id: `<${idField}>` }; }
    const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER[args.platform], url: `${base}/${edge}`, body: JSON.stringify({ advertiser_id: advertiserId, ...body }), authScheme: 'raw', authHeaderName: 'access-token' });
    if (r.outcome === 'no_connection') return { error: 'no_connection' };
    if (r.outcome === 'insecure_base') return { error: 'insecure_base' };
    if (r.outcome === 'request_failed') return { error: r.timedOut ? 'timeout' : 'request_failed' };
    provenance = r.provenance;
    let json: { code?: number; message?: string; data?: Record<string, unknown> };
    try { json = (await r.res.json()) as typeof json; } catch { return { error: 'bad_response' }; }
    const id = json.data ? (json.data[idField] ?? (json.data[`${idField}s`] as string[] | undefined)?.[0]) : undefined;
    if (!r.res.ok || json.code !== 0 || typeof id !== 'string') return { error: json.message ?? `code_${json.code}` };
    return { id };
  };
  const fail = (error: string): StrategyResult => (error === 'no_connection' ? { kind: 'no_connection' } : { kind: 'failed', error });

  // Optional media leg — host-resolved bytes as base64 `image_file` → image_id.
  // A dry-run shows the step with the bytes REDACTED (plans ride node outputs).
  // VIDEO (ADR 0411 §P3c): a live video request never reaches here (the outer guard
  // fails it closed video_dispatch_live_pending); a video DRY-RUN previews the
  // documented `/file/video/ad/upload/` → `SINGLE_VIDEO` creative.
  let imageId: string | undefined;
  let videoPlan = false;
  if (args.mediaAssetId && args.mediaKind === 'video') {
    // Dry-run only (guaranteed by the outer guard). The documented TikTok video path:
    // upload the reel to `/file/video/ad/upload/` (bytes REDACTED in the plan), then a
    // SINGLE_VIDEO creative referencing the video + a cover image (from suggestcover live).
    plan.push({ step: 'file/video/ad/upload/', body: { advertiser_id: advertiserId, video_file: REDACTED_MEDIA_BYTES } });
    videoPlan = true;
  } else if (args.mediaAssetId) {
    let imageFile = REDACTED_MEDIA_BYTES;
    if (!args.dryRun) {
      const media = await resolveAdMediaBase64(deps.tenantId, args.mediaAssetId);
      if (!media) return { kind: 'failed', error: 'media_asset_not_found' };
      if (media.contentType.startsWith('video/')) return { kind: 'failed', error: 'media_asset_wrong_kind' }; // never POST video bytes to the image endpoint — use mediaKind:'video'
      imageFile = media.base64;
    }
    const img = await create('file/image/ad/upload/', 'image_id', { image_file: imageFile });
    if ('error' in img) return fail(img.error);
    imageId = img.id;
  }

  // Campaign — DISABLE (paused), consistent with the cross-strategy created-PAUSED invariant.
  const campaign = await create('campaign/create/', 'campaign_id', { campaign_name: args.campaignName, objective_type: args.objective ?? 'TRAFFIC', budget_mode: 'BUDGET_MODE_DAY', budget: ((args.dailyBudgetMinor ?? 5000) / 100), operation_status: 'DISABLE' });
  if ('error' in campaign) return fail(campaign.error);
  // Ad group — DISABLE (paused); the v1.3 required delivery fields (placement,
  // schedule, optimization, billing) + the day budget when the caller set one.
  const adgroup = await create('adgroup/create/', 'adgroup_id', {
    campaign_id: campaign.id, adgroup_name: `${args.campaignName} — Ad Group`,
    placements: ['PLACEMENT_TIKTOK'], schedule_type: 'SCHEDULE_FROM_NOW',
    optimization_goal: 'CLICK', billing_event: 'CPC',
    ...(args.dailyBudgetMinor ? { budget_mode: 'BUDGET_MODE_DAY', budget: args.dailyBudgetMinor / 100 } : {}),
    operation_status: 'DISABLE',
  });
  if ('error' in adgroup) return fail(adgroup.error);
  // Ad — DISABLE (paused); the approved copy posted under the REQUIRED identity
  // (`CUSTOMIZED_USER`), with the uploaded image + landing page when present.
  const ad = await create('ad/create/', 'ad_id', {
    adgroup_id: adgroup.id, operation_status: 'DISABLE',
    creatives: [{
      ad_name: `${args.campaignName} — Ad`,
      identity_id: args.identityId, identity_type: 'CUSTOMIZED_USER',
      ad_text: args.copy.bodyText ?? args.copy.description ?? args.copy.headline,
      call_to_action: args.copy.ctaText ?? 'LEARN_MORE',
      // VIDEO (P3c, dry-run only): a SINGLE_VIDEO creative referencing the uploaded
      // reel + a cover image (from suggestcover live). IMAGE: the uploaded image_ids.
      ...(videoPlan
        ? { ad_format: 'SINGLE_VIDEO', video_id: '<video_id>', image_ids: ['<video-cover>'] }
        : (imageId ? { image_ids: [imageId] } : {})),
      ...(args.landingUrl ? { landing_page_url: args.landingUrl } : {}),
    }],
  });
  if ('error' in ad) return fail(ad.error);

  if (args.dryRun) return { kind: 'preview', plan };
  return { kind: 'ok', ids: { campaignId: campaign.id, adSetId: adgroup.id, adId: ad.id }, provenance: provenance! };
};

// ── LinkedIn Marketing (ADR 0223, NEW) — adCampaignGroup (DRAFT) → adCampaign
// (PAUSED) → creative (intendedStatus PAUSED). Versioned REST under `/rest/*`: every
// call sends `LinkedIn-Version` + `X-Restli-Protocol-Version: 2.0.0` via brokeredPost
// extraHeaders (the broker stays the sole Authorization authority — it strips any
// auth-header override). LinkedIn returns the created id in the `x-restli-id`
// (legacy: `x-linkedin-id`) response HEADER, not the body. No rollback (the TikTok
// posture): a half-built hierarchy is DRAFT/PAUSED = no spend. The caller-supplied
// piece is the public sponsored-account id (urn path only — never the host).
const linkedinStrategy: PlatformStrategy = async (deps, args) => {
  const accountId = args.adAccountId.replace(/[^0-9]/g, '');
  const accountUrn = `urn:li:sponsoredAccount:${accountId}`;
  const base = linkedinApiBase();
  const plan: AdPlanStep[] = [];
  let provenance: Provenance | undefined;
  const extraHeaders = { 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' };

  const post = async (resource: string, body: Record<string, unknown>): Promise<{ id: string } | { error: string }> => {
    if (args.dryRun) { plan.push({ step: resource, body }); return { id: `<${resource}-id>` }; }
    const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER[args.platform], url: `${base}/rest/${resource}`, body: JSON.stringify(body), extraHeaders });
    if (r.outcome === 'no_connection') return { error: 'no_connection' };
    if (r.outcome === 'insecure_base') return { error: 'insecure_base' };
    if (r.outcome === 'request_failed') return { error: r.timedOut ? 'timeout' : 'request_failed' };
    provenance = r.provenance;
    // Rest.li create: the id rides the x-restli-id (legacy x-linkedin-id) response
    // HEADER; a 201 body is typically empty, so parse it only to surface an error.
    const id = r.res.headers.get('x-restli-id') ?? r.res.headers.get('x-linkedin-id');
    if (!r.res.ok || !id) {
      let msg: string | undefined;
      try { const j = (await r.res.json()) as { message?: string }; msg = j.message; } catch { /* empty create body */ }
      return { error: msg ?? (!r.res.ok ? `http_${r.res.status}` : 'missing_restli_id') };
    }
    return { id };
  };
  const fail = (error: string): StrategyResult => (error === 'no_connection' ? { kind: 'no_connection' } : { kind: 'failed', error });
  // A header id may be the bare numeric id or a full urn; a dry-run placeholder passes through.
  const urn = (entity: string, id: string): string => (id.startsWith('urn:') || id.startsWith('<') ? id : `urn:li:${entity}:${id}`);

  // 1) Campaign group — DRAFT (LinkedIn's non-spending created state at this level).
  const group = await post('adCampaignGroups', { account: accountUrn, name: `${args.campaignName} — Group`, status: 'DRAFT' });
  if ('error' in group) return fail(group.error);
  // 2) Campaign — PAUSED literal; text-ad type, CPC, the day budget when set (amount
  //    is a decimal STRING in major units per the docs; account currency is assumed
  //    USD — see ADR 0223's honesty note).
  const campaign = await post('adCampaigns', {
    account: accountUrn,
    campaignGroup: urn('sponsoredCampaignGroup', group.id),
    name: args.campaignName,
    status: 'PAUSED',
    type: 'SPONSORED_UPDATES',
    costType: 'CPC',
    locale: { country: 'US', language: 'en' },
    ...(args.dailyBudgetMinor ? { dailyBudget: { amount: (args.dailyBudgetMinor / 100).toFixed(2), currencyCode: 'USD' } } : {}),
    // ADR 0245 — operator-authored targeting, verbatim into LinkedIn's slot.
    ...(args.targeting ? { targetingCriteria: args.targeting } : {}),
  });
  if ('error' in campaign) return fail(campaign.error);
  // 3) Creative — inline content carrying the approved copy + landing page,
  //    intendedStatus PAUSED (the creative-level paused literal).
  const creative = await post('creatives', {
    campaign: urn('sponsoredCampaign', campaign.id),
    intendedStatus: 'PAUSED',
    content: {
      textAd: {
        headline: args.copy.headline,
        description: args.copy.bodyText ?? args.copy.description ?? args.copy.headline,
        ...(args.landingUrl ? { landingPage: args.landingUrl } : {}),
      },
    },
  });
  if ('error' in creative) return fail(creative.error);

  if (args.dryRun) return { kind: 'preview', plan };
  // LinkedIn's hierarchy maps campaignGroup→campaign→creative onto the adapter's
  // campaign→adSet→ad id slots (the Meta-shaped result contract).
  return { kind: 'ok', ids: { campaignId: group.id, adSetId: campaign.id, adId: creative.id }, provenance: provenance! };
};

const STRATEGIES: Record<AdPlatform, PlatformStrategy> = { meta: metaStrategy, google: googleStrategy, tiktok: tiktokStrategy, linkedin: linkedinStrategy };

// ── Read: campaign performance metrics (ADR 0186 slice 4a) ───────────────────────
// READ-ONLY, provider-agnostic — the diagnostic half of the optimization loop, so a
// chain reads "the connected ad platform's metrics" instead of hard-coding Google Ads.
// Spend/cost are normalized to major currency units (Google cost_micros ÷ 1e6; Meta is
// already major). No mutation, no idempotency record — a read is naturally replay-safe.
export interface GetMetricsArgs {
  platform: AdPlatform;
  adAccountId: string;
  campaignId: string;
  /** Metric window (C2): 'lifetime' (default, back-compat) or 'yesterday' —
   *  the daily-sync window, so synced rows are per-date and never double-count. */
  window?: 'lifetime' | 'yesterday';
}
export interface AdMetrics { impressions: number; clicks: number; spend: number; ctr: number; cpc: number; }
export type GetMetricsResult =
  | { outcome: 'no_connection' }
  | { outcome: 'unsupported'; platform: AdPlatform }
  | { outcome: 'failed'; error: string }
  // CONN-1: `date` is the platform-reported ISO day the metrics cover, when the
  // response carries one (Meta insights `date_start`, Google `segments.date`).
  // The daily sync stores THIS instead of a UTC `yesterdayIso()` label, so a
  // near-midnight account-timezone offset can't misdate a row and break the
  // performance-store natural-key dedup. Absent → caller keeps its UTC label.
  | { outcome: 'ok'; platform: AdPlatform; metrics: AdMetrics; date?: string };

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function metaMetrics(deps: BrokeredEgressDeps, args: GetMetricsArgs): Promise<GetMetricsResult> {
  const preset = args.window === 'yesterday' ? '&date_preset=yesterday' : '';
  const url = `${metaApiBase()}/${encodeURIComponent(args.campaignId)}/insights?fields=impressions,clicks,spend,ctr,cpc${preset}`;
  const r = await brokeredFetch(deps, { provider: PLATFORM_PROVIDER.meta, url, method: 'GET' });
  if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
  if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
  let json: { data?: Array<Record<string, unknown>>; error?: { message?: string } };
  try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
  if (!r.res.ok || json.error) return { outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` };
  const row = json.data?.[0] ?? {};
  await stampConnectionUse(deps.storage, deps.runId, r.provenance).catch((e) => log.warn('ads metrics connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  // Meta insights always echoes `date_start`/`date_stop` (account-timezone day) —
  // capture date_start (CONN-1) so the sync dates the row by the platform's day.
  const metaDate = typeof row.date_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date_start) ? row.date_start : undefined;
  return { outcome: 'ok', platform: 'meta', metrics: { impressions: num(row.impressions), clicks: num(row.clicks), spend: num(row.spend), ctr: num(row.ctr), cpc: num(row.cpc) }, ...(metaDate ? { date: metaDate } : {}) };
}

async function googleMetrics(deps: BrokeredEgressDeps, args: GetMetricsArgs): Promise<GetMetricsResult> {
  const devToken = resolveDeveloperToken(deps.tenantId);
  if (!devToken) return { outcome: 'failed', error: 'no_developer_token' };
  const customerId = args.adAccountId.replace(/[^0-9]/g, '');
  const dateClause = args.window === 'yesterday' ? ' AND segments.date DURING YESTERDAY' : '';
  // Select segments.date on the yesterday window so the row is dated by the
  // platform's account-timezone day (CONN-1), not a UTC label.
  const dateField = args.window === 'yesterday' ? ', segments.date' : '';
  const query = `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.average_cpc${dateField} FROM campaign WHERE campaign.id = ${args.campaignId.replace(/[^0-9]/g, '')}${dateClause}`;
  const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER.google, url: `${googleApiBase()}/customers/${customerId}/googleAds:search`, body: JSON.stringify({ query }), extraHeaders: { 'developer-token': devToken } });
  if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
  if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
  let json: { results?: Array<{ metrics?: Record<string, unknown>; segments?: Record<string, unknown> }>; error?: { message?: string } };
  try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
  if (!r.res.ok || json.error) return { outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` };
  const m = json.results?.[0]?.metrics ?? {};
  const segDate = json.results?.[0]?.segments?.date;
  const googleDate = typeof segDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(segDate) ? segDate : undefined;
  await stampConnectionUse(deps.storage, deps.runId, r.provenance).catch((e) => log.warn('ads metrics connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  // Google money fields are micros (÷1e6 → major units).
  return { outcome: 'ok', platform: 'google', metrics: { impressions: num(m.impressions), clicks: num(m.clicks), spend: num(m.costMicros ?? m.cost_micros) / 1e6, ctr: num(m.ctr), cpc: num(m.averageCpc ?? m.average_cpc) / 1e6 }, ...(googleDate ? { date: googleDate } : {}) };
}

// ── Read: account-scope daily metrics (ADR 0907 D3) ─────────────────────────────
// The whole ad account (not one dispatched campaign), daily rows over a date
// range, paged to exhaustion, with conversions + revenue. READ-ONLY.
//
// Host pinning: paging follows Meta's `after` CURSOR and Google's `pageToken`,
// never the absolute `paging.next` URL a response carries, so a response can
// never steer the broker's token to another host. A page cap stops a runaway
// account; hitting it is reported (`truncated`), never a silent cut.
export interface GetAccountMetricsArgs {
  platform: AdPlatform;
  adAccountId: string;
  level: 'campaign' | 'adset';
  /** Inclusive ISO dates (YYYY-MM-DD), in the ad account's timezone. */
  since: string;
  until: string;
  /** Meta: which `actions[].action_type`s count as conversions (and whose
   *  `action_values` count as revenue). Default ACCOUNT_DEFAULT_CONVERSION_ACTIONS. */
  conversionActionTypes?: readonly string[];
}
export interface AccountMetricsRow {
  date: string;
  campaignId: string;
  campaignName: string;
  adSetId?: string;
  adSetName?: string;
  impressions: number;
  clicks: number;
  /** Major currency units. */
  spend: number;
  /** `null` when the platform cannot report it (ADR 0907 D3: never a fake 0). */
  conversions: number | null;
  /** Major currency units; `null` when the platform cannot report it. */
  revenue: number | null;
  /** ISO-4217 account currency, when the platform reports it. */
  currency?: string;
}
export type GetAccountMetricsResult =
  | { outcome: 'no_connection' }
  | { outcome: 'unsupported'; platform: AdPlatform; reason?: 'not_sandbox_verified' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'rate_limited'; retryAfterS?: number }
  | { outcome: 'ok'; platform: AdPlatform; rows: AccountMetricsRow[]; pages: number; truncated: boolean };

/** Meta's standard pixel conversions, used when a connection names none. */
export const ACCOUNT_DEFAULT_CONVERSION_ACTIONS: readonly string[] = ['offsite_conversion.fb_pixel_purchase', 'lead', 'complete_registration'];
/** Pages per account-metrics read. 50 × 500 Meta rows / 50 × 10k Google rows. */
export const ACCOUNT_METRICS_MAX_PAGES = 50;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

type MetaAction = { action_type?: unknown; value?: unknown };
function sumActions(list: unknown, types: ReadonlySet<string>): number {
  if (!Array.isArray(list)) return 0;
  let total = 0;
  for (const a of list as MetaAction[]) if (typeof a.action_type === 'string' && types.has(a.action_type)) total += num(a.value);
  return total;
}

async function metaAccountMetrics(deps: BrokeredEgressDeps, args: GetAccountMetricsArgs): Promise<GetAccountMetricsResult> {
  const acct = `act_${args.adAccountId.replace(/^act_/, '').replace(/[^0-9]/g, '')}`;
  const types = new Set(args.conversionActionTypes?.length ? args.conversionActionTypes : ACCOUNT_DEFAULT_CONVERSION_ACTIONS);
  const fields = ['campaign_id', 'campaign_name', ...(args.level === 'adset' ? ['adset_id', 'adset_name'] : []), 'impressions', 'clicks', 'spend', 'actions', 'action_values', 'account_currency', 'date_start'].join(',');
  const params = new URLSearchParams({
    level: args.level, time_increment: '1', limit: '500', fields,
    time_range: JSON.stringify({ since: args.since, until: args.until }),
  });
  const rows: AccountMetricsRow[] = [];
  let after: string | undefined;
  let pages = 0;
  let provenance: Provenance | undefined;
  for (;;) {
    if (pages >= ACCOUNT_METRICS_MAX_PAGES) return { outcome: 'ok', platform: 'meta', rows, pages, truncated: true };
    if (after) params.set('after', after);
    const r = await brokeredFetch(deps, { provider: PLATFORM_PROVIDER.meta, url: `${metaApiBase()}/${acct}/insights?${params.toString()}`, method: 'GET' });
    if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
    if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
    if (r.res.status === 429) return { outcome: 'rate_limited', ...(retryAfterSeconds(r.res) !== undefined ? { retryAfterS: retryAfterSeconds(r.res) } : {}) };
    let json: { data?: Array<Record<string, unknown>>; paging?: { cursors?: { after?: unknown }; next?: unknown }; error?: { message?: string; code?: number } };
    try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
    // Meta reports throttling as error code 17 / 80000-series inside a 400.
    if (json.error && (json.error.code === 17 || json.error.code === 80000 || json.error.code === 80004)) return { outcome: 'rate_limited' };
    if (!r.res.ok || json.error) return { outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` };
    provenance = r.provenance;
    pages += 1;
    for (const row of json.data ?? []) {
      const date = typeof row.date_start === 'string' && ISO_DAY.test(row.date_start) ? row.date_start : undefined;
      if (!date || typeof row.campaign_id !== 'string') continue;
      rows.push({
        date, campaignId: row.campaign_id, campaignName: typeof row.campaign_name === 'string' ? row.campaign_name : row.campaign_id,
        ...(typeof row.adset_id === 'string' ? { adSetId: row.adset_id, adSetName: typeof row.adset_name === 'string' ? row.adset_name : row.adset_id } : {}),
        impressions: num(row.impressions), clicks: num(row.clicks), spend: num(row.spend),
        conversions: sumActions(row.actions, types), revenue: sumActions(row.action_values, types),
        ...(typeof row.account_currency === 'string' && /^[A-Z]{3}$/.test(row.account_currency) ? { currency: row.account_currency } : {}),
      });
    }
    const next = json.paging?.cursors?.after;
    // Meta keeps a cursor on the last page; `paging.next` is what says more exist.
    if (typeof next !== 'string' || !next || !json.paging?.next) break;
    after = next;
  }
  if (provenance) await stampConnectionUse(deps.storage, deps.runId, provenance).catch((e) => log.warn('ads account metrics connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  return { outcome: 'ok', platform: 'meta', rows, pages, truncated: false };
}

async function googleAccountMetrics(deps: BrokeredEgressDeps, args: GetAccountMetricsArgs): Promise<GetAccountMetricsResult> {
  const devToken = resolveDeveloperToken(deps.tenantId);
  if (!devToken) return { outcome: 'failed', error: 'no_developer_token' };
  const customerId = args.adAccountId.replace(/[^0-9]/g, '');
  const resource = args.level === 'adset' ? 'ad_group' : 'campaign';
  const select = ['campaign.id', 'campaign.name', ...(args.level === 'adset' ? ['ad_group.id', 'ad_group.name'] : []), 'segments.date',
    'metrics.impressions', 'metrics.clicks', 'metrics.cost_micros', 'metrics.conversions', 'metrics.conversions_value', 'customer.currency_code'].join(', ');
  // since/until are validated ISO days before reaching here (GAQL takes literals).
  const query = `SELECT ${select} FROM ${resource} WHERE segments.date BETWEEN '${args.since}' AND '${args.until}'`;
  const rows: AccountMetricsRow[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let provenance: Provenance | undefined;
  type GRow = { campaign?: Record<string, unknown>; adGroup?: Record<string, unknown>; segments?: Record<string, unknown>; metrics?: Record<string, unknown>; customer?: Record<string, unknown> };
  for (;;) {
    if (pages >= ACCOUNT_METRICS_MAX_PAGES) return { outcome: 'ok', platform: 'google', rows, pages, truncated: true };
    const r = await brokeredPost(deps, {
      provider: PLATFORM_PROVIDER.google, url: `${googleApiBase()}/customers/${customerId}/googleAds:search`,
      body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }), extraHeaders: { 'developer-token': devToken },
    });
    if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
    if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
    if (r.res.status === 429) return { outcome: 'rate_limited', ...(retryAfterSeconds(r.res) !== undefined ? { retryAfterS: retryAfterSeconds(r.res) } : {}) };
    let json: { results?: GRow[]; nextPageToken?: unknown; error?: { message?: string; status?: string } };
    try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
    if (json.error?.status === 'RESOURCE_EXHAUSTED') return { outcome: 'rate_limited' };
    if (!r.res.ok || json.error) return { outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` };
    provenance = r.provenance;
    pages += 1;
    for (const g of json.results ?? []) {
      const date = typeof g.segments?.date === 'string' && ISO_DAY.test(g.segments.date) ? g.segments.date : undefined;
      const cid = g.campaign?.id !== undefined ? String(g.campaign.id) : undefined;
      if (!date || !cid) continue;
      const m = g.metrics ?? {};
      const cur = g.customer?.currencyCode;
      rows.push({
        date, campaignId: cid, campaignName: typeof g.campaign?.name === 'string' ? g.campaign.name : cid,
        ...(g.adGroup?.id !== undefined ? { adSetId: String(g.adGroup.id), adSetName: typeof g.adGroup.name === 'string' ? g.adGroup.name : String(g.adGroup.id) } : {}),
        impressions: num(m.impressions), clicks: num(m.clicks), spend: num(m.costMicros) / 1e6,
        conversions: num(m.conversions), revenue: num(m.conversionsValue),
        ...(typeof cur === 'string' && /^[A-Z]{3}$/.test(cur) ? { currency: cur } : {}),
      });
    }
    if (typeof json.nextPageToken !== 'string' || !json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  if (provenance) await stampConnectionUse(deps.storage, deps.runId, provenance).catch((e) => log.warn('ads account metrics connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  return { outcome: 'ok', platform: 'google', rows, pages, truncated: false };
}


/** TikTok `report/integrated/get` page size (the documented maximum). */
const TIKTOK_REPORT_PAGE_SIZE = 1000;
/** LinkedIn adAnalytics returns at most this many elements and does not page. */
export const LINKEDIN_ANALYTICS_MAX_ELEMENTS = 15000;

/** TikTok BASIC report, campaign level, one row per (campaign, day). TikTok
 *  reports conversions (`conversion` — the optimisation event) but no revenue
 *  metric this reader can rely on, so revenue is `null` (ADR 0907 D3: never a
 *  fake 0). Spend is in the advertiser's currency, major units. */
async function tiktokAccountMetrics(deps: BrokeredEgressDeps, args: GetAccountMetricsArgs): Promise<GetAccountMetricsResult> {
  const rows: AccountMetricsRow[] = [];
  let page = 1;
  let pages = 0;
  let provenance: Provenance | undefined;
  for (;;) {
    if (pages >= ACCOUNT_METRICS_MAX_PAGES) return { outcome: 'ok', platform: 'tiktok', rows, pages, truncated: true };
    const url = buildTiktokReportUrl(tiktokApiBase(), args, page, TIKTOK_REPORT_PAGE_SIZE);
    const r = await brokeredFetch(deps, { provider: PLATFORM_PROVIDER.tiktok, url, method: 'GET', authScheme: 'raw', authHeaderName: 'access-token' });
    if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
    if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
    if (r.res.status === 429) return { outcome: 'rate_limited', ...(retryAfterSeconds(r.res) !== undefined ? { retryAfterS: retryAfterSeconds(r.res) } : {}) };
    let json: { code?: number; message?: string; data?: { list?: Array<{ dimensions?: Record<string, unknown>; metrics?: Record<string, unknown> }>; page_info?: { total_page?: unknown } } };
    try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
    // TikTok answers 200 with a code; 40100 is its QPS limit.
    if (json.code === 40100) return { outcome: 'rate_limited' };
    if (!r.res.ok || json.code !== 0) return { outcome: 'failed', error: json.message ?? `code_${json.code ?? r.res.status}` };
    provenance = r.provenance;
    pages += 1;
    for (const item of json.data?.list ?? []) {
      const d = item.dimensions ?? {};
      const m = item.metrics ?? {};
      const day = typeof d.stat_time_day === 'string' ? d.stat_time_day.slice(0, 10) : '';
      const cid = d.campaign_id ?? m.campaign_id;
      if (!ISO_DAY.test(day) || (typeof cid !== 'string' && typeof cid !== 'number')) continue;
      const campaignId = String(cid);
      rows.push({
        date: day, campaignId, campaignName: typeof m.campaign_name === 'string' && m.campaign_name ? m.campaign_name : campaignId,
        ...(args.level === 'adset' && d.adgroup_id !== undefined ? { adSetId: String(d.adgroup_id), adSetName: typeof m.adgroup_name === 'string' ? m.adgroup_name : String(d.adgroup_id) } : {}),
        impressions: num(m.impressions), clicks: num(m.clicks), spend: num(m.spend),
        conversions: num(m.conversion), revenue: null,
      });
    }
    const totalPage = num(json.data?.page_info?.total_page);
    if (page >= totalPage) break;
    page += 1;
  }
  if (provenance) await stampConnectionUse(deps.storage, deps.runId, provenance).catch((e) => log.warn('ads account metrics connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  return { outcome: 'ok', platform: 'tiktok', rows, pages, truncated: false };
}

/** LinkedIn adAnalytics, CAMPAIGN pivot, DAILY granularity. `costInLocalCurrency`
 *  is in MAJOR units (MyndHyve divided by 100 — its wart 10, not ported).
 *  Conversions are `externalWebsiteConversions`, revenue
 *  `conversionValueInLocalCurrency`. The endpoint does not page and caps the
 *  response; hitting the cap is reported as `truncated`. Analytics rows carry
 *  no campaign name, so the id stands in (a dispatched campaign keeps its
 *  launch name downstream). Ad-set level has no LinkedIn equivalent here. */
async function linkedinAccountMetrics(deps: BrokeredEgressDeps, args: GetAccountMetricsArgs): Promise<GetAccountMetricsResult> {
  if (args.level !== 'campaign') return { outcome: 'unsupported', platform: 'linkedin' };
  const r = await brokeredFetch(deps, {
    provider: PLATFORM_PROVIDER.linkedin, url: buildLinkedinAnalyticsUrl(linkedinApiBase(), args), method: 'GET',
    extraHeaders: { 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' },
  });
  if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
  if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
  if (r.res.status === 429) return { outcome: 'rate_limited', ...(retryAfterSeconds(r.res) !== undefined ? { retryAfterS: retryAfterSeconds(r.res) } : {}) };
  let json: { elements?: Array<Record<string, unknown>>; message?: string };
  try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
  if (!r.res.ok) return { outcome: 'failed', error: json.message ?? `http_${r.res.status}` };
  const rows: AccountMetricsRow[] = [];
  const elements = json.elements ?? [];
  for (const el of elements) {
    const start = (el.dateRange as { start?: { year?: number; month?: number; day?: number } } | undefined)?.start;
    if (!start?.year || !start.month || !start.day) continue;
    const date = `${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`;
    const urn = Array.isArray(el.pivotValues) && typeof el.pivotValues[0] === 'string' ? el.pivotValues[0] : '';
    const campaignId = urn.replace(/^urn:li:sponsoredCampaign:/, '');
    if (!ISO_DAY.test(date) || !campaignId) continue;
    rows.push({
      date, campaignId, campaignName: `LinkedIn campaign ${campaignId}`,
      impressions: num(el.impressions), clicks: num(el.clicks), spend: num(el.costInLocalCurrency),
      conversions: num(el.externalWebsiteConversions), revenue: num(el.conversionValueInLocalCurrency),
    });
  }
  await stampConnectionUse(deps.storage, deps.runId, r.provenance).catch((e) => log.warn('ads account metrics connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  return { outcome: 'ok', platform: 'linkedin', rows, pages: 1, truncated: elements.length >= LINKEDIN_ANALYTICS_MAX_ELEMENTS };
}

// ── Mutate: campaign daily budget (ADR 0186 slice 4b) ────────────────────────────
// The one LIVE-SPEND mutation. Safe by construction: `dryRun` DEFAULTS on at the node,
// a budget-set is idempotent (PUT-like — re-applying the same value on replay/fork is a
// harmless no-op, so NO dispatch record is needed), and it does NOT unpause a campaign
// (no spend-from-nothing). Wrong-value risk is bounded upstream by the chain's guardrail
// + approval gate. `unsupported` for a platform without a writer (tiktok today).
export interface UpdateBudgetArgs { platform: AdPlatform; adAccountId: string; campaignId: string; dailyBudgetMinor: number; dryRun?: boolean; }
export type UpdateBudgetResult =
  | { outcome: 'no_connection' }
  | { outcome: 'unsupported'; platform: AdPlatform }
  | { outcome: 'failed'; error: string }
  | { outcome: 'requires_approval'; approvalId: string }
  | { outcome: 'preview'; platform: AdPlatform; dailyBudgetMinor: number; target: string }
  | { outcome: 'updated'; platform: AdPlatform; dailyBudgetMinor: number; target: string };

async function metaBudget(deps: BrokeredEgressDeps, args: UpdateBudgetArgs): Promise<UpdateBudgetResult> {
  // Meta: update the campaign object's daily_budget (CBO). Target is the campaign id.
  const target = args.campaignId;
  if (args.dryRun) return { outcome: 'preview', platform: 'meta', dailyBudgetMinor: args.dailyBudgetMinor, target };
  const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER.meta, url: `${metaApiBase()}/${encodeURIComponent(target)}`, body: JSON.stringify({ daily_budget: args.dailyBudgetMinor }) });
  if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
  if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
  let json: { success?: boolean; id?: string; error?: { message?: string } };
  try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
  if (!r.res.ok || json.error) return { outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` };
  await stampConnectionUse(deps.storage, deps.runId, r.provenance).catch((e) => log.warn('ads budget connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  return { outcome: 'updated', platform: 'meta', dailyBudgetMinor: args.dailyBudgetMinor, target };
}

async function googleBudget(deps: BrokeredEgressDeps, args: UpdateBudgetArgs): Promise<UpdateBudgetResult> {
  const devToken = resolveDeveloperToken(deps.tenantId);
  const customerId = args.adAccountId.replace(/[^0-9]/g, '');
  const amountMicros = String(Math.round(args.dailyBudgetMinor) * 10000); // minor units → micros (×10^4)
  if (args.dryRun) return { outcome: 'preview', platform: 'google', dailyBudgetMinor: args.dailyBudgetMinor, target: `customers/${customerId} campaign ${args.campaignId}` };
  if (!devToken) return { outcome: 'failed', error: 'no_developer_token' };
  const extraHeaders = { 'developer-token': devToken };
  const base = googleApiBase();
  // 1) Resolve the campaign's budget resourceName.
  const query = `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${args.campaignId.replace(/[^0-9]/g, '')}`;
  const q = await brokeredPost(deps, { provider: PLATFORM_PROVIDER.google, url: `${base}/customers/${customerId}/googleAds:search`, body: JSON.stringify({ query }), extraHeaders });
  if (q.outcome === 'no_connection') return { outcome: 'no_connection' };
  if (q.outcome !== 'sent') return { outcome: 'failed', error: q.outcome === 'request_failed' ? (q.timedOut ? 'timeout' : 'request_failed') : q.outcome };
  let qjson: { results?: Array<{ campaign?: { campaignBudget?: string; campaign_budget?: string } }>; error?: { message?: string } };
  try { qjson = (await q.res.json()) as typeof qjson; } catch { return { outcome: 'failed', error: 'bad_response' }; }
  const budgetRn = qjson.results?.[0]?.campaign?.campaignBudget ?? qjson.results?.[0]?.campaign?.campaign_budget;
  if (!q.res.ok || qjson.error || !budgetRn) return { outcome: 'failed', error: qjson.error?.message ?? 'budget_not_found' };
  // The lookup used the connection too — stamp it (both legs recorded, code-review nit).
  await stampConnectionUse(deps.storage, deps.runId, q.provenance).catch((e) => log.warn('ads budget lookup connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  // 2) Mutate the budget's amount (updateMask targets amount_micros only).
  const m = await brokeredPost(deps, {
    provider: PLATFORM_PROVIDER.google, extraHeaders,
    url: `${base}/customers/${customerId}/campaignBudgets:mutate`,
    body: JSON.stringify({ operations: [{ update: { resourceName: budgetRn, amountMicros }, updateMask: 'amount_micros' }] }),
  });
  if (m.outcome === 'no_connection') return { outcome: 'no_connection' };
  if (m.outcome !== 'sent') return { outcome: 'failed', error: m.outcome === 'request_failed' ? (m.timedOut ? 'timeout' : 'request_failed') : m.outcome };
  let mjson: { results?: Array<{ resourceName?: string }>; error?: { message?: string } };
  try { mjson = (await m.res.json()) as typeof mjson; } catch { return { outcome: 'failed', error: 'bad_response' }; }
  if (!m.res.ok || mjson.error || !mjson.results?.[0]?.resourceName) return { outcome: 'failed', error: mjson.error?.message ?? `http_${m.res.status}` };
  await stampConnectionUse(deps.storage, deps.runId, m.provenance).catch((e) => log.warn('ads budget connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  return { outcome: 'updated', platform: 'google', dailyBudgetMinor: args.dailyBudgetMinor, target: budgetRn };
}

export interface SyncAudienceArgs {
  platform: AdPlatform;
  adAccountId: string;
  /** Platform-visible audience name (bounded upstream). */
  audienceName: string;
  /** SHA-256 hashes of normalized member emails — NEVER raw addresses. */
  memberHashes: string[];
  /** The upload's stable content key (audienceService.membersKey) — the
   *  approval / idempotency anchor. */
  membersKey: string;
}
export type SyncAudienceResult =
  | { outcome: 'no_connection' }
  | { outcome: 'unsupported'; platform: AdPlatform }
  | { outcome: 'failed'; error: string }
  | { outcome: 'requires_approval'; approvalId: string }
  | { outcome: 'synced'; platform: AdPlatform; platformAudienceId: string; uploaded: number };

export interface SendConversionArgs extends ConversionBodyArgs {
  platform: string;
  /** Google ONLY (ADR 0907 D5): the customer + conversion action resource
   *  name, from the org's Google pixel config. */
  google?: { customerId: string; conversionAction: string };
  /** Google ONLY: EEA consent signals, mapped from the relay's consent state. */
  consent?: GoogleConsent;
}
export type SendConversionResult =
  | { outcome: 'sent' }
  | { outcome: 'no_connection' }
  | { outcome: 'unsupported'; platform: string; reason?: 'not_sandbox_verified' }
  | { outcome: 'failed'; error: string };

export interface AdsAdapter {
  publishAd(args: PublishAdArgs): Promise<PublishAdResult>;
  /** Upload a hashed member list as a platform custom audience (ADR 0217 —
   *  Meta Custom Audiences / Google Customer Match seam). PII-adjacent, so the
   *  gate DEFAULTS to require-approval (actionPolicy['ads.audience'] unset ⇒
   *  approval; 'disabled' refuses). Hashes only — never raw addresses. */
  syncAudience(args: SyncAudienceArgs): Promise<SyncAudienceResult>;
  /** The tenant's dispatch-ledger rows (C2 sync + B5 checklist read) — ids +
   *  names only, never a token or creative bytes. */
  listDispatches(): Promise<DispatchLedgerRow[]>;
  /** ADR 0297 D1 follow-on — relay ONE consented conversion to a platform's
   *  conversions API (Meta CAPI / TikTok Events). Hashed identifiers only —
   *  the relay intake hashed the email server-side and the visitor granted
   *  marketing consent AT COLLECTION, which is why this (unlike syncAudience's
   *  operator-pushed member lists) carries no approval gate. `unsupported` for
   *  platforms without a wired conversions API (google/linkedin today —
   *  their pixels stay client-side-only). Never throws. */
  sendConversion(args: SendConversionArgs): Promise<SendConversionResult>;
  /** Read a campaign's performance metrics from the connected platform (ADR 0186
   *  slice 4a). READ-ONLY; graceful `no_connection`; `unsupported` for a platform
   *  without a metrics reader (tiktok/linkedin today). Never throws. */
  getMetrics(args: GetMetricsArgs): Promise<GetMetricsResult>;
  /** Account-scope daily metrics over a date range (ADR 0907 D3): every
   *  campaign (or ad set) of the ad account, paged to exhaustion, with
   *  conversions + revenue. READ-ONLY; behind the per-(tenant, platform)
   *  circuit breaker; a platform 429 is `rate_limited`, never a failure that
   *  looks like missing data. `unsupported` without a reader. Never throws. */
  getAccountMetrics(args: GetAccountMetricsArgs): Promise<GetAccountMetricsResult>;
  /** Set a campaign's daily budget (ADR 0186 slice 4b) — the one live-spend mutation.
   *  `dryRun` returns a preview WITHOUT calling the platform. Idempotent + never
   *  unpauses; graceful `no_connection`; `unsupported` (tiktok/linkedin today). Never throws. */
  updateBudget(args: UpdateBudgetArgs): Promise<UpdateBudgetResult>;
}

/** ADR 0907 D5 — Google Ads `uploadClickConversions`, one row. Fails closed
 *  without a conversion action, a click id or identifier, or the developer
 *  token; a per-row `partialFailureError` is a failure, never a delivery. */
async function sendGoogleConversion(deps: BrokeredEgressDeps, args: SendConversionArgs): Promise<SendConversionResult> {
  const g = args.google;
  if (!g || !GOOGLE_CONVERSION_ACTION_RE.test(g.conversionAction)) return { outcome: 'failed', error: 'no_conversion_action' };
  if (!args.gclid && !args.gbraid && !args.wbraid && !args.emailHash && !args.phoneHashE164) return { outcome: 'failed', error: 'no_click_id_or_identifier' };
  const devToken = resolveDeveloperToken(deps.tenantId);
  if (!devToken) return { outcome: 'failed', error: 'no_developer_token' };
  const customerId = g.customerId.replace(/[^0-9]/g, '');
  const body = buildGoogleClickConversionBody({ ...args, conversionAction: g.conversionAction, consent: args.consent ?? { adUserData: 'DENIED', adPersonalization: 'DENIED' } });
  const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER.google, url: `${googleApiBase()}/customers/${customerId}:uploadClickConversions`, body: JSON.stringify(body), extraHeaders: { 'developer-token': devToken } });
  if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
  if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
  let json: { results?: Array<Record<string, unknown>>; partialFailureError?: { message?: string }; error?: { message?: string } };
  try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
  if (!r.res.ok || json.error) return { outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` };
  if (json.partialFailureError) return { outcome: 'failed', error: json.partialFailureError.message ?? 'partial_failure' };
  // A rejected row under partialFailure comes back as an EMPTY result object.
  const row = json.results?.[0];
  if (!row || Object.keys(row).length === 0) return { outcome: 'failed', error: 'conversion_not_accepted' };
  await stampConnectionUse(deps.storage, deps.runId, r.provenance).catch((e) => log.warn('ads conversion connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  return { outcome: 'sent' };
}

export function makeAdsAdapter(deps: BrokeredEgressDeps): AdsAdapter {
  const adapter: AdsAdapter = {
    async listDispatches() {
      return listTenantDispatchRecords(deps.tenantId);
    },
    async sendConversion(args) {
      // Meta CAPI, TikTok Events and Google Ads click conversions are wired;
      // LinkedIn conversions are ADR 0907 P5 (not built).
      if (args.platform !== 'meta' && args.platform !== 'tiktok' && args.platform !== 'google') {
        return { outcome: 'unsupported', platform: args.platform };
      }
      // ADR 0907 D2 — a sender not yet verified on the platform's test surface sends nothing.
      if (!adsSenderEnabled(args.platform)) return { outcome: 'unsupported', platform: args.platform, reason: 'not_sandbox_verified' };
      if (args.platform === 'google') return sendGoogleConversion(deps, args);
      const url = args.platform === 'meta'
        ? `${metaApiBase()}/${encodeURIComponent(args.pixelId)}/events`
        : `${tiktokApiBase()}/event/track/`;
      const body = args.platform === 'meta' ? buildMetaConversionBody(args) : buildTiktokConversionBody(args);
      // TikTok reads a RAW `Access-Token` header (the publish path's shape), never
      // `Authorization: Bearer` (ADR 0907 D1).
      const r = await brokeredPost(deps, {
        provider: PLATFORM_PROVIDER[args.platform], url, body: JSON.stringify(body),
        ...(args.platform === 'tiktok' ? { authScheme: 'raw' as const, authHeaderName: 'access-token' } : {}),
      });
      if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
      if (r.outcome === 'insecure_base') return { outcome: 'failed', error: 'insecure_base' };
      if (r.outcome === 'request_failed') return { outcome: 'failed', error: r.timedOut ? 'timeout' : 'request_failed' };
      let json: { code?: number; message?: string; error?: { message?: string } } | undefined;
      try { json = (await r.res.json()) as typeof json; } catch { json = undefined; }
      if (!r.res.ok) return { outcome: 'failed', error: json?.error?.message ?? json?.message ?? `http_${r.res.status}` };
      // TikTok answers HTTP 200 with `{code, message}`; a non-zero code is a
      // rejection, and reading it as delivered would mark the row sent forever.
      if (args.platform === 'tiktok' && json?.code !== 0) return { outcome: 'failed', error: json?.message ?? `code_${json?.code ?? 'missing'}` };
      await stampConnectionUse(deps.storage, deps.runId, r.provenance).catch((e) => log.warn('ads conversion connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
      return { outcome: 'sent' };
    },
    async syncAudience(args) {
      if (args.platform !== 'meta' && args.platform !== 'google') return { outcome: 'unsupported', platform: args.platform };
      if (args.memberHashes.length === 0) return { outcome: 'failed', error: 'empty_audience' };
      // PII-adjacent gate (ADR 0217): unlike the spend threshold, the DEFAULT is
      // require-approval — an unset policy still asks a human before member
      // hashes leave the host. Only an explicit 'draft-only'… has no meaning
      // here (no preview surface), so it behaves as approval too.
      const spendKey = `adsaud:${createHash('sha256').update(JSON.stringify([deps.tenantId, args.platform, args.adAccountId, args.audienceName, args.membersKey])).digest('hex')}`;
      let policy: Awaited<ReturnType<typeof getGovernancePolicy>> = null;
      try { policy = await getGovernancePolicy(deps.tenantId); }
      catch (e) { log.warn('ads audience policy read failed — treating as unset', { error: e instanceof Error ? e.message : String(e) }); }
      const kindPolicy = policy?.actionPolicy?.['ads.audience'];
      if (kindPolicy === 'disabled') return { outcome: 'failed', error: 'policy_disabled' };
      const mapped = await spendApprovals.get(spendKey).catch(() => undefined);
      let approved = false;
      if (mapped && mapped.tenantId === deps.tenantId) {
        const approval = await getApproval(mapped.approvalId);
        if (approval && approval.tenantId === deps.tenantId) {
          if (approval.status === 'approved') approved = true;
          else if (approval.status === 'rejected') return { outcome: 'failed', error: 'audience_approval_rejected' };
          else return { outcome: 'requires_approval', approvalId: approval.approvalId };
        }
      }
      if (!approved) {
        const approval = await createCampaignSpendApproval({
          tenantId: deps.tenantId, spendKind: 'audience', platform: args.platform,
          adAccountId: args.adAccountId, dailyBudgetMinor: 0, spendIdemKey: spendKey,
          proposal: `Upload a ${args.memberHashes.length}-member hashed custom audience "${args.audienceName}" to ${args.platform} (${args.adAccountId})`,
        });
        await spendApprovals.put({ spendKey, tenantId: deps.tenantId, approvalId: approval.approvalId }).catch((e) =>
          log.warn('ads audience-approval map write failed', { spendKey, error: e instanceof Error ? e.message : String(e) }));
        recordAdsAction(deps, 'approval-required', { platform: args.platform, kind: 'ads.audience', approvalId: approval.approvalId, audienceName: args.audienceName, members: args.memberHashes.length });
        return { outcome: 'requires_approval', approvalId: approval.approvalId };
      }

      // Dispatch (documented-complete payloads per ADR 0223 — authored to the
      // platforms' public API doc shapes; a live rejection still fails closed).
      if (args.platform === 'meta') {
        const acct = `act_${args.adAccountId.replace(/^act_/, '')}`;
        const create = await brokeredPost(deps, { provider: PLATFORM_PROVIDER.meta, url: `${metaApiBase()}/${acct}/customaudiences`, body: JSON.stringify({ name: args.audienceName, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' }) });
        if (create.outcome === 'no_connection') return { outcome: 'no_connection' };
        if (create.outcome !== 'sent') return { outcome: 'failed', error: create.outcome === 'request_failed' ? (create.timedOut ? 'timeout' : 'request_failed') : create.outcome };
        let cjson: { id?: string; error?: { message?: string } };
        try { cjson = (await create.res.json()) as typeof cjson; } catch { return { outcome: 'failed', error: 'bad_response' }; }
        if (!create.res.ok || cjson.error || !cjson.id) return { outcome: 'failed', error: cjson.error?.message ?? `http_${create.res.status}` };
        const users = await brokeredPost(deps, { provider: PLATFORM_PROVIDER.meta, url: `${metaApiBase()}/${encodeURIComponent(cjson.id)}/users`, body: JSON.stringify({ payload: { schema: 'EMAIL_SHA256', data: args.memberHashes } }) });
        if (users.outcome !== 'sent' || !users.res.ok) return { outcome: 'failed', error: users.outcome !== 'sent' ? 'request_failed' : `http_${users.res.status}` };
        await stampConnectionUse(deps.storage, deps.runId, users.provenance).catch((e) => log.warn('ads audience connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
        recordAdsAction(deps, 'audience-synced', { platform: 'meta', platformAudienceId: cjson.id, audienceName: args.audienceName, uploaded: args.memberHashes.length, adAccountId: args.adAccountId });
        return { outcome: 'synced', platform: 'meta', platformAudienceId: cjson.id, uploaded: args.memberHashes.length };
      }
      // Google Customer Match — user list create + the MEMBER UPLOAD (ADR 0217's
      // deferral, closed by ADR 0223): offlineUserDataJobs create (CUSTOMER_MATCH_
      // USER_LIST bound to the list) → :addOperations (hashed-email identifiers,
      // ≤ 20 per operation per the UserData limit) → :run. Hashes only.
      const devToken = resolveDeveloperToken(deps.tenantId);
      if (!devToken) return { outcome: 'failed', error: 'no_developer_token' };
      const customerId = args.adAccountId.replace(/[^0-9]/g, '');
      const gBase = googleApiBase();
      const extraHeaders = { 'developer-token': devToken };
      type GLeg = { outcome: 'no_connection' } | { outcome: 'failed'; error: string } | { outcome: 'ok'; json: Record<string, unknown>; provenance: Provenance };
      const gPost = async (url: string, body: Record<string, unknown>): Promise<GLeg> => {
        const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER.google, extraHeaders, url, body: JSON.stringify(body) });
        if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
        if (r.outcome !== 'sent') return { outcome: 'failed', error: r.outcome === 'request_failed' ? (r.timedOut ? 'timeout' : 'request_failed') : r.outcome };
        let json: Record<string, unknown> & { error?: { message?: string } };
        try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
        if (!r.res.ok || json.error) return { outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` };
        return { outcome: 'ok', json, provenance: r.provenance };
      };
      // 1) The CRM-based user list.
      const listRes = await gPost(`${gBase}/customers/${customerId}/userLists:mutate`,
        { operations: [{ create: { name: args.audienceName, crmBasedUserList: { uploadKeyType: 'CONTACT_INFO' } } }] });
      if (listRes.outcome !== 'ok') return listRes;
      const rn = (listRes.json.results as Array<{ resourceName?: string }> | undefined)?.[0]?.resourceName;
      if (!rn) return { outcome: 'failed', error: 'user_list_create_failed' };
      // 2) The offline user-data job bound to the list.
      const jobRes = await gPost(`${gBase}/customers/${customerId}/offlineUserDataJobs:create`,
        { job: { type: 'CUSTOMER_MATCH_USER_LIST', customerMatchUserListMetadata: { userList: rn } } });
      if (jobRes.outcome !== 'ok') return jobRes;
      const jobRn = typeof jobRes.json.resourceName === 'string' ? jobRes.json.resourceName : undefined;
      if (!jobRn) return { outcome: 'failed', error: 'user_data_job_create_failed' };
      // 3) Members — one create operation per ≤ 20 hashed-email identifiers,
      //    sent in bounded REQUESTS (grade-code AUDIT-15): a single addOperations
      //    request holding every operation exceeds Google's request-size limit on
      //    a large audience. Chunk operations across requests (≤1000 ops/request,
      //    ≈20k members) and enablePartialFailure so one bad identifier doesn't
      //    fail the whole upload.
      const operations: Array<{ create: { userIdentifiers: Array<{ hashedEmail: string }> } }> = [];
      for (let i = 0; i < args.memberHashes.length; i += 20) {
        operations.push({ create: { userIdentifiers: args.memberHashes.slice(i, i + 20).map((hashedEmail) => ({ hashedEmail })) } });
      }
      const OPS_PER_REQUEST = 1000;
      for (let i = 0; i < operations.length; i += OPS_PER_REQUEST) {
        const addRes = await gPost(`${gBase}/${jobRn}:addOperations`, { enablePartialFailure: true, operations: operations.slice(i, i + OPS_PER_REQUEST) });
        if (addRes.outcome !== 'ok') return addRes;
      }
      // 4) Run the job (Google processes the match asynchronously platform-side).
      const runRes = await gPost(`${gBase}/${jobRn}:run`, {});
      if (runRes.outcome !== 'ok') return runRes;
      await stampConnectionUse(deps.storage, deps.runId, runRes.provenance).catch((e) => log.warn('ads audience connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
      recordAdsAction(deps, 'audience-synced', { platform: 'google', platformAudienceId: rn, audienceName: args.audienceName, uploaded: args.memberHashes.length, adAccountId: args.adAccountId });
      return { outcome: 'synced', platform: 'google', platformAudienceId: rn, uploaded: args.memberHashes.length };
    },
    async updateBudget(args) {
      let effective = args;
      if (!effective.dryRun) {
        const gate = await evaluateSpendGate(deps, 'ads.budget', budgetSpendKey(deps, effective), effective.dailyBudgetMinor, {
          platform: effective.platform, adAccountId: effective.adAccountId, platformCampaignId: effective.campaignId,
          summary: `Set ${effective.platform} campaign ${effective.campaignId} daily budget to ${effective.dailyBudgetMinor} (minor units)`,
        });
        if (gate.verdict === 'disabled') return { outcome: 'failed', error: 'policy_disabled' };
        if (gate.verdict === 'draft-only') effective = { ...effective, dryRun: true };
        else if (gate.verdict === 'requires-approval') {
          if (gate.approvalStatus === 'rejected') return { outcome: 'failed', error: 'spend_approval_rejected' };
          return { outcome: 'requires_approval', approvalId: gate.approvalId };
        }
      }
      const result = effective.platform === 'meta' ? await metaBudget(deps, effective)
        : effective.platform === 'google' ? await googleBudget(deps, effective)
        : ({ outcome: 'unsupported', platform: effective.platform } as UpdateBudgetResult);
      if (result.outcome === 'updated') {
        recordAdsAction(deps, 'budget-updated', {
          platform: effective.platform, platformCampaignId: effective.campaignId,
          adAccountId: effective.adAccountId, dailyBudgetMinor: effective.dailyBudgetMinor,
        });
      }
      return result;
    },
    async getAccountMetrics(args) {
      const reader = { meta: metaAccountMetrics, google: googleAccountMetrics, tiktok: tiktokAccountMetrics, linkedin: linkedinAccountMetrics }[args.platform];
      if (!reader) return { outcome: 'unsupported', platform: args.platform };
      // ADR 0907 D2 — a reader not yet exercised against the platform's test
      // surface is never presented as working.
      if (!adsReaderEnabled(args.platform)) return { outcome: 'unsupported', platform: args.platform, reason: 'not_sandbox_verified' };
      if (!ISO_DAY.test(args.since) || !ISO_DAY.test(args.until) || args.since > args.until) return { outcome: 'failed', error: 'invalid_date_range' };
      if (!/[0-9]/.test(args.adAccountId)) return { outcome: 'failed', error: 'invalid_ad_account' };
      // ADR 0357 P6 breaker, extended to reads (ADR 0907 D3): an open circuit is
      // a graceful refusal with no platform call.
      const breakerKey = `ads:${args.platform}`;
      if (circuitStatus(deps.tenantId, breakerKey) === 'open') return { outcome: 'failed', error: 'circuit_open' };
      const out = await reader(deps, args);
      if (out.outcome === 'ok') reportConnectionSuccess(deps.tenantId, breakerKey);
      else if (out.outcome === 'rate_limited' || (out.outcome === 'failed' && isBreakerReportableFailure(out.error))) reportConnectionFailure(deps.tenantId, breakerKey);
      return out;
    },
    async getMetrics(args) {
      if (args.platform === 'meta') return metaMetrics(deps, args);
      if (args.platform === 'google') return googleMetrics(deps, args);
      return { outcome: 'unsupported', platform: args.platform };
    },
    async publishAd(args) {
      const strategy = STRATEGIES[args.platform];
      if (!strategy) return { outcome: 'failed', error: 'unsupported_platform' };

      // ADR 0411 §P3c — video-dispatch guards, BEFORE any spend-gate/approval side
      // effect. Google/LinkedIn are not reel targets (no video creative surface here);
      // a LIVE video dispatch fails closed until the P3c live smoke validates the
      // upload transport + video_status poll + thumbnail (a money path — never a
      // guessed live call). A video DRY-RUN on Meta/TikTok falls through so the
      // strategy can build the documented, side-effect-free video PLAN.
      if (args.mediaKind === 'video') {
        if (args.platform === 'google' || args.platform === 'linkedin') return { outcome: 'failed', error: 'video_unsupported_platform' };
        if (!args.dryRun) return { outcome: 'failed', error: 'video_dispatch_live_pending' };
      }

      // ADR 0907 P0 — Google's EU political declaration is checked HERE, before the
      // spend gate, so a missing attestation never mints an approval a human then
      // signs for a dispatch that cannot succeed. (The strategy re-checks.)
      if (args.platform === 'google' && !args.dryRun && !args.euPoliticalAdvertising) return { outcome: 'failed', error: 'missing_eu_political_declaration' };

      // Fork-stable idempotency: a prior successful dispatch for this key short-circuits —
      // no second campaign on retry/sweeper/:fork. (Sequential/fork-safe; not CAS-guarded
      // against truly-simultaneous double-submit, which is bounded harmless by PAUSED.)
      const idemKey = idemKeyFor(deps, args);
      const prior = await dispatched.get(idemKey).catch(() => undefined);
      const priorIsOurs = !!prior && prior.tenantId === deps.tenantId;

      // Dry-run: build the exact create payloads and return them as a plan. Makes ZERO
      // platform calls and persists NOTHING — pure preview. We surface whether a real
      // dispatch already exists for this key (so a UI can warn "this would be a no-op")
      // but never short-circuit to 'published' — a preview must stay side-effect-free.
      if (args.dryRun) {
        const pr = await strategy(deps, args);
        if (pr.kind === 'no_connection') return { outcome: 'no_connection' };
        if (pr.kind === 'failed') return { outcome: 'failed', error: pr.error };
        if (pr.kind !== 'preview') return { outcome: 'failed', error: 'preview_unavailable' };
        // Connection-readiness: a SELECTION-only check (no egress, no secret
        // decrypt/refresh) so the preview can honestly say whether a real dispatch
        // would find a connection — without breaking the zero-call invariant.
        const connectionReady = await connectionExists({
          tenantId: deps.tenantId, provider: PLATFORM_PROVIDER[args.platform],
          ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
          ...(deps.orgId ? { orgId: deps.orgId } : {}),
        }).catch(() => false);
        return {
          outcome: 'preview', platform: args.platform, plan: pr.plan, alreadyDispatched: priorIsOurs, connectionReady,
          ...(priorIsOurs ? { platformCampaignId: prior!.platformCampaignId } : {}),
        };
      }

      if (prior && priorIsOurs) {
        return {
          outcome: 'published', platform: prior.platform, reused: true, paused: true, reviewStatus: 'pending_review',
          platformCampaignId: prior.platformCampaignId, platformAdSetId: prior.platformAdSetId, platformAdId: prior.platformAdId,
        };
      }

      // Spend governance (§5B B3): policy gate on the LIVE dispatch path only —
      // dry-runs are side-effect-free previews and a reused prior creates no new
      // spend surface, so both bypass the gate.
      const gate = await evaluateSpendGate(deps, 'ads.publish', idemKey, args.dailyBudgetMinor, {
        platform: args.platform, adAccountId: args.adAccountId, briefId: args.briefId,
        summary: `Publish ${args.platform} campaign "${args.campaignName}" (PAUSED) with daily budget ${args.dailyBudgetMinor ?? 0} (minor units)`,
      });
      if (gate.verdict === 'disabled') return { outcome: 'failed', error: 'policy_disabled' };
      if (gate.verdict === 'requires-approval') {
        if (gate.approvalStatus === 'rejected') return { outcome: 'failed', error: 'spend_approval_rejected' };
        return { outcome: 'requires_approval', approvalId: gate.approvalId };
      }
      if (gate.verdict === 'draft-only') {
        // 'draft-only' policy: behave exactly like an explicit dryRun preview.
        return adapter.publishAd({ ...args, dryRun: true });
      }

      // ADR 0354 P1 — brand-compliance gate (after spend: cheapest-first). The
      // checker fails CLOSED under a non-off policy (its own contract); here an
      // absent checker or an 'allow' verdict proceeds. 'requires-approval'
      // reuses the campaign-spend approval flow with a compliance-keyed idem
      // (fork-stable — hash of the same idemKey, never runId).
      if (complianceChecker) {
        // Score the human-readable copy VALUES (+ the campaign name), never the
        // JSON envelope — JSON syntax (quotes/braces/keys) must not feed the
        // deterministic scorer (BRAND-CODE-5 grade fix, finding "scored JSON.stringify").
        const content = [args.campaignName, args.copy.headline, args.copy.description, args.copy.bodyText, args.copy.ctaText]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join('\n');
        let cv: AdsComplianceVerdict = { verdict: 'allow' };
        try {
          cv = await complianceChecker(deps.tenantId, { briefId: args.briefId, platform: args.platform, content });
        } catch (e) {
          // The checker itself crashing is indistinguishable from "policy
          // unknown" — refuse open dispatch only if a brand policy might exist;
          // the checker's contract already fail-closes policy evaluation, so a
          // TRANSPORT crash here logs + allows (never a silent block).
          log.warn('ads compliance checker crashed — proceeding (checker owns fail-closed policy)', { error: e instanceof Error ? e.message : String(e) });
        }
        if (cv.verdict === 'requires-approval') {
          // Mirrors evaluateSpendGate: a mapped approval that LOADS drives the
          // verdict; a mapped approval that can't be loaded (e.g. a pruned
          // REJECTED row — approvalService.pruneResolved keeps only the newest
          // 100 resolved) falls through to RE-CREATE the approval. It must
          // never fall open to dispatch (BRAND-CODE-1 grade fix).
          const cKey = `cmpl:${idemKey}`;
          const mapped = await spendApprovals.get(cKey).catch(() => undefined);
          const approval = mapped && mapped.tenantId === deps.tenantId ? await getApproval(mapped.approvalId) : null;
          if (approval && approval.tenantId === deps.tenantId) {
            if (approval.status === 'rejected') return { outcome: 'failed', error: 'compliance_approval_rejected' };
            if (approval.status !== 'approved') return { outcome: 'requires_approval', approvalId: approval.approvalId };
            /* approved — human overrode, proceed */
          } else {
            const created = await createCampaignSpendApproval({
              tenantId: deps.tenantId,
              spendKind: 'publish',
              platform: args.platform,
              adAccountId: args.adAccountId,
              ...(args.briefId ? { briefId: args.briefId } : {}),
              dailyBudgetMinor: args.dailyBudgetMinor ?? 0,
              spendIdemKey: cKey,
              proposal: `BRAND COMPLIANCE: ${cv.reason ?? 'content flagged'}${typeof cv.score === 'number' ? ` (score ${cv.score})` : ''} — approve to publish anyway.`,
            });
            await spendApprovals.put({ spendKey: cKey, tenantId: deps.tenantId, approvalId: created.approvalId }).catch(() => undefined);
            recordAdsAction(deps, 'approval-required', { platform: args.platform, kind: 'ads.publish', approvalId: created.approvalId, compliance: true, ...(args.briefId ? { briefId: args.briefId } : {}) });
            return { outcome: 'requires_approval', approvalId: created.approvalId };
          }
        }
      }

      // ADR 0357 P6 — circuit breaker per (tenant, platform): open ⇒ graceful
      // refusal (no platform call); half-open lets this ONE call probe.
      const circuit = circuitStatus(deps.tenantId, `ads:${args.platform}`);
      if (circuit === 'open') return { outcome: 'failed', error: 'circuit_open' };
      const r = await strategy(deps, args);
      if (r.kind === 'no_connection') return { outcome: 'no_connection' };
      if (r.kind === 'failed') {
        if (isBreakerReportableFailure(r.error)) reportConnectionFailure(deps.tenantId, `ads:${args.platform}`);
        return { outcome: 'failed', error: r.error };
      }
      reportConnectionSuccess(deps.tenantId, `ads:${args.platform}`);
      if (r.kind !== 'ok') return { outcome: 'failed', error: 'preview_unavailable' }; // unreachable without dryRun (handled above); narrows the union

      // Success — persist the fork-stable idem record via CAS(null,…) so the LEDGER
      // is single-canonical (ADS-2). The platform CREATE already happened, so a
      // truly-simultaneous double-submit may leave two PAUSED campaigns platform-
      // side (no spend — the bounded residual); but only ONE ledger row wins, and
      // the loser returns the winner's ids with reused:true so its OUTPUT is
      // consistent. A storage hiccup must not throw (the types.ts contract) — log.
      const record: AdDispatchRecord = {
        idemKey, tenantId: deps.tenantId, platform: args.platform,
        platformCampaignId: r.ids.campaignId, platformAdSetId: r.ids.adSetId, platformAdId: r.ids.adId, createdAt: new Date().toISOString(),
        briefId: args.briefId, campaignName: args.campaignName, adAccountId: args.adAccountId,
        ...(args.dailyBudgetMinor !== undefined ? { dailyBudgetMinor: args.dailyBudgetMinor } : {}),
      };
      let ledgered = record;
      try {
        const won = await dispatched.compareAndSwap(null, record);
        if (!won) {
          const winner = await dispatched.get(idemKey).catch(() => undefined);
          if (winner && winner.tenantId === deps.tenantId) {
            log.warn('ads concurrent double-submit — reusing the winning ledger row (a duplicate PAUSED campaign may exist platform-side)', { idemKey });
            return {
              outcome: 'published', platform: winner.platform, reused: true, paused: true, reviewStatus: 'pending_review',
              platformCampaignId: winner.platformCampaignId, platformAdSetId: winner.platformAdSetId, platformAdId: winner.platformAdId,
            };
          }
          ledgered = record; // winner unreadable — fall through with our own ids
        }
      } catch (e) {
        log.warn('ads idempotency record write failed — a retry/fork may duplicate this campaign', { idemKey, error: e instanceof Error ? e.message : String(e) });
      }
      // CS-DATA-11 — best-effort per-tenant ledger cap (newest 500 kept).
      try { await trimDispatchLedger(deps.tenantId); }
      catch (e) { log.warn('ads dispatch-ledger trim failed', { error: e instanceof Error ? e.message : String(e) }); }
      try { await stampConnectionUse(deps.storage, deps.runId, r.provenance); }
      catch (e) { log.warn('ads connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }); }
      recordAdsAction(deps, 'dispatched', {
        platform: args.platform, briefId: args.briefId, platformCampaignId: ledgered.platformCampaignId,
        adAccountId: args.adAccountId, campaignName: args.campaignName,
        ...(args.dailyBudgetMinor !== undefined ? { dailyBudgetMinor: args.dailyBudgetMinor } : {}),
        paused: true,
      });

      return {
        outcome: 'published', platform: args.platform, reused: false, paused: true, reviewStatus: 'pending_review',
        platformCampaignId: ledgered.platformCampaignId, platformAdSetId: ledgered.platformAdSetId, platformAdId: ledgered.platformAdId,
      };
    },
  };
  return adapter;
}
