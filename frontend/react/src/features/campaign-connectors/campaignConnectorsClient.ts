/**
 * Campaign Connectors API client (ADR 0159). CSV import + performance KPI under
 * /host/openwop-app/campaign-connectors/*.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type AdPlatform = 'google' | 'meta' | 'linkedin' | 'tiktok' | 'x' | 'pinterest' | 'snapchat' | 'reddit' | 'youtube';

export interface ImportResult { imported: number; deduped: number; invalid: number; issues: Array<{ row: number; severity: 'error' | 'warning'; message: string }> }
export interface KpiSummary {
  totals: { spend: number; impressions: number; clicks: number; conversions: number; revenue: number; ctr: number; cpc: number; cvr: number; cpa: number; roas: number };
  byPlatform: Array<{ platform: AdPlatform; spend: number; impressions: number; clicks: number; conversions: number; revenue: number; roas: number }>;
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
export interface SyncResult {
  outcome: 'synced' | 'cooldown' | 'no_dispatches';
  retryAtIso?: string;
  platform?: string;
  date?: string;
  campaigns?: number;
  imported?: number;
  deduped?: number;
  failures?: Array<{ platformCampaignId: string; reason: string }>;
}
/** C2 — live pull of yesterday's metrics for every dispatched campaign. 429 ⇒ cooldown. */
export async function syncNow(orgId: string, platform: 'meta' | 'google'): Promise<SyncResult> {
  const res = await fetch(`${base}/sync`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, platform }) }));
  if (res.status === 429) return (await res.json()) as SyncResult;
  return asJson<SyncResult>(res, 'syncNow');
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
export interface PixelConfig { platform: PixelPlatform; pixelId: string; active: boolean; updatedAt: string }

export async function listPixels(orgId: string): Promise<PixelConfig[]> {
  return (await asJson<{ pixels: PixelConfig[] }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/pixels`, fetchOpts({ headers: authedHeaders() })), 'listPixels')).pixels;
}
export async function upsertPixel(orgId: string, input: { platform: PixelPlatform; pixelId: string; active?: boolean }): Promise<PixelConfig> {
  return (await asJson<{ pixel: PixelConfig }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/pixels`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) })), 'upsertPixel')).pixel;
}
export async function removePixel(orgId: string, platform: PixelPlatform): Promise<void> {
  await asJson<{ ok: boolean }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/pixels/${encodeURIComponent(platform)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'removePixel');
}


// ── R2 CC-SP-13 — data freshness ────────────────────────────────────────────
export async function getSyncStatus(orgId: string): Promise<Array<{ platform: string; lastSyncAt: string }>> {
  return (await asJson<{ platforms: Array<{ platform: string; lastSyncAt: string }> }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/sync-status`, fetchOpts({ headers: authedHeaders() })), 'getSyncStatus')).platforms;
}

// ── R2 CC-SP-6 — the conversions relay queue, finally REACHABLE ─────────────
// Publicly-accepted conversions queued with no dispatch consumer anywhere: they
// waited forever, then the retention purge silently dropped user-submitted
// data. This is the smallest wiring that makes the existing dispatch route
// reachable from a real surface.
export interface QueuedConversion { eventId: string; eventName: string; at: string; status: 'queued' | 'sent' }
export async function listConversions(orgId: string): Promise<QueuedConversion[]> {
  return (await asJson<{ conversions: QueuedConversion[] }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/conversions`, fetchOpts({ headers: authedHeaders() })), 'listConversions')).conversions;
}
export async function dispatchConversions(orgId: string): Promise<{ sent: number }> {
  return asJson<{ sent: number }>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/conversions/dispatch`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'dispatchConversions');
}
