/**
 * Campaign Intelligence API client (ADR 0160). Budget recommendations + forecast
 * under /v1/host/openwop-app/campaign-intel/*.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface BudgetReallocation { platform: string; currentSpend: number; suggestedSpend: number; changeAmount: number; changePercent: number; roas: number; reason: string }
export interface BudgetRecommendation { totalSpend: number; reallocations: BudgetReallocation[]; projectedRoasGain: number; note: string }
export interface CampaignForecast {
  campaignName: string; platform: string;
  creativeFatigue: { detected: boolean; firstHalfCtr: number; secondHalfCtr: number; dropPercent: number };
  projection: { days: number; projectedSpend: number; projectedConversions: number };
}
export interface OrgRef { orgId: string; name: string }

export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/v1/host/openwop-app/campaign-intel`;

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
export async function getForecast(orgId: string): Promise<CampaignForecast[]> {
  return (await asJson<{ forecasts: CampaignForecast[] }>(await fetch(`${base}/forecast?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'getForecast')).forecasts;
}
export async function listOrgs(): Promise<OrgRef[]> {
  return (await asJson<{ orgs: OrgRef[] }>(await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}

/** The Analyst agent the chat deep-link scopes to (ADR 0058). */
export const INTELLIGENCE_ANALYST_AGENT = 'feature.campaign-intel.agents.intelligence-analyst';
