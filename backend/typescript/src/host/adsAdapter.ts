/**
 * Ads-dispatch egress adapter (ADR 0167 — Meta Phase 1, Google Phase 2) —
 * `ctx.ads.publishAd`. Turns an approved ad draft into a real, PAUSED ad-platform
 * campaign through the Connections broker, following the slack/sms/email adapter
 * precedent: it composes `brokeredPost`/`brokeredFetch` (the broker resolves the
 * acting human's ad-platform Connection + injects the OAuth token in-header) rather
 * than adding a second credential path.
 *
 * Structure: a small **shared spine** (`publishAd`) owns the fork-stable idempotency
 * lookup/record + the RFC 0079 provenance stamp; the per-platform create pipeline is a
 * `PlatformStrategy` (Meta = campaign→adset→ad; Google = budget→campaign→adGroup→ad
 * `:mutate`). A new platform adds a strategy, not a branch in the spine.
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
import { connectionExists } from '../features/connections/connectionsService.js';
import { DurableCollection } from './hostExtPersistence.js';

const log = createLogger('connections.ads');

type Provenance = Parameters<typeof stampConnectionUse>[2];

/** The ONE platform → connection-pack provider-id mapping. Every strategy and the
 *  dry-run readiness check source the provider from here, so the id can't drift
 *  between the dispatch call and the preview's connection check. */
const PLATFORM_PROVIDER: Record<AdPlatform, string> = { meta: 'meta-ads', google: 'google-ads', tiktok: 'tiktok-ads' };

/** Meta Marketing API base — hardcoded host (NEVER input-derived); test override only. */
function metaApiBase(): string {
  return (process.env.OPENWOP_META_API_BASE ?? 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
}
/** Google Ads API base — hardcoded host; test override only. */
function googleApiBase(): string {
  return (process.env.OPENWOP_GOOGLE_ADS_API_BASE ?? 'https://googleads.googleapis.com/v18').replace(/\/+$/, '');
}
/** TikTok Business API base — hardcoded host; test override only. */
function tiktokApiBase(): string {
  return (process.env.OPENWOP_TIKTOK_ADS_API_BASE ?? 'https://business-api.tiktok.com/open_api/v1.3').replace(/\/+$/, '');
}
/** Google Ads developer-token — an APP/manager-account-level credential (one per
 *  integration, NOT per-user BYOK), so it lives host-side as operator config, mirroring
 *  `OPENWOP_OAUTH_*_CLIENT_SECRET`. Read through this seam (not `process.env` at the call
 *  site) so a future per-tenant override slots in behind the same signature. */
function resolveDeveloperToken(_tenantId: string): string | undefined {
  return process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined;
}

export type AdPlatform = 'meta' | 'google' | 'tiktok';

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
  /** Required by Google for a responsive search ad (`finalUrls`). */
  landingUrl?: string;
  /** Preview mode (ADR 0167): build the exact create payloads and return them as a
   *  `plan` WITHOUT calling the platform — so a human can review precisely what would
   *  be created (status, budget, copy) before any real, money-spending dispatch.
   *  Makes ZERO platform calls and creates nothing. */
  dryRun?: boolean;
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
}
const dispatched = new DurableCollection<AdDispatchRecord>('ads:dispatch', (r) => r.idemKey);

/** Fork-stable: tenant + brief + platform + a hash of the ad content. NO runId.
 *  Components are JSON-encoded before hashing so a `:` inside a tenantId/briefId
 *  cannot collide two distinct tenants' keys (the record still stores tenantId for
 *  the read-side tenant check). */
function idemKeyFor(deps: BrokeredEgressDeps, a: PublishAdArgs): string {
  const adHash = createHash('sha256')
    .update(JSON.stringify({ n: a.campaignName, o: a.objective ?? '', c: a.copy, b: a.dailyBudgetMinor ?? 0, acct: a.adAccountId }))
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

// ── Meta (Phase 1) — campaign → adset → ad, all PAUSED ───────────────────────
const metaStrategy: PlatformStrategy = async (deps, args) => {
  const acct = `act_${args.adAccountId.replace(/^act_/, '')}`;
  const base = metaApiBase();
  const created: Array<{ kind: string; id: string }> = [];
  const plan: AdPlanStep[] = [];
  let provenance: Provenance | undefined;

  const post = async (edge: string, body: Record<string, unknown>): Promise<{ id: string } | { error: string }> => {
    // dryRun: record the exact body + return a placeholder id (so later steps build),
    // never touching the platform.
    if (args.dryRun) { plan.push({ step: edge, body }); return { id: `<${edge}-id>` }; }
    const r = await brokeredPost(deps, { provider: PLATFORM_PROVIDER[args.platform], url: `${base}/${acct}/${edge}`, body: JSON.stringify(body) });
    if (r.outcome === 'no_connection') return { error: 'no_connection' };
    if (r.outcome === 'insecure_base') return { error: 'insecure_base' };
    if (r.outcome === 'request_failed') return { error: r.timedOut ? 'timeout' : 'request_failed' };
    provenance = r.provenance;
    let json: { id?: string; error?: { message?: string } };
    try { json = (await r.res.json()) as typeof json; } catch { return { error: 'bad_response' }; }
    if (!r.res.ok || json.error || !json.id) return { error: json.error?.message ?? `http_${r.res.status}` };
    return { id: json.id };
  };
  const fail = async (error: string): Promise<StrategyResult> => {
    // Best-effort host-pinned DELETE cleanup (reverse). Un-deletable objects stay PAUSED — no spend.
    for (const obj of [...created].reverse()) {
      try { await brokeredFetch(deps, { provider: PLATFORM_PROVIDER[args.platform], url: `${base}/${obj.id}`, method: 'DELETE' }); }
      catch (e) { log.warn('ads rollback delete failed (object left PAUSED, no spend)', { kind: obj.kind, id: obj.id, error: e instanceof Error ? e.message : String(e) }); }
    }
    return error === 'no_connection' ? { kind: 'no_connection' } : { kind: 'failed', error };
  };

  const campaign = await post('campaigns', { name: args.campaignName, objective: args.objective ?? 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [] });
  if ('error' in campaign) return fail(campaign.error);
  created.push({ kind: 'campaign', id: campaign.id });
  const adset = await post('adsets', { name: `${args.campaignName} — Ad Set`, campaign_id: campaign.id, status: 'PAUSED', billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', ...(args.dailyBudgetMinor ? { daily_budget: args.dailyBudgetMinor } : {}) });
  if ('error' in adset) return fail(adset.error);
  created.push({ kind: 'adsets', id: adset.id });
  const ad = await post('ads', { name: `${args.campaignName} — Ad`, adset_id: adset.id, status: 'PAUSED', creative: { title: args.copy.headline, body: args.copy.bodyText ?? args.copy.description ?? '', call_to_action_type: args.copy.ctaText ?? 'LEARN_MORE' } });
  if ('error' in ad) return fail(ad.error);

  if (args.dryRun) return { kind: 'preview', plan };
  return { kind: 'ok', ids: { campaignId: campaign.id, adSetId: adset.id, adId: ad.id }, provenance: provenance! };
};

// ── Google Ads (Phase 2) — budget → campaign → adGroup → ad, all PAUSED ──────
const googleStrategy: PlatformStrategy = async (deps, args) => {
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
  // 2) Campaign — PAUSED.
  const campaign = await mutate('campaigns', { name: args.campaignName, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget.rn, manualCpc: {} });
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
    ad: { ...(args.landingUrl ? { finalUrls: [args.landingUrl] } : {}), responsiveSearchAd: { headlines, descriptions } },
  });
  if ('error' in ad) return fail(ad.error);

  if (args.dryRun) return { kind: 'preview', plan };
  return { kind: 'ok', ids: { campaignId: campaign.rn, adSetId: adGroup.rn, adId: ad.rn }, provenance: provenance! };
};

// ── TikTok Ads (Phase 3) — campaign → adgroup → ad, all DISABLE (paused) ─────
// TikTok authenticates with `Access-Token: <token>` (raw, NOT `Authorization: Bearer`)
// and returns HTTP 200 + `{ code, message, data }` (non-zero `code` is an error, like
// Slack's `{ok:false}`). No rollback (the source app has none; un-cleaned objects are
// DISABLE = no spend). The OAuth token is broker-resolved; the only caller-supplied
// piece is the public `advertiser_id`, placed in the BODY (never the URL).
const tiktokStrategy: PlatformStrategy = async (deps, args) => {
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

  // Campaign — DISABLE (paused), consistent with the cross-strategy created-PAUSED invariant.
  const campaign = await create('campaign/create/', 'campaign_id', { campaign_name: args.campaignName, objective_type: args.objective ?? 'TRAFFIC', budget_mode: 'BUDGET_MODE_DAY', budget: ((args.dailyBudgetMinor ?? 5000) / 100), operation_status: 'DISABLE' });
  if ('error' in campaign) return fail(campaign.error);
  // Ad group — DISABLE (paused).
  const adgroup = await create('adgroup/create/', 'adgroup_id', { campaign_id: campaign.id, adgroup_name: `${args.campaignName} — Ad Group`, operation_status: 'DISABLE' });
  if ('error' in adgroup) return fail(adgroup.error);
  // Ad — DISABLE (paused); carries the approved copy.
  const ad = await create('ad/create/', 'ad_id', { adgroup_id: adgroup.id, operation_status: 'DISABLE', creatives: [{ ad_name: `${args.campaignName} — Ad`, ad_text: args.copy.bodyText ?? args.copy.description ?? args.copy.headline, call_to_action: args.copy.ctaText ?? 'LEARN_MORE' }] });
  if ('error' in ad) return fail(ad.error);

  if (args.dryRun) return { kind: 'preview', plan };
  return { kind: 'ok', ids: { campaignId: campaign.id, adSetId: adgroup.id, adId: ad.id }, provenance: provenance! };
};

const STRATEGIES: Record<AdPlatform, PlatformStrategy> = { meta: metaStrategy, google: googleStrategy, tiktok: tiktokStrategy };

export interface AdsAdapter {
  publishAd(args: PublishAdArgs): Promise<PublishAdResult>;
}

export function makeAdsAdapter(deps: BrokeredEgressDeps): AdsAdapter {
  return {
    async publishAd(args) {
      const strategy = STRATEGIES[args.platform];
      if (!strategy) return { outcome: 'failed', error: 'unsupported_platform' };

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

      const r = await strategy(deps, args);
      if (r.kind === 'no_connection') return { outcome: 'no_connection' };
      if (r.kind === 'failed') return { outcome: 'failed', error: r.error };
      if (r.kind !== 'ok') return { outcome: 'failed', error: 'preview_unavailable' }; // unreachable without dryRun (handled above); narrows the union

      // Success — persist the fork-stable idem record FIRST (so a retry/fork short-circuits),
      // then stamp provenance. Both defended: the platform objects exist, so a storage hiccup
      // must not throw out of the adapter (the types.ts contract) — log loudly instead.
      try {
        await dispatched.put({
          idemKey, tenantId: deps.tenantId, platform: args.platform,
          platformCampaignId: r.ids.campaignId, platformAdSetId: r.ids.adSetId, platformAdId: r.ids.adId, createdAt: new Date().toISOString(),
        });
      } catch (e) {
        log.warn('ads idempotency record write failed — a retry/fork may duplicate this campaign', { idemKey, error: e instanceof Error ? e.message : String(e) });
      }
      try { await stampConnectionUse(deps.storage, deps.runId, r.provenance); }
      catch (e) { log.warn('ads connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }); }

      return {
        outcome: 'published', platform: args.platform, reused: false, paused: true, reviewStatus: 'pending_review',
        platformCampaignId: r.ids.campaignId, platformAdSetId: r.ids.adSetId, platformAdId: r.ids.adId,
      };
    },
  };
}
