/**
 * Campaign Intelligence API client (ADR 0160). Budget recommendations + forecast
 * under /host/openwop-app/campaign-intel/*.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface BudgetReallocation { platform: string; currentSpend: number; suggestedSpend: number; changeAmount: number; changePercent: number; roas: number; reason: string }
export interface BudgetRecommendation {
  totalSpend: number; reallocations: BudgetReallocation[]; projectedRoasGain: number;
  /** R2 CI-SP-3 — structured note (localized client-side; `note` is the
   *  older-backend prose fallback, which no longer mints a `$`). */
  noteCode?: 'concentrated' | 'shift' | 'not_enough_platforms';
  noteParams?: { shift: number; from: string; to: string };
  note: string;
}
export interface CampaignForecast {
  campaignName: string; platform: string;
  creativeFatigue: { detected: boolean; firstHalfCtr: number; secondHalfCtr: number; dropPercent: number };
  projection: { days: number; projectedSpend: number; projectedConversions: number };
}
export interface OrgRef { orgId: string; name: string }

export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/host/openwop-app/campaign-intel`;

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    if (res.status === 404 && /not enabled/i.test(detail)) throw new FeatureDisabledError(detail);
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getBudget(orgId: string): Promise<BudgetRecommendation> {
  return asJson<BudgetRecommendation>(await fetch(`${base}/budget?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'getBudget');
}
export interface AttributionRow {
  campaignId: string; name: string; joinKey: string; currency: string; spend: number; revenue: number;
  platformConversions: number; webConversions: number; attributedCpa: number; reportedRoas: number;
  lineage: { spendRows: number; latestSpendDate: string | null; conversionEvents: number; latestConversionAt: string | null };
  /** ADR 0246: owned-channel (email) engagement rolled up to this campaign via
   *  the `sourceBriefId` provenance — present only when the brief owns ≥1
   *  channel-published email campaign (additive, never synthesised). */
  emailEngagement?: { briefId: string; emailCampaigns: number; opens: number; uniqueOpens: number; clicks: number; uniqueClicks: number; unsubscribes: number };
}
export interface AttributionReport {
  rows: AttributionRow[];
  email: Array<{ emailCampaignId: string; clicks: number; uniqueClicks: number; unsubscribes: number }>;
  unattributedConversions: number;
  /** CMPUX-15: report-level display currency (per-row `currency` is authoritative). */
  currency: string;
  /** CI-G1 — the org's campaigns span MORE THAN ONE budget currency, so
   *  `currency` is a neutral default, not a fact. Org-wide figures are then
   *  unlabelled (there is no FX, so they are not in any single currency). */
  currencyMixed?: boolean;
  computedAt: string;
}
export async function getAttribution(orgId: string): Promise<AttributionReport> {
  return asJson<AttributionReport>(await fetch(`${base}/attribution?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'attribution');
}
export interface PacingRow {
  campaignId: string; name: string; budget: number; currency: string; spend: number;
  spentPct: number; band: 'ok' | 'warning' | 'over'; projectedMonthlySpend: number | null;
}
export interface PacingReport { rows: PacingRow[]; unplanned: number; computedAt: string }
export async function getPacing(orgId: string): Promise<PacingReport> {
  return asJson<PacingReport>(await fetch(`${base}/pacing?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'pacing');
}

export async function getForecast(orgId: string): Promise<CampaignForecast[]> {
  return (await asJson<{ forecasts: CampaignForecast[] }>(await fetch(`${base}/forecast?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'getForecast')).forecasts;
}
/** R3 CI-SP-8 remainder — the ADR 0357 P2 anomaly detector gets a reader. */
export interface Anomaly {
  platform: string; campaignName: string; metric: 'spend' | 'ctr' | 'cpa';
  date: string; value: number; mean: number; z: number; direction: 'spike' | 'drop';
}
export async function getAnomalies(orgId: string): Promise<Anomaly[]> {
  const res = await fetch(`${base}/anomalies?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ anomalies: Anomaly[] }>(res, 'getAnomalies')).anomalies;
}

export async function listOrgs(): Promise<OrgRef[]> {
  return (await asJson<{ orgs: OrgRef[] }>(await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}

/** The Analyst agent the chat deep-link scopes to (ADR 0058). */
export const INTELLIGENCE_ANALYST_AGENT = 'feature.campaign-intel.agents.intelligence-analyst';

const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** Mirrors the backend `BudgetPlanNoteCode` union — the UI localizes from this
 *  (CS-UX-16/POLISH-1); `note` is the English back-compat mirror. */
export type BudgetPlanNoteCode = 'no_history';

/** ADR 0357 P1 — the deterministic goal-based budget plan. */
export interface BudgetPlanDto {
  verdict: 'feasible' | 'stretch' | 'infeasible';
  impliedCpaMinor: number;
  expectedConversions: number;
  confidence: 'high' | 'medium' | 'low';
  platforms: Array<{ platform: string; allocationMinor: number; expectedConversions: number; historicalCpaMinor: number }>;
  /** `expectedConversions` optional defensively: a mid-deploy older backend omits it. */
  pacing: Array<{ week: number; budgetMinor: number; expectedConversions?: number }>;
  note?: string;
  noteCode?: BudgetPlanNoteCode;
  noteParams?: Record<string, number>;
}

export async function planBudget(orgId: string, goal: { totalBudgetMinor: number; targetConversions: number; horizonDays: number }): Promise<{ plan: BudgetPlanDto }> {
  const res = await fetch(`${base}/plan-budget`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, ...goal }) }));
  return asJson(res, 'planBudget');
}

/** ADR 0357 P4 — funnel + top/bottom performers. */
export async function getOverview(orgId: string): Promise<{ funnel: Array<{ platform: string; impressions: number; clicks: number; conversions: number }>; performers: { top: Array<{ campaignName: string; platform: string; spend: number; roas: number }>; bottom: Array<{ campaignName: string; platform: string; spend: number; roas: number }> } }> {
  const res = await fetch(`${base}/overview?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'getOverview');
}
