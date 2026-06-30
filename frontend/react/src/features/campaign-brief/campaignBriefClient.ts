/**
 * Campaign Brief API client (ADR 0156). Personas + campaign briefs under
 * /v1/host/openwop-app/campaign-brief/*. Reuses the shared client config; owns
 * the small `orgs` + `brands` reads the forms need (per-feature, not a
 * cross-feature import — the strategy/priority-matrix precedent).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export const BUYER_STAGES = ['unaware', 'problem_aware', 'solution_aware', 'product_aware'] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];
export const CAMPAIGN_CHANNELS = ['landing_page', 'ad_variants', 'email_sequence', 'creative_briefs', 'social_posts'] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export interface Persona {
  id: string; tenantId: string; orgId: string; name: string; role: string;
  buyerStage: BuyerStage; painPoints: string[]; objections: string[]; goals: string[];
  demographics: string; brandId?: string; createdBy: string; createdAt: string; updatedAt: string;
}
export interface PersonaInput {
  orgId?: string; name?: string; role?: string; buyerStage?: BuyerStage;
  painPoints?: string[]; objections?: string[]; goals?: string[]; demographics?: string; brandId?: string;
}

export interface BriefChannel { type: CampaignChannel; enabled: boolean; config: Record<string, unknown> }
export interface BriefMessaging { primaryValueProp: string; toneOverride: string; proofPoints: string[]; ctaStrategy: string }
export interface MessagingKernel {
  headline: string; supportingStatement: string; proofPoints: string[]; primaryCta: string; secondaryCta: string;
  tone: string; channelTones: Record<string, string>; sourceDocIds: string[]; generatedAt: string;
}
export interface CampaignBrief {
  id: string; tenantId: string; orgId: string; name: string; objective: string;
  brandId?: string; personaIds: string[]; kbCollectionId?: string;
  productName: string; productDescription: string; industryVertical: string;
  channels: BriefChannel[]; messaging: BriefMessaging; status: 'draft' | 'validated' | 'confirmed';
  kernel?: MessagingKernel; kernelStale: boolean; createdBy: string; createdAt: string; updatedAt: string;
}
export interface BriefInput {
  orgId?: string; name?: string; objective?: string; brandId?: string; personaIds?: string[]; kbCollectionId?: string;
  productName?: string; productDescription?: string; industryVertical?: string;
  channels?: BriefChannel[]; messaging?: Partial<BriefMessaging>; status?: 'draft' | 'validated' | 'confirmed';
}
export interface ValidationResult { valid: boolean; issues: Array<{ field: string; message: string }>; enabledChannels: CampaignChannel[] }

export interface OrgRef { orgId: string; name: string }
export interface BrandRef { id: string; name: string }

export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/v1/host/openwop-app/campaign-brief`;
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

// ── personas ──
export async function listPersonas(orgId?: string): Promise<Persona[]> {
  const suffix = orgId ? `/personas?orgId=${encodeURIComponent(orgId)}` : '/personas';
  return (await asJson<{ personas: Persona[] }>(await fetch(`${base}${suffix}`, fetchOpts({ headers: authedHeaders() })), 'listPersonas')).personas;
}
export async function createPersona(input: PersonaInput): Promise<Persona> {
  return (await asJson<{ persona: Persona }>(await fetch(`${base}/personas`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })), 'createPersona')).persona;
}
export async function updatePersona(id: string, patch: PersonaInput): Promise<Persona> {
  return (await asJson<{ persona: Persona }>(await fetch(`${base}/personas/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updatePersona')).persona;
}
export async function deletePersona(id: string): Promise<void> {
  await asJson<{ deleted: boolean }>(await fetch(`${base}/personas/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'deletePersona');
}

// ── briefs ──
export async function listBriefs(orgId?: string): Promise<CampaignBrief[]> {
  const suffix = orgId ? `/briefs?orgId=${encodeURIComponent(orgId)}` : '/briefs';
  return (await asJson<{ briefs: CampaignBrief[] }>(await fetch(`${base}${suffix}`, fetchOpts({ headers: authedHeaders() })), 'listBriefs')).briefs;
}
export async function createBrief(input: BriefInput): Promise<CampaignBrief> {
  return (await asJson<{ brief: CampaignBrief }>(await fetch(`${base}/briefs`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })), 'createBrief')).brief;
}
export async function updateBrief(id: string, patch: BriefInput): Promise<CampaignBrief> {
  return (await asJson<{ brief: CampaignBrief }>(await fetch(`${base}/briefs/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updateBrief')).brief;
}
export async function deleteBrief(id: string): Promise<void> {
  await asJson<{ deleted: boolean }>(await fetch(`${base}/briefs/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'deleteBrief');
}
export async function validateBriefById(id: string): Promise<ValidationResult> {
  return asJson<ValidationResult>(await fetch(`${base}/briefs/${encodeURIComponent(id)}/validate`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'validateBrief');
}

// ── composed reads the forms need ──
export async function listOrgs(): Promise<OrgRef[]> {
  return (await asJson<{ orgs: OrgRef[] }>(await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}
export async function listBrands(orgId?: string): Promise<BrandRef[]> {
  const suffix = orgId ? `/brands?orgId=${encodeURIComponent(orgId)}` : '/brands';
  try {
    return (await asJson<{ brands: BrandRef[] }>(await fetch(`${config.baseUrl}/v1/host/openwop-app/brand${suffix}`, fetchOpts({ headers: authedHeaders() })), 'listBrands')).brands;
  } catch { return []; } // brand feature may be OFF — optional association
}

/** The Brief Strategist agent id the chat deep-link scopes to (ADR 0058). */
export const BRIEF_STRATEGIST_AGENT = 'feature.campaign-brief.agents.brief-strategist';
