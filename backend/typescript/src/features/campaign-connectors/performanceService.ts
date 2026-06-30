/**
 * Campaign performance service (ADR 0159). Stores `CampaignPerformanceRecord`s on
 * `DurableCollection`, dedups by the natural key `platform|campaignName|adSet|date`
 * (re-import is idempotent — overlapping date ranges don't double-count), and
 * projects a KPI summary. Tenant+org keyed (CTI-1).
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { mapAndValidate, parseCsv, autodetectMapping, type ColumnMapping, type ParsedRow } from './csvImport.js';
import type { AdPlatform, CampaignPerformanceRecord, ImportResult, KpiSummary } from './types.js';

const records = new DurableCollection<CampaignPerformanceRecord>(
  'campaign-connectors:perf',
  (r) => `${r.tenantId}::${r.id}`,
);

const naturalKey = (r: { platform: string; campaignName: string; adSet: string; date: string }): string =>
  `${r.platform}|${r.campaignName}|${r.adSet}|${r.date}`;

export async function listRecords(tenantId: string, orgId?: string, campaignId?: string): Promise<CampaignPerformanceRecord[]> {
  const all = await records.listByPrefix(`${tenantId}::`);
  return all
    .filter((r) => (!orgId || r.orgId === orgId) && (!campaignId || r.campaignId === campaignId))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Persist parsed rows; dedup by natural key (existing row of the same key is
 *  replaced, not duplicated). Returns counts. */
export async function persistRecords(
  tenantId: string, orgId: string, rows: ParsedRow[], source: 'csv' | 'api', campaignId?: string,
): Promise<{ imported: number; deduped: number }> {
  const existing = await records.listByPrefix(`${tenantId}::`);
  const byKey = new Map<string, CampaignPerformanceRecord>();
  for (const r of existing) if (r.orgId === orgId) byKey.set(naturalKey(r), r);

  const importBatchId = randomUUID();
  const now = new Date().toISOString();
  let imported = 0;
  let deduped = 0;
  for (const row of rows) {
    const key = naturalKey(row);
    const prior = byKey.get(key);
    const rec: CampaignPerformanceRecord = {
      id: prior?.id ?? randomUUID(),
      tenantId, orgId,
      ...(campaignId ? { campaignId } : prior?.campaignId ? { campaignId: prior.campaignId } : {}),
      platform: row.platform,
      campaignName: row.campaignName,
      adSet: row.adSet,
      date: row.date,
      spend: row.spend, impressions: row.impressions, clicks: row.clicks, conversions: row.conversions, revenue: row.revenue,
      ctr: row.ctr, cpc: row.cpc, cvr: row.cvr, cpa: row.cpa, roas: row.roas,
      source,
      importBatchId,
      createdAt: prior?.createdAt ?? now,
    };
    if (prior) deduped++; else imported++;
    await records.put(rec);
    byKey.set(key, rec);
  }
  return { imported, deduped };
}

/** Import a CSV blob: parse → map (autodetect unless overridden) → validate → persist. */
export async function importCsv(
  tenantId: string, orgId: string, csv: string,
  opts: { mapping?: ColumnMapping; defaultPlatform?: AdPlatform; campaignId?: string } = {},
): Promise<ImportResult> {
  const { headers, rows } = parseCsv(csv);
  const mapping = opts.mapping ?? autodetectMapping(headers);
  const today = new Date().toISOString().slice(0, 10);
  const { records: parsed, issues } = mapAndValidate(headers, rows, mapping, opts.defaultPlatform ?? 'google', today);
  const { imported, deduped } = await persistRecords(tenantId, orgId, parsed, 'csv', opts.campaignId);
  const invalid = issues.filter((i) => i.severity === 'error').length;
  return { imported, deduped, invalid, issues };
}

/** Project a KPI summary over the records (optionally scoped to one campaign). */
export async function kpiSummary(tenantId: string, orgId?: string, campaignId?: string): Promise<KpiSummary> {
  const all = await listRecords(tenantId, orgId, campaignId);
  const t = { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
  const byPlat = new Map<AdPlatform, { spend: number; impressions: number; clicks: number; conversions: number; revenue: number }>();
  let start = ''; let end = '';
  for (const r of all) {
    t.spend += r.spend; t.impressions += r.impressions; t.clicks += r.clicks; t.conversions += r.conversions; t.revenue += r.revenue;
    const p = byPlat.get(r.platform) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
    p.spend += r.spend; p.impressions += r.impressions; p.clicks += r.clicks; p.conversions += r.conversions; p.revenue += r.revenue;
    byPlat.set(r.platform, p);
    if (!start || r.date < start) start = r.date;
    if (!end || r.date > end) end = r.date;
  }
  const div = (a: number, b: number): number => (b > 0 ? Number((a / b).toFixed(4)) : 0);
  return {
    totals: { ...t, ctr: div(t.clicks, t.impressions), cpc: div(t.spend, t.clicks), cvr: div(t.conversions, t.clicks), cpa: div(t.spend, t.conversions), roas: div(t.revenue, t.spend) },
    byPlatform: [...byPlat.entries()].map(([platform, p]) => ({ platform, ...p, roas: div(p.revenue, p.spend) })).sort((a, b) => b.spend - a.spend),
    recordCount: all.length,
    dateRange: start ? { start, end } : null,
  };
}

/** Test-only: drop every record. */
export async function __clearPerformance(): Promise<void> {
  await records.__clear();
}
