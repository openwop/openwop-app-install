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
import { onCampaignDeleted } from '../../host/campaignLifecycle.js';
import { mapAndValidate, parseCsv, autodetectMapping, mappingWithPreset, type ColumnMapping, type ParsedRow } from './csvImport.js';
import type { AdPlatform, CampaignPerformanceRecord, ImportResult, KpiSummary } from './types.js';
// Existing campaign-connectors → campaign-orchestration edge (syncService already
// reads getCampaignByBrief there) — used to resolve the display currency (CMPUX-15).
import { getCampaign, listCampaigns } from '../campaign-orchestration/campaignService.js';

const records = new DurableCollection<CampaignPerformanceRecord>(
  'campaign-connectors:perf',
  (r) => `${r.tenantId}::${r.id}`,
);

// JSON-encode the parts (grade-code AUDIT-6): a raw `|`-joined key collides
// when a campaignName/adSet CONTAINS a `|` (e.g. "Brand | Q3"), silently
// overwriting a different (name, adSet) pair's row — data loss. JSON-encoding
// makes the delimiter unambiguous (the same fix adsAdapter's idemKey uses).
const naturalKey = (r: { platform: string; campaignName: string; adSet: string; date: string }): string =>
  JSON.stringify([r.platform, r.campaignName, r.adSet, r.date]);

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
      // R2 CC-SP-7 — keep the intake currency; a re-import WITHOUT one keeps
      // the prior row's (never downgrade captured truth).
      ...(row.currency ? { currency: row.currency } : prior?.currency ? { currency: prior.currency } : {}),
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
  opts: { mapping?: ColumnMapping; defaultPlatform?: AdPlatform; campaignId?: string; preset?: string } = {},
): Promise<ImportResult> {
  const { headers, rows } = parseCsv(csv);
  const mapping = opts.mapping ?? (opts.preset ? mappingWithPreset(headers, opts.preset) : autodetectMapping(headers));
  const today = new Date().toISOString().slice(0, 10);
  const { records: parsed, issues } = mapAndValidate(headers, rows, mapping, opts.defaultPlatform ?? 'google', today);
  const { imported, deduped } = await persistRecords(tenantId, orgId, parsed, 'csv', opts.campaignId);
  const invalid = issues.filter((i) => i.severity === 'error').length;
  return { imported, deduped, invalid, issues };
}

/** Delete the records linked to one MarketingCampaign (tenant+org scoped) —
 *  the demo-seeder clear path (never touches unlinked, user-imported rows). */
export async function deleteRecordsByCampaign(tenantId: string, orgId: string, campaignId: string): Promise<number> {
  const all = await records.listByPrefix(`${tenantId}::`);
  let removed = 0;
  for (const r of all) {
    if (r.orgId !== orgId || r.campaignId !== campaignId) continue;
    await records.delete(`${r.tenantId}::${r.id}`);
    removed += 1;
  }
  return removed;
}

// Content-scout residue — perf rows key on a campaignId; when the campaign is deleted
// they were left dangling. Prune them via the campaign delete seam (this feature cleans
// its OWN store; no reverse-import from campaign-orchestration).
onCampaignDeleted('perf-records-by-campaign', async ({ tenantId, orgId, campaignId }) => {
  await deleteRecordsByCampaign(tenantId, orgId, campaignId);
});

/** Resolve the display currency for a KPI summary (CMPUX-15, no FX): the
 *  RECORDS' own captured currencies first (R2 CC-SP-7 — the intake truth),
 *  merged with campaign budget currencies; a campaign filter uses that
 *  campaign's budget currency. */
async function resolveKpiCurrency(tenantId: string, recordCurrencies: Set<string>, orgId?: string, campaignId?: string): Promise<{ currency: string; mixed: boolean; known: boolean }> {
  if (campaignId) {
    const c = await getCampaign(tenantId, campaignId).catch(() => null);
    const cur = c?.budget?.currency;
    return { currency: cur ?? 'USD', mixed: false, known: !!cur };
  }
  const campaigns = await listCampaigns(tenantId, orgId).catch(() => []);
  const currencies = new Set([...recordCurrencies, ...campaigns.map((c) => c.budget?.currency).filter((v): v is string => !!v)]);
  // CC-G2 — the `else 'USD'` branch fires for a MIXED org, and collapsed it into
  // the same string a unanimously-USD org returns. The console then labelled a
  // EUR+GBP workspace's KPI band and per-platform table `$`. Report the
  // ambiguity so the reader is not told something false (same fix as the
  // attribution report's `currencyMixed`).
  // R2 CC-SP-2 — the size-0 branch was ALSO collapsed into 'USD, not mixed':
  // an org with records but no currency evidence anywhere got labelled `$`
  // with confidence. Unknown is its own honest state (`known:false`).
  return { currency: currencies.size === 1 ? [...currencies][0]! : 'USD', mixed: currencies.size > 1, known: currencies.size > 0 };
}

/** Project a KPI summary over the records (optionally scoped to one campaign). */
export async function kpiSummary(tenantId: string, orgId?: string, campaignId?: string): Promise<KpiSummary> {
  const all = await listRecords(tenantId, orgId, campaignId);
  const recordCurrencies = new Set(all.map((r) => r.currency).filter((v): v is string => !!v));
  const { currency, mixed: currencyMixed, known: currencyKnown } = await resolveKpiCurrency(tenantId, recordCurrencies, orgId, campaignId);
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
    currency,
    currencyMixed,
    currencyKnown,
  };
}

/** Test-only: drop every record. */
export async function __clearPerformance(): Promise<void> {
  await records.__clear();
}
