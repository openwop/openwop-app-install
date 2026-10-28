/**
 * ADR 0957 D1 — `REPORT_SECTION_SOURCES`, the closed registry of report
 * sections. Each kind calls a function the app already has and copies its
 * figures verbatim. Reporting adds no metric math: no sums, no ratios, no FX.
 *
 * Honesty carries through:
 * - a mixed or unknown currency leaves `currency` unset, with a note;
 * - the source's own data-quality fields (unattributed conversions, shared
 *   join keys, unreported rows, unenforced unsubscribes, approximate opens)
 *   become lineage notes;
 * - none of these sources filters by date, so every lineage says the figures
 *   cover all data up to `computedAt`, not just the report period.
 *
 * A source that is not built yet is absent here, never stubbed (P5 adds
 * spend, experiments, leads, journeys and bi-metric as they land).
 */
import { OpenwopError } from '../../../types.js';
import { featureAccessRefusal } from '../../../host/workflowFeatureGate.js';
import type { ReportLineage, ReportMetric, ReportSection, ReportSectionKind, ReportSnapshot, ReportSourceId } from './types.js';

export const WINDOW_NOTE = 'all-data-to-computedAt';

export interface SectionContext {
  tenantId: string;
  orgId: string;
  campaignIds: string[] | 'all';
  computedAt: string;
}

type SectionSource = (section: ReportSection, ctx: SectionContext, into: ReportSnapshot) => Promise<void>;

const lineage = (source: ReportSourceId, ctx: SectionContext, extra: Partial<ReportLineage> = {}): ReportLineage => ({
  source, computedAt: ctx.computedAt, ...extra, notes: [WINDOW_NOTE, ...(extra.notes ?? [])],
});
const metric = (value: number | null | undefined, unit: ReportMetric['unit'], lin: ReportLineage, currency?: string): ReportMetric => ({
  value: typeof value === 'number' && Number.isFinite(value) ? value : null,
  unit, ...(currency ? { currency } : {}), previous: null, lineage: lin,
});

const kpi: SectionSource = async (section, ctx, into) => {
  await requireReportSource('campaign-connectors', ctx.tenantId);
  const campaignId = section.params.campaignId;
  const { kpiSummary } = await import('../../campaign-connectors/performanceService.js');
  const s = await kpiSummary(ctx.tenantId, ctx.orgId, campaignId || undefined);
  const notes: string[] = [];
  if (s.dateRange) notes.push(`data-range:${s.dateRange.start}..${s.dateRange.end}`);
  if (s.currencyMixed) notes.push('currency-mixed');
  if (s.currencyKnown === false) notes.push('currency-unknown');
  if (s.unreported) notes.push(`unreported-conversions:${s.unreported.conversions}`, `unreported-revenue:${s.unreported.revenue}`);
  const lin = lineage('campaign-connectors.kpiSummary', ctx, { rows: s.recordCount, notes });
  const money = s.currencyMixed || s.currencyKnown === false ? undefined : s.currency;
  const t = s.totals;
  const k = section.key;
  Object.assign(into.metrics, {
    [`${k}.spend`]: metric(t.spend, 'currency', lin, money),
    [`${k}.revenue`]: metric(t.revenue, 'currency', lin, money),
    [`${k}.impressions`]: metric(t.impressions, 'count', lin),
    [`${k}.clicks`]: metric(t.clicks, 'count', lin),
    [`${k}.conversions`]: metric(t.conversions, 'count', lin),
    [`${k}.ctr`]: metric(t.ctr, 'ratio', lin),
    [`${k}.cvr`]: metric(t.cvr, 'ratio', lin),
    [`${k}.cpc`]: metric(t.cpc, 'currency', lin, money),
    [`${k}.cpa`]: metric(t.cpa, 'currency', lin, money),
    [`${k}.roas`]: metric(t.roas, 'ratio', lin),
  });
  into.tables[`${k}.byPlatform`] = {
    columns: ['platform', 'spend', 'impressions', 'clicks', 'conversions', 'revenue', 'roas'],
    rows: s.byPlatform.map((p) => ({ platform: p.platform, spend: p.spend, impressions: p.impressions, clicks: p.clicks, conversions: p.conversions, revenue: p.revenue, roas: p.roas })),
    lineage: lin,
  };
};

const attribution: SectionSource = async (section, ctx, into) => {
  await requireReportSource('campaign-intel', ctx.tenantId);
  const { buildAttribution } = await import('../../campaign-intel/attribution.js');
  const a = await buildAttribution(ctx.tenantId, ctx.orgId);
  const keep = ctx.campaignIds === 'all' ? null : new Set(ctx.campaignIds);
  const rows = keep ? a.rows.filter((r) => keep.has(r.campaignId)) : a.rows;
  const notes: string[] = [];
  if (a.currencyMixed) notes.push('currency-mixed');
  if (a.sharedJoinKeys.length > 0) notes.push(`shared-join-keys:${a.sharedJoinKeys.join(',')}`);
  notes.push('platform-and-web-conversions-not-summed');
  const lin = lineage('campaign-intel.buildAttribution', ctx, { rows: rows.length, notes });
  const k = section.key;
  into.metrics[`${k}.unattributedConversions`] = metric(a.unattributedConversions, 'count', lin);
  into.tables[`${k}.campaigns`] = {
    columns: ['campaignId', 'name', 'currency', 'spend', 'revenue', 'platformConversions', 'webConversions', 'knownContactConversions', 'attributedCpa', 'reportedRoas'],
    rows: rows.map((r) => ({
      campaignId: r.campaignId, name: r.name, currency: r.currency, spend: r.spend, revenue: r.revenue,
      platformConversions: r.platformConversions, webConversions: r.webConversions, knownContactConversions: r.knownContactConversions,
      attributedCpa: r.attributedCpa, reportedRoas: r.reportedRoas,
    })),
    lineage: lin,
  };
};

const email: SectionSource = async (section, ctx, into) => {
  await requireReportSource('email', ctx.tenantId);
  const emailCampaignId = section.params.emailCampaignId ?? '';
  const svc = await import('../../email/emailService.js');
  // engagementStats is tenant-scoped only: prove the email campaign is this
  // client's before reading it.
  if (!(await svc.getCampaign(ctx.tenantId, ctx.orgId, emailCampaignId))) {
    throw new OpenwopError('validation_error', `Section "${section.key}": email campaign not found for this client.`, 400, { reason: 'report_section_invalid', field: `sections.${section.key}.params.emailCampaignId` });
  }
  const { engagementStats } = await import('../../email/engagementService.js');
  const e = await engagementStats(ctx.tenantId, emailCampaignId);
  const notes = ['opens-approximate'];
  if (e.unsubscribesUnenforced > 0) notes.push(`unsubscribes-unenforced:${e.unsubscribesUnenforced}`);
  const lin = lineage('email.engagementStats', ctx, { notes });
  const k = section.key;
  Object.assign(into.metrics, {
    [`${k}.clicks`]: metric(e.clicks, 'count', lin),
    [`${k}.uniqueClicks`]: metric(e.uniqueClicks, 'count', lin),
    [`${k}.opens`]: metric(e.opens, 'count', lin),
    [`${k}.uniqueOpens`]: metric(e.uniqueOpens, 'count', lin),
    [`${k}.unsubscribes`]: metric(e.unsubscribes, 'count', lin),
    [`${k}.unsubscribesUnenforced`]: metric(e.unsubscribesUnenforced, 'count', lin),
  });
};

export async function requireReportSource(featureId: string, tenantId: string): Promise<void> {
  if (await featureAccessRefusal(featureId, tenantId)) {
    throw new OpenwopError('conflict', 'A reporting source is unavailable for this workspace.', 409, { reason: 'report_source_unavailable', featureId });
  }
}

/** The closed registry. A kind not listed here cannot be defined. */
export const REPORT_SECTION_SOURCES: Readonly<Record<ReportSectionKind, { source: ReportSourceId; params: readonly string[]; run: SectionSource }>> = {
  kpi: { source: 'campaign-connectors.kpiSummary', params: ['campaignId'], run: kpi },
  attribution: { source: 'campaign-intel.buildAttribution', params: [], run: attribution },
  email: { source: 'email.engagementStats', params: ['emailCampaignId'], run: email },
};
