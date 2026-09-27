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
  /** R2 CC-SP-7 — the export's account-currency column (ISO-4217). */
  currency?: string;
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
  // R2 CC-SP-7 — the account currency, straight from the export (Meta/Google
  // both include it). Unbackfillable if not captured at intake.
  currency: ['currency', 'currency code', 'account currency', 'account_currency'],
};

/** ADR 0357 P5 — per-platform export column PRESETS (the spec's nine),
 *  layered over the generic alias autodetect: a preset pins the platform's
 *  exact export headers; anything it doesn't pin falls back to ALIASES. */
export const PLATFORM_CSV_PRESETS: Record<string, Partial<Record<keyof Omit<ColumnMapping, 'platform'>, string>>> = {
  google: { campaignName: 'campaign', adSet: 'ad group', date: 'day', spend: 'cost', impressions: 'impr.', clicks: 'clicks', conversions: 'conversions', revenue: 'total conv. value' },
  meta: { campaignName: 'campaign name', adSet: 'ad set name', date: 'day', spend: 'amount spent', impressions: 'impressions', clicks: 'link clicks', conversions: 'results', revenue: 'conversion value' },
  linkedin: { campaignName: 'campaign name', adSet: 'campaign group', date: 'date', spend: 'total spent', impressions: 'impressions', clicks: 'clicks', conversions: 'conversions', revenue: 'conversion value' },
  tiktok: { campaignName: 'campaign name', adSet: 'ad group name', date: 'date', spend: 'cost', impressions: 'impression', clicks: 'click', conversions: 'conversion', revenue: 'total purchase value' },
  x: { campaignName: 'campaign name', adSet: 'ad group', date: 'time period', spend: 'spend', impressions: 'impressions', clicks: 'link clicks', conversions: 'conversions', revenue: 'purchase value' },
  pinterest: { campaignName: 'campaign name', adSet: 'ad group name', date: 'date', spend: 'spend', impressions: 'impressions', clicks: 'pin clicks', conversions: 'checkouts', revenue: 'checkout value' },
  snapchat: { campaignName: 'campaign name', adSet: 'ad set name', date: 'day', spend: 'spend', impressions: 'impressions', clicks: 'swipe ups', conversions: 'conversions', revenue: 'purchase value' },
  reddit: { campaignName: 'campaign name', adSet: 'ad group', date: 'date', spend: 'spend', impressions: 'impressions', clicks: 'clicks', conversions: 'conversions', revenue: 'conversion value' },
  youtube: { campaignName: 'campaign', adSet: 'ad group', date: 'day', spend: 'cost', impressions: 'impr.', clicks: 'clicks', conversions: 'conversions', revenue: 'total conv. value' },
};

/** Resolve a preset-pinned mapping over the generic autodetect. Unknown preset
 *  names fall through to pure autodetect (never an error — the wizard offers
 *  the preset list from PLATFORM_CSV_PRESETS keys). */
export function mappingWithPreset(headers: string[], preset?: string): ColumnMapping {
  const base = autodetectMapping(headers);
  const pins = preset ? PLATFORM_CSV_PRESETS[preset.toLowerCase()] : undefined;
  if (!pins) return base;
  const lower = headers.map((h) => h.trim().toLowerCase());
  const out = { ...base };
  for (const [field, header] of Object.entries(pins)) {
    const idx = lower.indexOf(String(header).toLowerCase());
    if (idx >= 0) (out as Record<string, unknown>)[field] = headers[idx]; // header NAME (the mapping vocabulary)
  }
  return out;
}

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

/** R2 CC-SP-8 — a metric parse has three honest outcomes: a number, an ABSENT
 *  cell (0 — an empty export cell means no activity), or GARBAGE (null → an
 *  issue row). The old `num()` silently zeroed garbage AND corrupted
 *  decimal-comma locales: "1.234,56" had its comma stripped after the dot
 *  survived → 1.234 → a ~1000× silent understatement. Separator rule: when both
 *  appear, the LAST one is the decimal separator; a lone comma is decimal only
 *  when not followed by exactly three digits (else it groups thousands). */
const num = (raw: string | undefined): number | null => {
  if (raw == null) return 0;
  const trimmed = String(raw).trim();
  // Common export null markers mean ABSENT (0), not garbage — Google Ads emits
  // " --" for empty cells; skipping the whole row for them would shed real
  // exports wholesale (review m5).
  if (/^(-{1,2}|—|n\/a)$/i.test(trimmed)) return 0;
  let s = trimmed.replace(/[$€£¥%x\s]/g, '');
  if (s === '') return 0;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56
    else s = s.replace(/,/g, ''); // 1,234.56 → 1234.56
  } else if (lastComma >= 0) {
    // A lone comma is the DECIMAL separator iff followed by 1–2 trailing
    // digits ("12,5"); otherwise it groups thousands ("1,234").
    s = /,\d{1,2}$/.test(s) ? s.replace(/,/g, '.') : s.replace(/,/g, '');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    // 2+ dots with no comma is unambiguous EU grouping ("12.345.678").
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** R2 CC-SP-9 — MM/DD is the default, but a swapped export must not silently
 *  land on the wrong day: a first component >12 is unambiguously DD/MM (parsed
 *  as such, flagged) — the old code built an invalid month and mislabelled the
 *  row "Date is in the future". `ambiguous` marks rows where both readings are
 *  valid dates, so the import can disclose the assumption ONCE. */
function parseDate(raw: string | undefined): { iso: string; ambiguous: boolean; swapped: boolean } | null {
  const s = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { iso: s.slice(0, 10), ambiguous: false, swapped: false };
  const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s); // MM/DD/YYYY (US default)
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    let mm = Number(m[1]);
    let dd = Number(m[2]);
    let swapped = false;
    if (mm > 12 && dd <= 12) { [mm, dd] = [dd, mm]; swapped = true; }
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const ambiguous = !swapped && mm <= 12 && dd <= 12 && mm !== dd;
    return { iso: `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, ambiguous, swapped };
  }
  return null;
}

/** R2 CC-SP-7 — an ISO-4217-shaped currency from the export's own column;
 *  anything else is dropped (never guessed). */
const parseCurrency = (raw: string | undefined): string | undefined => {
  const s = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : undefined;
};

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
  /** R2 CC-SP-7 — the account currency, when the export carried one. */
  currency?: string;
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

  let ambiguousDates = 0;
  let swappedDates = 0;
  rows.forEach((row, i) => {
    const rowNum = i + 2; // 1-based + header
    const parsed = parseDate(cells(row, mapping.date));
    // R2 CC-SP-8 — a garbage metric is an ISSUE row, never a silent zero.
    const metrics: Array<[string, number | null]> = [
      ['spend', num(cells(row, mapping.spend))],
      ['impressions', num(cells(row, mapping.impressions))],
      ['clicks', num(cells(row, mapping.clicks))],
      ['conversions', num(cells(row, mapping.conversions))],
      ['revenue', num(cells(row, mapping.revenue))],
    ];
    const garbage = metrics.find(([, v]) => v === null);
    if (garbage) { issues.push({ row: rowNum, severity: 'error', message: `Unparseable ${garbage[0]} value.` }); return; }
    const [spend, impressions, clicks, conversions, revenue] = metrics.map(([, v]) => v as number);

    if (!parsed) { issues.push({ row: rowNum, severity: 'error', message: 'Missing or unparseable date.' }); return; }
    const { iso: date } = parsed;
    if (parsed.ambiguous) ambiguousDates += 1;
    if (parsed.swapped) swappedDates += 1;
    if (date > todayIso) { issues.push({ row: rowNum, severity: 'error', message: 'Date is in the future.' }); return; }
    if (spend < 0 || impressions < 0 || clicks < 0 || conversions < 0 || revenue < 0) { issues.push({ row: rowNum, severity: 'error', message: 'Negative metric value.' }); return; }
    if (clicks > impressions && impressions > 0) issues.push({ row: rowNum, severity: 'warning', message: 'Clicks exceed impressions.' });
    if (conversions > clicks && clicks > 0) issues.push({ row: rowNum, severity: 'warning', message: 'Conversions exceed clicks.' });

    const base = { spend, impressions, clicks, conversions, revenue };
    const currency = parseCurrency(cells(row, mapping.currency));
    records.push({
      platform: asPlatform(cells(row, mapping.platform), defaultPlatform),
      campaignName: String(cells(row, mapping.campaignName) ?? '').trim() || 'Unknown',
      adSet: String(cells(row, mapping.adSet) ?? '').trim(),
      date,
      ...base,
      ...computeDerived(base),
      ...(currency ? { currency } : {}),
    });
  });
  // R2 CC-SP-9 — disclose the format assumption ONCE, not per row.
  if (ambiguousDates > 0) issues.push({ row: 0, severity: 'warning', message: `${ambiguousDates} date(s) were read as MM/DD (US format). If this export uses DD/MM, those rows landed on the wrong day.` });
  if (swappedDates > 0) issues.push({ row: 0, severity: 'warning', message: `${swappedDates} date(s) had a first component over 12 and were read as DD/MM.` });
  return { records, issues };
}
