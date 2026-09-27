/**
 * Campaign performance types (ADR 0159) — unified ad-metrics across platforms,
 * imported by CSV (CS-007) or live sync (CS-009, honest-off). DISTINCT from
 * `analytics` (page/event measurement) — ad spend/ROAS is its own domain.
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */

export const AD_PLATFORMS = [
  'google', 'meta', 'linkedin', 'tiktok', 'x', 'pinterest', 'snapchat', 'reddit', 'youtube',
] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/** One day of performance for one platform/campaign/ad-set. Computed fields are
 *  derived on import. */
export interface CampaignPerformanceRecord {
  id: string;
  tenantId: string;
  orgId: string;
  /** Optional link to a MarketingCampaign (ADR 0158). */
  campaignId?: string;
  platform: AdPlatform;
  campaignName: string;
  adSet: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  // Derived.
  ctr: number;
  cpc: number;
  cvr: number;
  cpa: number;
  roas: number;
  /** R2 CC-SP-7 — the ad-account currency (ISO-4217), captured at intake when
   *  the export/sync carried one. UNBACKFILLABLE for rows imported before this
   *  field existed (the raw CSV is not retained and symbols were stripped at
   *  parse), so absence means "imported before capture or export had no
   *  currency column" — never "no currency". */
  currency?: string;
  source: 'csv' | 'api';
  importBatchId?: string;
  createdAt: string;
}

export interface ImportValidationIssue {
  row: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface ImportResult {
  imported: number;
  deduped: number;
  invalid: number;
  issues: ImportValidationIssue[];
}

/** Aggregate KPI projection over a set of records. */
export interface KpiSummary {
  totals: { spend: number; impressions: number; clicks: number; conversions: number; revenue: number; ctr: number; cpc: number; cvr: number; cpa: number; roas: number };
  byPlatform: Array<{ platform: AdPlatform; spend: number; impressions: number; clicks: number; conversions: number; revenue: number; roas: number }>;
  recordCount: number;
  dateRange: { start: string; end: string } | null;
  /** CMPUX-15: display currency for the monetary figures (spend/revenue/derived).
   *  A campaign-filtered summary uses that campaign's budget currency; org-wide
   *  uses the UNANIMOUS currency across the RECORDS' own captured currencies
   *  (R2 CC-SP-7 — CSV intake) merged with campaign budget currencies, else
   *  'USD'. No FX conversion (the app's commerce stance). Sync-side capture is
   *  still pending (the adapters don't return the account currency yet —
   *  deferred-named in the R2 tracker). */
  currency: string;
  /** CC-G2 — TRUE when the org's campaigns span more than one budget currency,
   *  so `currency` above is the neutral 'USD' DEFAULT rather than a fact about
   *  this org. There is no FX, so these totals are not in any single currency;
   *  the console renders them unlabelled instead of claiming dollars. */
  currencyMixed?: boolean;
  /** R2 CC-SP-2 — FALSE when there is NO currency evidence at all (no record
   *  currencies, no campaign budget currencies): `currency` is then a pure
   *  guess, and the console renders unlabelled rather than claiming `$` with
   *  confidence. Absent (older backend) reads as known — unchanged behaviour. */
  currencyKnown?: boolean;
}
