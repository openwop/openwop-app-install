/**
 * ADR 0957 P0 — client reports API client: report definitions and frozen
 * draft reports under `/host/openwop-app/campaign-ops/clients/:orgId/…`.
 * Loads with the lazy Reports section. Failures throw `CampaignOpsError`
 * (a 404 "not enabled" means the workspace has no client reports).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { asJson } from './campaignOpsClient.js';

export type ReportSectionKind = 'kpi' | 'attribution' | 'email';
export type ReportPeriodKind = 'month' | 'week' | 'custom';

export interface ReportDefinition {
  definitionId: string; orgId: string; title: string; version: number;
  campaignIds: string[] | 'all';
  sections: Array<{ kind: ReportSectionKind; key: string; params: Record<string, string> }>;
  period: { kind: ReportPeriodKind; timezone: string };
  updatedAt: string;
}

export interface ReportLineage { source: string; computedAt: string; rows?: number; notes?: string[] }
export interface ReportMetric { value: number | null; unit: 'count' | 'currency' | 'ratio' | 'duration'; currency?: string; previous: number | null; lineage: ReportLineage }
export interface ReportTable { columns: string[]; rows: Array<Record<string, string | number | null>>; lineage: ReportLineage }

export interface ClientReport {
  reportId: string; definitionId: string; definitionVersion: number; title: string;
  periodStart: string; periodEnd: string;
  snapshot: { metrics: Record<string, ReportMetric>; tables: Record<string, ReportTable> };
  snapshotHash: string;
  status: 'draft' | 'in_review' | 'published' | 'withdrawn';
  generatedAt: string;
}

const base = (orgId: string): string => `${config.baseUrl}/host/openwop-app/campaign-ops/clients/${encodeURIComponent(orgId)}`;
const get = async <T>(url: string): Promise<T> => asJson<T>(await fetch(url, fetchOpts({ headers: authedHeaders() })));
const post = async <T>(url: string, body: unknown): Promise<T> =>
  asJson<T>(await fetch(url, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) })));

export async function listDefinitions(orgId: string): Promise<ReportDefinition[]> {
  return (await get<{ definitions: ReportDefinition[] }>(`${base(orgId)}/report-definitions`)).definitions;
}
export async function createDefinition(orgId: string, body: { title: string; sections: Array<{ kind: ReportSectionKind }>; period: { kind: ReportPeriodKind; timezone: string } }): Promise<ReportDefinition> {
  return (await post<{ definition: ReportDefinition }>(`${base(orgId)}/report-definitions`, body)).definition;
}
export async function computeReport(orgId: string, definitionId: string): Promise<ClientReport> {
  return (await post<{ report: ClientReport }>(`${base(orgId)}/report-definitions/${encodeURIComponent(definitionId)}/reports`, {})).report;
}
export async function listReports(orgId: string): Promise<ClientReport[]> {
  return (await get<{ reports: ClientReport[] }>(`${base(orgId)}/reports`)).reports;
}
