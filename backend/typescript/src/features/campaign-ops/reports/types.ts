/**
 * ADR 0957 D1 — client reports: a definition (what to report, for which
 * client) and frozen, hashed reports of numbers the app already computes.
 *
 * @see docs/adr/0957-client-reporting-and-portal.md
 */

export const REPORT_SECTION_KINDS = ['kpi', 'attribution', 'email'] as const;
export type ReportSectionKind = (typeof REPORT_SECTION_KINDS)[number];
export type ReportPeriodKind = 'month' | 'week' | 'custom';
export type ReportBrand = 'agency' | 'client' | 'co-brand';
/** Stable chain identity shared by definition validation and the scheduler. */
export const CLIENT_REPORT_CHAIN_ID = 'campaign-ops-reporting.client-report';

export interface ReportSection {
  kind: ReportSectionKind;
  /** Unique within the definition; prefixes the section's metric keys. */
  key: string;
  params: Record<string, string>;
}

export interface ReportDefinition {
  tenantId: string;
  orgId: string;
  definitionId: string;
  title: string;
  /** MarketingCampaign ids of THIS client org, or every campaign. */
  campaignIds: string[] | 'all';
  sections: ReportSection[];
  period: { kind: ReportPeriodKind; timezone: string };
  brand: ReportBrand;
  /** D3 — stored now; the narrative ships in P3. */
  narrative: boolean;
  /** ADR 0958 collaborator ids; empty until P2 (portal delivery). */
  audience: string[];
  /** D2 — a cron cadence; one scheduler job per definition, re-armed (and its
   *  pinned version moved) on every edit. */
  schedule?: { cron: string };
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type MetricKey = string;
export type ReportSourceId = 'campaign-connectors.kpiSummary' | 'campaign-intel.buildAttribution' | 'email.engagementStats';

export interface ReportLineage {
  source: ReportSourceId;
  computedAt: string;
  rows?: number;
  notes?: string[];
}

export interface ReportMetric {
  value: number | null;
  unit: 'count' | 'currency' | 'ratio' | 'duration';
  /** Set only when the source states one currency for the figure. */
  currency?: string;
  /** The same metric for the prior period. Null until prior-period sources exist. */
  previous: number | null;
  lineage: ReportLineage;
}

export interface ReportTable {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  lineage: ReportLineage;
}

export interface ReportSnapshot {
  metrics: Record<MetricKey, ReportMetric>;
  tables: Record<string, ReportTable>;
}

export type ClientReportStatus = 'draft' | 'in_review' | 'published' | 'withdrawn';

export interface ClientReport {
  tenantId: string;
  orgId: string;
  reportId: string;
  definitionId: string;
  definitionVersion: number;
  title: string;
  periodStart: string;
  periodEnd: string;
  snapshot: ReportSnapshot;
  /** sha256 of the canonical snapshot: review and publication bind to it. */
  snapshotHash: string;
  status: ClientReportStatus;
  /** Set when a run (the P1 chain) computed it. */
  runId?: string;
  generatedBy: string;
  generatedAt: string;
  /** Set by `publish-report` (D2 step 5), CAS-bound to `snapshotHash`. */
  publishedAt?: string;
  publishedBy?: string;
}
