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
  /** ADR 0956 D1 — conversions whose touch path's last touch maps to this
   *  campaign (the visitor landed from it and converted later). Absent on an
   *  older backend. Shown beside `webConversions`, never summed with it. */
  sessionLastClick?: number;
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
  /** ADR 0956 D1 — how the touch paths were built (absent on an older backend). */
  pathCoverage?: PathCoverage;
  lookbackDays?: number;
  /** CMPUX-15: report-level display currency (per-row `currency` is authoritative). */
  currency: string;
  /** CI-G1 — the org's campaigns span MORE THAN ONE budget currency, so
   *  `currency` is a neutral default, not a fact. Org-wide figures are then
   *  unlabelled (there is no FX, so they are not in any single currency). */
  currencyMixed?: boolean;
  computedAt: string;
}
export interface PathCoverage { conversions: number; contactPaths: number; sessionPaths: number; noTouch: number }

/** ADR 0956 D2 — the multi-touch model report. */
export const ATTRIBUTION_MODELS = ['last_click', 'first_touch', 'linear', 'time_decay', 'position_based'] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];
export interface ModelCreditRow { campaignId: string | null; name: string | null; units: number; conversions: number; value: Array<{ currency: string; minor: number }> }
export interface AttributionSettings { lookbackDays: number; halfLifeDays: number; defaultModel: AttributionModel }
export interface AttributionModelReport {
  model: AttributionModel;
  settings: AttributionSettings;
  settingsVersion: number;
  rows: ModelCreditRow[];
  unmapped: ModelCreditRow;
  comparison: Array<{ campaignId: string | null; name: string | null; byModel: Record<AttributionModel, number> }>;
  creditedPaths: number;
  coverage: PathCoverage;
  computedAt: string;
}
/** Throws `FeatureDisabledError` while the `campaign-intel.multi-touch`
 *  sub-toggle is off — the caller hides the section. */
export async function getAttributionModels(orgId: string, model?: AttributionModel): Promise<AttributionModelReport> {
  const q = model ? `?model=${encodeURIComponent(model)}` : '';
  return asJson<AttributionModelReport>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/attribution/models${q}`, fetchOpts({ headers: authedHeaders() })), 'attributionModels');
}
/** ADR 0956 D6 — platform claims beside measured credit. */
export interface InflationVerdict { ratio: number | null; measuredZero: boolean; flagged: boolean; daysAbove: number }
export interface ReconciliationRow {
  campaignId: string; campaignName: string; platform: string; currency: string; spend: number;
  reportedConversions: number; reportedRevenue: number | null; reportedRoas: number | null;
  measuredConversions: number; measuredRevenue: number; measuredValueOther: Array<{ currency: string; minor: number }>; measuredRoas: number | null;
  inflation: InflationVerdict;
}
export interface ReconciliationReport {
  model: AttributionModel;
  rows: ReconciliationRow[];
  overlap: Array<{ campaignId: string; campaignName: string; platformClaims: number; measured: number; overlap: number }>;
  threshold: number; sustainDays: number;
  calibration: null; calibrationReason: string;
  lineage: { spendRows: number; latestSpendDate: string | null; creditedPaths: number; asOf: string };
  computedAt: string;
}
export async function getReconciliation(orgId: string): Promise<ReconciliationReport> {
  return asJson<ReconciliationReport>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/reconciliation`, fetchOpts({ headers: authedHeaders() })), 'reconciliation');
}
export type LandingResolution =
  | { kind: 'cms_page'; pageId: string; slug: string; title: string; funnelSteps: Array<{ funnelId: string; funnelName: string; stepId: string }> }
  | { kind: 'external'; host: string }
  | { kind: 'unresolved'; reason: 'no_landing_url' | 'invalid_url' | 'page_not_found' | 'other_org' | 'feature_off' };
export interface AdMapRow {
  platform: string; platformAdId: string; platformCampaignId: string; adRef: string | null;
  campaignId: string | null; campaignName: string | null; landingUrl: string | null; landing: LandingResolution;
  variantKey: string | null; landingSessions: number | null; conversions: number | null;
  messageMatch: { status: 'owed'; reason: string }; dispatchedAt: string;
}
export interface AdMapReport { model: AttributionModel; rows: AdMapRow[]; unplacedLegacyRows: number; ledgerCapped: boolean; computedAt: string }
export async function getAdMap(orgId: string): Promise<AdMapReport> {
  return asJson<AdMapReport>(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/admap`, fetchOpts({ headers: authedHeaders() })), 'admap');
}

/** Save the org's attribution settings; `expectedVersion` is the version read. */
export async function saveAttributionSettings(orgId: string, settings: AttributionSettings, expectedVersion: number): Promise<{ settings: AttributionSettings; version: number }> {
  return asJson(await fetch(`${base}/orgs/${encodeURIComponent(orgId)}/attribution-settings`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ ...settings, expectedVersion }) })), 'saveAttributionSettings');
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
export const INTELLIGENCE_ANALYST_AGENT = 'vendor.openwop-app.campaign-intel.agents.intelligence-analyst';

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

/** ADR 0952 D3 — a reallocation plan: per-campaign daily-budget changes under ONE
 *  approval. Amounts are minor units of each ad account's currency (the plan
 *  carries no currency — the platforms report budgets per account). */
export interface ReallocationOpDto { platform: string; adAccountId: string; campaignId: string; campaignName?: string; fromDailyMinor: number | null; toDailyMinor: number }
export type ReallocationStatus = 'proposed' | 'approved' | 'applying' | 'applied' | 'partial' | 'rejected' | 'expired';
export interface ReallocationPlanDto {
  planId: string;
  source: { kind: 'optimizeBudget' | 'agent' | 'route' };
  ops: ReallocationOpDto[];
  dropped: Array<{ platform: string; campaignId: string; reason: string }>;
  status: ReallocationStatus;
  approvalId?: string;
  results: Array<{ opIx: number; outcome: 'updated' | 'already_applied' | 'failed' | 'skipped'; error?: string }>;
  createdAt: string;
  expiresAt: string;
}
export type ApplyReallocationOutcome = 'applied' | 'partial' | 'rejected' | 'expired' | 'requires_approval' | 'in_progress';
export async function listReallocations(orgId: string): Promise<ReallocationPlanDto[]> {
  const r = await asJson<{ plans: ReallocationPlanDto[] }>(await fetch(`${base}/reallocations?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'reallocations');
  return r.plans;
}
export async function applyReallocationPlan(orgId: string, planId: string): Promise<{ outcome: ApplyReallocationOutcome; plan: ReallocationPlanDto }> {
  const res = await fetch(`${base}/reallocations/${encodeURIComponent(planId)}/apply`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId }) }));
  return asJson(res, 'applyReallocation');
}

/** ADR 0952 D2 — hard spend caps (per campaign or per client org). */
export type CapStatus = 'ok' | 'near' | 'breached' | 'stale';
export interface SpendCapDto {
  capId: string;
  scope: { kind: 'campaign'; campaignId: string } | { kind: 'client' };
  limitMinor: number;
  currency: string;
  period: 'lifetime' | 'calendar-month';
  maxStaleMinutes: number;
  version: number;
  state: { status: CapStatus; spentMinor: number | null; readAt: string | null; readError?: string; pausedTargets: unknown[] } | null;
}
export async function listSpendCaps(orgId: string): Promise<SpendCapDto[]> {
  return (await asJson<{ caps: SpendCapDto[] }>(await fetch(`${base}/caps?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'caps')).caps;
}
export async function createSpendCap(orgId: string, cap: { scope: SpendCapDto['scope']; limitMinor: number; currency: string; period: SpendCapDto['period'] }): Promise<SpendCapDto> {
  return asJson(await fetch(`${base}/caps`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, ...cap }) })), 'createCap');
}
export async function setSpendCapLimit(orgId: string, capId: string, limitMinor: number, version: number): Promise<SpendCapDto> {
  return asJson(await fetch(`${base}/caps/${encodeURIComponent(capId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ orgId, limitMinor, version }) })), 'setCapLimit');
}
export async function deleteSpendCap(orgId: string, capId: string): Promise<void> {
  const res = await fetch(`${base}/caps/${encodeURIComponent(capId)}?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson(res, 'deleteCap');
}

/** ADR 0952 D4 — the staged alert actions. */
export async function proposeReallocationPlan(orgId: string): Promise<{ outcome: 'proposed'; plan: ReallocationPlanDto } | { outcome: 'no_change'; dropped: Array<{ platform: string; campaignId: string; reason: string }> }> {
  return asJson(await fetch(`${base}/reallocations/propose`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId }) })), 'proposeReallocation');
}
export async function pauseCampaign(orgId: string, campaignId: string): Promise<{ results: Array<{ platform: string; campaignId: string; outcome: string; error?: string }> }> {
  return asJson(await fetch(`${base}/pause`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, campaignId }) })), 'pauseCampaign');
}
