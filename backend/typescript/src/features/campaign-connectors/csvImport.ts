/**
 * CSV import (ADR 0159 Phase 1) — PURE parse + column-map + validate + compute.
 * No I/O, unit-testable. The service persists the validated rows. Bryce's CS-007:
 * map a platform export's columns onto the unified metric schema, validate
 * (clicks≤impressions, conversions≤clicks, no negatives/future dates), and
 * compute the derived ctr/cpc/cvr/cpa/roas.
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */

import { AD_PLATFORMS, type AdPlatform, type ImportValidationIssue } from './types.js';

/** A mapping from a CSV header → a unified field. */
export interface ColumnMapping {
  platform?: string;
  campaignName?: string;
  adSet?: string;
  date?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  conversions?: string;
  revenue?: string;
}

/** Generic header aliases (used when a template doesn't pin a column). */
const ALIASES: Record<keyof Omit<ColumnMapping, 'platform'>, string[]> = {
  campaignName: ['campaign', 'campaign name', 'campaign_name'],
  adSet: ['ad set', 'ad set name', 'ad group', 'ad_group', 'adset'],
  date: ['date', 'day', 'reporting date'],
  spend: ['spend', 'cost', 'amount spent', 'amount_spent', 'total spent'],
  impressions: ['impressions', 'impr.', 'impr'],
  clicks: ['clicks', 'link clicks'],
  conversions: ['conversions', 'results', 'conv.', 'conv'],
  revenue: ['revenue', 'conversion value', 'total conv. value', 'sales'],
};

/** Parsed CSV: header row + data rows (RFC 4180-ish — quoted fields, commas in quotes). */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); out.push(row); }
  const nonEmpty = out.filter((r) => r.some((c) => c.trim().length > 0));
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return { headers, rows: nonEmpty };
}

/** Auto-detect a column mapping from the headers (case-insensitive aliases). */
export function autodetectMapping(headers: string[]): ColumnMapping {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const find = (aliases: string[]): string | undefined => {
    for (const a of aliases) { const idx = lower.indexOf(a); if (idx >= 0) return headers[idx]; }
    return undefined;
  };
  const mapping: ColumnMapping = {};
  (Object.keys(ALIASES) as Array<keyof typeof ALIASES>).forEach((k) => { const h = find(ALIASES[k]); if (h) mapping[k] = h; });
  const platformHeader = find(['platform', 'channel', 'source', 'network']);
  if (platformHeader) mapping.platform = platformHeader;
  return mapping;
}

const num = (raw: string | undefined): number => {
  if (raw == null) return 0;
  const n = Number(String(raw).replace(/[$€£¥,%x\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function parseDate(raw: string | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s); // MM/DD/YYYY (US default)
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

const asPlatform = (raw: string | undefined, fallback: AdPlatform): AdPlatform => {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s*ads?$/, '');
  return (AD_PLATFORMS as readonly string[]).includes(s) ? (s as AdPlatform) : fallback;
};

/** Compute the derived metrics for one record (safe division). */
export function computeDerived(r: { spend: number; impressions: number; clicks: number; conversions: number; revenue: number }): { ctr: number; cpc: number; cvr: number; cpa: number; roas: number } {
  const div = (a: number, b: number): number => (b > 0 ? Number((a / b).toFixed(4)) : 0);
  return {
    ctr: div(r.clicks, r.impressions),
    cpc: div(r.spend, r.clicks),
    cvr: div(r.conversions, r.clicks),
    cpa: div(r.spend, r.conversions),
    roas: div(r.revenue, r.spend),
  };
}

export interface ParsedRow {
  platform: AdPlatform; campaignName: string; adSet: string; date: string;
  spend: number; impressions: number; clicks: number; conversions: number; revenue: number;
  ctr: number; cpc: number; cvr: number; cpa: number; roas: number;
}

/**
 * Map + validate parsed CSV rows. Returns the valid records + per-row issues.
 * `defaultPlatform` applies when a row has no platform column.
 */
export function mapAndValidate(
  headers: string[], rows: string[][], mapping: ColumnMapping, defaultPlatform: AdPlatform, todayIso: string,
): { records: ParsedRow[]; issues: ImportValidationIssue[] } {
  const idx = (col: string | undefined): number => (col ? headers.indexOf(col) : -1);
  const cells = (row: string[], col: string | undefined): string | undefined => { const i = idx(col); return i >= 0 ? row[i] : undefined; };
  const records: ParsedRow[] = [];
  const issues: ImportValidationIssue[] = [];

  rows.forEach((row, i) => {
    const rowNum = i + 2; // 1-based + header
    const date = parseDate(cells(row, mapping.date));
    const spend = num(cells(row, mapping.spend));
    const impressions = num(cells(row, mapping.impressions));
    const clicks = num(cells(row, mapping.clicks));
    const conversions = num(cells(row, mapping.conversions));
    const revenue = num(cells(row, mapping.revenue));

    if (!date) { issues.push({ row: rowNum, severity: 'error', message: 'Missing or unparseable date.' }); return; }
    if (date > todayIso) { issues.push({ row: rowNum, severity: 'error', message: 'Date is in the future.' }); return; }
    if (spend < 0 || impressions < 0 || clicks < 0 || conversions < 0 || revenue < 0) { issues.push({ row: rowNum, severity: 'error', message: 'Negative metric value.' }); return; }
    if (clicks > impressions && impressions > 0) issues.push({ row: rowNum, severity: 'warning', message: 'Clicks exceed impressions.' });
    if (conversions > clicks && clicks > 0) issues.push({ row: rowNum, severity: 'warning', message: 'Conversions exceed clicks.' });

    const base = { spend, impressions, clicks, conversions, revenue };
    records.push({
      platform: asPlatform(cells(row, mapping.platform), defaultPlatform),
      campaignName: String(cells(row, mapping.campaignName) ?? '').trim() || 'Unknown',
      adSet: String(cells(row, mapping.adSet) ?? '').trim(),
      date,
      ...base,
      ...computeDerived(base),
    });
  });
  return { records, issues };
}
