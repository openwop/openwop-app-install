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
}
