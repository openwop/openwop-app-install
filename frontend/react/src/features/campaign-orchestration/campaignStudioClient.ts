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
  /** ADR 0852 D1 — the linked project (single-campaign reads only). */
  projectId?: string;
  /** ADR 0941 D3 — catalog products this campaign sells (same org). */
  productRefs?: CampaignProductRef[];
  /** ADR 0941 D3 — system flags needing a person (e.g. a linked product was deleted). */
  attention?: CampaignAttention[];
}
export interface CampaignProductRef { productId: string; role: 'primary' | 'secondary' }
export interface CampaignAttention { reason: 'product_deleted'; productId: string; at: string }

/** ADR 0941 D1 — one section of `GET …/campaigns/:id/links`. A failed read is
 *  `failed` and a feature that is off is `unavailable`: neither is "not linked". */
export type LinkSection<T> =
  | { status: 'ok'; items: T[] }
  | { status: 'unavailable'; reason: 'feature_off' }
  | { status: 'failed'; error: 'read_failed' };
type LinkState = 'linked' | 'missing';
export interface CampaignLinks {
  products: LinkSection<{ productId: string; role: CampaignProductRef['role']; state: LinkState; name?: string }>;
  /** Supplied once ADR 0948 links funnels from the funnel side (`funnel.campaignId`);
   *  absent until then, and an absent section renders no row. */
  funnels?: LinkSection<{ funnelId: string; state: LinkState; name?: string; status?: string }>;
  project: LinkSection<{ projectId: string }>;
  assets: LinkSection<{ assetId: string; state: LinkState; name?: string }>;
  runs: LinkSection<{ runId: string; workflowId: string; startedAt: string; role?: string; forkOf?: string; parentRunId?: string }>;
  emailSends: LinkSection<{ sendId: string; status: string; templateId: string; legacy?: true }>;
  adDispatches: LinkSection<{ platform: string; platformCampaignId: string; createdAt: string; legacy?: true }>;
  plans: LinkSection<{ canvasId: string; linkedAt: string }>;
  opsAssets: LinkSection<{ assetId: string; label: string; destination: string }>;
  assetTotal: number;
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
export async function updateCampaign(id: string, patch: { name?: string; status?: CampaignStatus; productRefs?: CampaignProductRef[]; attention?: [] }): Promise<MarketingCampaign> {
  return (await asJson<{ campaign: MarketingCampaign }>(await fetch(`${base}/campaigns/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updateCampaign')).campaign;
}
/** ADR 0852 — one campaign, with its linked `projectId` when it has one. */
export async function getCampaign(id: string): Promise<MarketingCampaign> {
  return (await asJson<{ campaign: MarketingCampaign }>(await fetch(`${base}/campaigns/${encodeURIComponent(id)}`, fetchOpts({ headers: authedHeaders() })), 'getCampaign')).campaign;
}
/** ADR 0852 D1 — create-or-return the campaign's linked project (needs write). */
export async function ensureCampaignProject(id: string): Promise<string> {
  return (await asJson<{ projectId: string }>(await fetch(`${base}/campaigns/${encodeURIComponent(id)}/project`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'ensureCampaignProject')).projectId;
}
/** ADR 0941 D1 — every link of a campaign, read through each owner. */
export async function getCampaignLinks(id: string): Promise<CampaignLinks> {
  return (await asJson<{ links: CampaignLinks }>(await fetch(`${base}/campaigns/${encodeURIComponent(id)}/links`, fetchOpts({ headers: authedHeaders() })), 'getCampaignLinks')).links;
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

/** ADR 0960 D1 — the campaign command snapshot (runs, live nodes, open gates). */
export interface CommandSnapshot {
  campaign: { id: string; orgId: string; name: string; status: CampaignStatus; goalVersion?: number };
  runs: Array<{ runId: string; workflowId: string; role: string; status: string; startedAt: string; definitionRevision?: string; parentRunId?: string }>;
  runsTruncated: boolean;
  nodes: Array<{ runId: string; nodeId: string; status: 'running' | 'completed' | 'failed' | 'suspended' }>;
  nodesTruncated: boolean;
  gates: Array<{ interruptId: string; runId: string; nodeId: string; kind: string; createdAt: string; ageMs: number }>;
  gatesTruncated: boolean;
  unavailable: Record<string, string>;
  generatedAt: string;
}
export async function getCommand(campaignId: string): Promise<CommandSnapshot> {
  return (await asJson<{ command: CommandSnapshot }>(await fetch(`${base}/campaigns/${encodeURIComponent(campaignId)}/command`, fetchOpts({ headers: authedHeaders() })), 'getCommand')).command;
}
/** ADR 0960 D3 — the definition a campaign run executed (pinned revision, else head). */
export async function getCommandRunDefinition(campaignId: string, runId: string): Promise<{ runId: string; workflowId: string; definition: unknown }> {
  return asJson<{ runId: string; workflowId: string; definition: unknown }>(await fetch(`${base}/campaigns/${encodeURIComponent(campaignId)}/command/runs/${encodeURIComponent(runId)}/definition`, fetchOpts({ headers: authedHeaders() })), 'getCommandRunDefinition');
}

export const CAMPAIGN_STATUSES: ReadonlyArray<CampaignStatus> = ['draft', 'active', 'paused', 'completed', 'archived'];
/** The Campaign Strategist agent the chat deep-link scopes to (ADR 0058). */
export const CAMPAIGN_STRATEGIST_AGENT = 'vendor.openwop-app.campaign-orchestration.agents.campaign-strategist';

/** ADR 0941 D5 — the deep-linkable campaign detail. */
export const campaignDetailPath = (id: string): string => `/campaign-studio/campaigns/${encodeURIComponent(id)}`;
/** ADR 0948 P3a — the Funnel Architect (funnels' agent pack); pinned against
 *  `features/funnels/FunnelArchitectPanel.tsx` FUNNEL_ARCHITECT_AGENT_ID by test. */
export const FUNNEL_ARCHITECT_AGENT = 'vendor.openwop-app.funnels.agents.funnel-architect';
