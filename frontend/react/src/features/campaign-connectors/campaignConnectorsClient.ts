/**
 * Campaign Connectors API client (ADR 0159). CSV import + performance KPI under
 * /host/openwop-app/campaign-connectors/*.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type AdPlatform = 'google' | 'meta' | 'linkedin' | 'tiktok' | 'x' | 'pinterest' | 'snapchat' | 'reddit' | 'youtube';

export interface ImportResult { imported: number; deduped: number; invalid: number; issues: Array<{ row: number; severity: 'error' | 'warning'; message: string }> }
/** PERF-4 / ADR 0907: counts mean revenue was reported, including measured zero
 * and zero-spend rows. New servers always emit counts; absent older-server
 * fields retain legacy numeric rendering, not inferred availability. */
export interface KpiSummary {
  totals: { spend: number; impressions: number; clicks: number; conversions: number; revenue: number; ctr: number; cpc: number; cvr: number; cpa: number; roas: number; reportedRevenueRecordCount?: number };
  byPlatform: Array<{ platform: AdPlatform; spend: number; impressions: number; clicks: number; conversions: number; revenue: number; roas: number; reportedRevenueRecordCount?: number }>;
  recordCount: number;
  dateRange: { start: string; end: string } | null;
  /** CMPUX-15: display currency (campaign budget currency, or the unanimous
   *  currency across record-captured + campaign budget currencies, else USD).
   *  No FX. */
  currency: string;
  /** CC-G2 — the org's campaigns span MORE THAN ONE budget currency, so
   *  `currency` is a neutral default rather than a fact. Totals are then shown
   *  unlabelled (there is no FX, so they are not in any single currency). */
  currencyMixed?: boolean;
  /** R2 CC-SP-2 — FALSE when there is no currency evidence at all: `currency`
   *  is then a guess and figures render unlabelled. Absent = known (older
   *  backend, unchanged behaviour). */
  currencyKnown?: boolean;
  /** ADR 0907 D3 — records whose platform could not report conversions /
   *  revenue. Totals leave them out; ratios use only the reporting rows. */
  unreported?: { conversions: number; revenue: number };
}
export interface OrgRef { orgId: string; name: string }

export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/host/openwop-app/campaign-connectors`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    if (res.status === 404 && /not enabled/i.test(detail)) throw new FeatureDisabledError(detail);
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function importCsv(orgId: string, csv: string, defaultPlatform?: AdPlatform): Promise<ImportResult> {
  return asJson<ImportResult>(await fetch(`${base}/import`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, csv, ...(defaultPlatform ? { defaultPlatform } : {}) }) })), 'importCsv');
}
export type LiveSyncPlatform = 'meta' | 'google' | 'tiktok' | 'linkedin';
export type SyncScope = 'dispatched' | 'account';
export interface SyncFailure { adAccountId?: string; platformCampaignId?: string; reason: string; retryAfterS?: number }
export interface SyncResult {
  /** ADR 1022 D7 — `sync_failed`: no ad account returned data (a 502). */
  outcome: 'synced' | 'cooldown' | 'no_dispatches' | 'no_accounts' | 'not_verified' | 'sync_failed';
  /** `sync_failed`: the first account's reason. */
  reason?: string;
  retryAtIso?: string;
  platform?: string;
  scope?: SyncScope;
  /** ADR 0907 D3 — the look-back window that was pulled (inclusive). */
  since?: string;
  until?: string;
  date?: string;
  campaigns?: number;
  imported?: number;
  deduped?: number;
  failures?: SyncFailure[];
  /** TRUE when an account hit the page cap; the rows read did land. */
  truncated?: boolean;
}
/** Live pull of the 7-day look-back per the org's connector settings. 429 ⇒ cooldown. */
export async function syncNow(orgId: string, platform: LiveSyncPlatform): Promise<SyncResult> {
  const res = await fetch(`${base}/sync`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, platform }) }));
  // 429 = cooldown and 502 = sync_failed: both carry the outcome body. A 502
  // from the front door is HTML; only a body with an outcome is a result
  // (CP71UX-6), anything else is the ordinary typed error.
  if (res.status === 429 || res.status === 502) {
    let body: SyncResult | undefined;
    try { body = (await res.clone().json()) as SyncResult; } catch { /* an HTML gateway page: not a result */ }
    if (body && typeof body.outcome === 'string') return body;
  }
  return asJson<SyncResult>(res, 'syncNow');
}

/** ADR 0907 D3 — per-(org, platform) sync settings. */
export interface ConnectorSettings {
  orgId: string;
  platform: LiveSyncPlatform;
  syncScope: SyncScope;
  adAccountIds: string[];
  conversionActionTypes?: string[];
  updatedAt: string;
}
export async function getConnectorSettings(orgId: string, platform: LiveSyncPlatform): Promise<ConnectorSettings> {
  return (await asJson<{ settings: ConnectorSettings }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/connector-settings/${platform}`, fetchOpts({ headers: authedHeaders() })), 'getConnectorSettings')).settings;
}
export async function saveConnectorSettings(orgId: string, platform: LiveSyncPlatform, input: { syncScope: SyncScope; adAccountIds: string[]; conversionActionTypes?: string[] | null }): Promise<ConnectorSettings> {
  return (await asJson<{ settings: ConnectorSettings }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/connector-settings/${platform}`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) })), 'saveConnectorSettings')).settings;
}

export interface BackfillResult {
  outcome: 'progress' | 'done' | 'rate_limited' | 'busy' | 'no_dispatches' | 'no_accounts' | 'not_verified';
  targetSince?: string;
  remainingDays?: number;
  windowsDone?: number;
  imported?: number;
  failures?: SyncFailure[];
  truncated?: boolean;
  retryAtIso?: string;
}
/** One step of a resumable backfill (≤ 90 days). 429 ⇒ busy / rate-limited, both carry a body. */
export async function runBackfill(orgId: string, platform: LiveSyncPlatform, days: number): Promise<BackfillResult> {
  const res = await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/sync/backfill`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ platform, days }) }));
  if (res.status === 429) return (await res.json()) as BackfillResult;
  return asJson<BackfillResult>(res, 'runBackfill');
}

export async function getKpi(orgId: string): Promise<KpiSummary> {
  return asJson<KpiSummary>(await fetch(`${base}/kpi?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'getKpi');
}
export async function listOrgs(): Promise<OrgRef[]> {
  return (await asJson<{ orgs: OrgRef[] }>(await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}

export const AD_PLATFORMS: ReadonlyArray<AdPlatform> = ['google', 'meta', 'linkedin', 'tiktok', 'x', 'pinterest', 'snapchat', 'reddit', 'youtube'];

// ── ADR 0297 D1 / FNL-UX-3 — pixel configs ──────────────────────────────────
export const PIXEL_PLATFORMS = ['meta', 'google', 'tiktok'] as const;
export type PixelPlatform = (typeof PIXEL_PLATFORMS)[number];
export interface PixelConfig {
  platform: PixelPlatform; pixelId: string; active: boolean; updatedAt: string;
  /** Google ONLY (ADR 0907 D5): the Ads customer + event → conversion action map. */
  googleCustomerId?: string;
  conversionActions?: Record<string, string>;
}

export async function listPixels(orgId: string): Promise<PixelConfig[]> {
  return (await asJson<{ pixels: PixelConfig[] }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/pixels`, fetchOpts({ headers: authedHeaders() })), 'listPixels')).pixels;
}
export async function upsertPixel(orgId: string, input: { platform: PixelPlatform; pixelId: string; active?: boolean; googleCustomerId?: string; conversionActions?: Record<string, string> | null }): Promise<PixelConfig> {
  return (await asJson<{ pixel: PixelConfig }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/pixels`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) })), 'upsertPixel')).pixel;
}
export async function removePixel(orgId: string, platform: PixelPlatform): Promise<void> {
  await asJson<{ ok: boolean }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/pixels/${encodeURIComponent(platform)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'removePixel');
}


// ── R2 CC-SP-13 — data freshness ────────────────────────────────────────────
/** ADR 1022 D7 — `lastSuccessAt` is when an account last returned data;
 *  `lastSyncAt` is only the cooldown claim and is never shown as freshness. */
export interface SyncStatus { platform: string; lastSyncAt: string; lastSuccessAt?: string; lastAttempt?: { at: string; outcome: 'ok' | 'partial' | 'failed'; reason?: string } }
export async function getSyncStatus(orgId: string): Promise<SyncStatus[]> {
  return (await asJson<{ platforms: SyncStatus[] }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/sync-status`, fetchOpts({ headers: authedHeaders() })), 'getSyncStatus')).platforms;
}

// ── R2 CC-SP-6 — the conversions relay queue, finally REACHABLE ─────────────
// Publicly-accepted conversions queued with no dispatch consumer anywhere: they
// waited forever, then the retention purge silently dropped user-submitted
// data. This is the smallest wiring that makes the existing dispatch route
// reachable from a real surface.
export interface QueuedConversion { eventId: string; eventName: string; at: string; status: 'queued' | 'sent' | 'expired' }
export async function listConversions(orgId: string): Promise<QueuedConversion[]> {
  return (await asJson<{ conversions: QueuedConversion[] }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/conversions`, fetchOpts({ headers: authedHeaders() })), 'listConversions')).conversions;
}
/** ADR 0907 D7 — `dropped`: consent withdrawn since intake; `held`: consent
 *  unreadable (or no visitor key) right now, retried next run. */
export interface DispatchResult { sent: number; dropped?: number; held?: number; expired?: number }
export async function dispatchConversions(orgId: string): Promise<DispatchResult> {
  return asJson<DispatchResult>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/conversions/dispatch`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'dispatchConversions');
}

/** ADR 0907 D7 — the conversions health card. */
export interface ConversionHealth {
  queued: number;
  sent: number;
  /** ADR 0907 D7 — older than every remaining platform's window; never sent. */
  expired?: number;
  /** The read hit its row bound: counts are a floor, not a total. */
  capped: boolean;
  platforms: Array<{ platform: PixelPlatform; configured: boolean; live: boolean; delivered: number; pending: number; lastError?: { error: string; at: string } }>;
}
export async function getConversionHealth(orgId: string): Promise<ConversionHealth> {
  return asJson<ConversionHealth>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/conversions/health`, fetchOpts({ headers: authedHeaders() })), 'getConversionHealth');
}

/** ADR 0907 D2 — what may run right now: the metrics readers and the
 *  conversion senders (TikTok/LinkedIn readers and the TikTok/Google senders
 *  only after the operator has verified them on a test account). */
export interface PlatformStatus { liveSync: LiveSyncPlatform[]; liveConversions: PixelPlatform[] }
export async function getPlatformStatus(): Promise<PlatformStatus> {
  const body = await asJson<Partial<PlatformStatus>>(await fetch(`${base}/platforms`, fetchOpts({ headers: authedHeaders() })), 'getPlatformStatus');
  // An older backend: the ADR 0215 readers and the ADR 0297 sender.
  return { liveSync: body.liveSync ?? ['meta', 'google'], liveConversions: body.liveConversions ?? ['meta'] };
}

// ADR 0952 D6 (P7) — the product feed generated from the commerce catalog.
export interface CatalogFeed {
  enabled: boolean;
  version: number;
  contentLanguage: string;
  feedLabel: string;
  metaCatalogId?: string;
  merchantAccountId?: string;
  merchantDataSource?: string;
  /** Present only while the feed is on. Signed; rotating replaces it. */
  feedUrl?: string;
  items: number;
  /** ADR 1110 P3 — the count stopped at its cap; `items` is a floor ("10,000+"). */
  itemsCapped?: true;
  excluded: Array<{ productId: string; reason: 'no_image' | 'no_price' | 'invalid_currency' }>;
  /** How many were left out in all; `excluded` lists at most the first 200. */
  excludedTotal?: number;
}
export type CatalogPlatform = 'meta' | 'google';
export type CatalogPushResult =
  /** `remaining` (ADR 1110): changes past one push's cap, sent by the next push. */
  | { outcome: 'pushed'; sent: number; unchanged: number; removed: number; failed: number; failures: Array<{ id: string; op: 'upsert' | 'delete'; error: string }>; remaining?: number }
  | { outcome: 'unsupported' | 'no_connection' | 'disabled' }
  /** ADR 1110 — too many products to push in one request: the signed feed URL is the lane. */
  | { outcome: 'catalog_too_large'; max: number }
  | { outcome: 'not_configured'; missing: string };
const feedPath = (orgId: string): string => `${base}/orgs/${encodeURIComponent(orgId)}/catalog-feed`;
export async function getCatalogFeed(orgId: string): Promise<CatalogFeed> {
  return asJson<CatalogFeed>(await fetch(feedPath(orgId), fetchOpts({ headers: authedHeaders() })), 'getCatalogFeed');
}
export async function saveCatalogFeed(orgId: string, input: { enabled?: boolean; metaCatalogId?: string | null; merchantAccountId?: string | null; merchantDataSource?: string | null; contentLanguage?: string; feedLabel?: string }): Promise<CatalogFeed> {
  return asJson<CatalogFeed>(await fetch(feedPath(orgId), fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) })), 'saveCatalogFeed');
}
export async function rotateCatalogFeed(orgId: string): Promise<CatalogFeed> {
  return asJson<CatalogFeed>(await fetch(`${feedPath(orgId)}/rotate`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'rotateCatalogFeed');
}
export async function pushCatalogFeed(orgId: string, platform: CatalogPlatform): Promise<CatalogPushResult> {
  return asJson<CatalogPushResult>(await fetch(`${feedPath(orgId)}/push`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ platform }) })), 'pushCatalogFeed');
}
