/**
 * Campaign Studio API client (ADR 0158). The MarketingCampaign container under
 * /host/openwop-app/campaign-orchestration/*. Reuses the shared client config; owns
 * the small briefs read the finalize picker needs.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';

export interface MessagingKernel {
  headline: string; supportingStatement: string; proofPoints: string[]; primaryCta: string; secondaryCta: string;
  tone: string; channelTones: Record<string, string>; sourceDocIds: string[]; generatedAt: string;
}
/** R2 CO-SP-7 — the campaign's planned spend rides every payload (carried from
 *  the brief at finalize). `currency` is ISO-4217, display-only. */
export interface CampaignBudget { totalMinor?: number; currency?: string; perChannel?: Record<string, number> }
export interface MarketingCampaign {
  id: string; tenantId: string; orgId: string; briefId: string; name: string; objective: string;
  brandId?: string; personaIds: string[]; kbCollectionId?: string; channels: string[];
  kernel?: MessagingKernel; status: CampaignStatus; version?: number; createdBy: string; createdAt: string; updatedAt: string;
  budget?: CampaignBudget; parentCampaignId?: string;
}
/** One row of the adapter's fork-stable ad dispatch ledger (campaign gap plan §5B B5). */
export interface AdDispatch {
  platform: string; platformCampaignId: string; platformAdSetId: string; platformAdId: string;
  campaignName?: string; dailyBudgetMinor?: number; createdAt: string;
  /** ORCH-G2 — WHICH ad account holds this campaign. The ledger already carries
   *  it (`DispatchLedgerRow`); without it an operator who needs to act on the
   *  platform has an opaque campaign id and nowhere to take it. */
  adAccountId?: string;
}
export interface BriefRef { id: string; name: string; status: string; kernel?: MessagingKernel }
export interface OrgRef { orgId: string; name: string }

export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/host/openwop-app/campaign-orchestration`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    if (res.status === 404 && /not enabled/i.test(detail)) throw new FeatureDisabledError(detail);
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listCampaigns(orgId?: string): Promise<MarketingCampaign[]> {
  const suffix = orgId ? `/campaigns?orgId=${encodeURIComponent(orgId)}` : '/campaigns';
  return (await asJson<{ campaigns: MarketingCampaign[] }>(await fetch(`${base}${suffix}`, fetchOpts({ headers: authedHeaders() })), 'listCampaigns')).campaigns;
}
export async function finalizeBrief(briefId: string): Promise<MarketingCampaign> {
  return (await asJson<{ campaign: MarketingCampaign }>(await fetch(`${base}/finalize`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ briefId }) })), 'finalize')).campaign;
}
export async function updateCampaign(id: string, patch: { name?: string; status?: CampaignStatus }): Promise<MarketingCampaign> {
  return (await asJson<{ campaign: MarketingCampaign }>(await fetch(`${base}/campaigns/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updateCampaign')).campaign;
}
export async function deleteCampaign(id: string): Promise<void> {
  await asJson<{ deleted: boolean }>(await fetch(`${base}/campaigns/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'deleteCampaign');
}
export async function listBriefs(orgId?: string): Promise<BriefRef[]> {
  // R2 CO-SP-2 — this used to `catch { return [] }`, so a failed/forbidden/
  // feature-disabled read rendered "No briefs found" in the finalize picker.
  // A failure must throw like every other function here; the caller renders it.
  const suffix = orgId ? `/briefs?orgId=${encodeURIComponent(orgId)}` : '/briefs';
  return (await asJson<{ briefs: BriefRef[] }>(await fetch(`${config.baseUrl}/host/openwop-app/campaign-brief${suffix}`, fetchOpts({ headers: authedHeaders() })), 'listBriefs')).briefs;
}
export async function listDispatches(campaignId: string): Promise<AdDispatch[]> {
  return (await asJson<{ dispatches: AdDispatch[] }>(await fetch(`${base}/campaigns/${encodeURIComponent(campaignId)}/dispatches`, fetchOpts({ headers: authedHeaders() })), 'listDispatches')).dispatches;
}
export async function listOrgs(): Promise<OrgRef[]> {
  return (await asJson<{ orgs: OrgRef[] }>(await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}

export const CAMPAIGN_STATUSES: ReadonlyArray<CampaignStatus> = ['draft', 'active', 'paused', 'completed', 'archived'];
/** The Campaign Strategist agent the chat deep-link scopes to (ADR 0058). */
export const CAMPAIGN_STRATEGIST_AGENT = 'feature.campaign-orchestration.agents.campaign-strategist';
