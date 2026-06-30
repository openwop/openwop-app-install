/**
 * Campaign Connectors API client (ADR 0159). CSV import + performance KPI under
 * /v1/host/openwop-app/campaign-connectors/*.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type AdPlatform = 'google' | 'meta' | 'linkedin' | 'tiktok' | 'x' | 'pinterest' | 'snapchat' | 'reddit' | 'youtube';

export interface ImportResult { imported: number; deduped: number; invalid: number; issues: Array<{ row: number; severity: 'error' | 'warning'; message: string }> }
export interface KpiSummary {
  totals: { spend: number; impressions: number; clicks: number; conversions: number; revenue: number; ctr: number; cpc: number; cvr: number; cpa: number; roas: number };
  byPlatform: Array<{ platform: AdPlatform; spend: number; impressions: number; clicks: number; conversions: number; revenue: number; roas: number }>;
  recordCount: number;
  dateRange: { start: string; end: string } | null;
}
export interface OrgRef { orgId: string; name: string }

export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/v1/host/openwop-app/campaign-connectors`;
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
export async function getKpi(orgId: string): Promise<KpiSummary> {
  return asJson<KpiSummary>(await fetch(`${base}/kpi?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'getKpi');
}
export async function listOrgs(): Promise<OrgRef[]> {
  return (await asJson<{ orgs: OrgRef[] }>(await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}

export const AD_PLATFORMS: ReadonlyArray<AdPlatform> = ['google', 'meta', 'linkedin', 'tiktok', 'x', 'pinterest', 'snapchat', 'reddit', 'youtube'];
