/**
 * Campaign Brief API client (ADR 0156). Personas + campaign briefs under
 * /host/openwop-app/campaign-brief/*. Reuses the shared client config; owns
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
export interface BriefBudget { totalMinor?: number; currency?: string; perChannel?: Partial<Record<CampaignChannel, number>> }
export interface BriefUtm { source?: string; medium?: string; campaign?: string; term?: string; content?: string }
export interface MessagingKernel {
  headline: string; supportingStatement: string; proofPoints: string[]; primaryCta: string; secondaryCta: string;
  tone: string; channelTones: Record<string, string>; sourceDocIds: string[]; generatedAt: string;
}
export type GroundingPolicy = 'off' | 'best-effort' | 'strict';

export interface CampaignBrief {
  id: string; tenantId: string; orgId: string; name: string; objective: string;
  brandId?: string; personaIds: string[]; kbCollectionId?: string;
  /** ADR 0351 P2 — off | best-effort | strict (strict fails generation closed). */
  groundingPolicy?: GroundingPolicy;
  /** ADR 0355 P5 — names to differentiate against in generation. */
  competitors?: string[];
  productName: string; productDescription: string; industryVertical: string;
  channels: BriefChannel[]; messaging: BriefMessaging; budget?: BriefBudget; utm?: BriefUtm; status: 'draft' | 'validated' | 'confirmed';
  kernel?: MessagingKernel; kernelStale: boolean; version?: number; createdBy: string; createdAt: string; updatedAt: string;
}
export interface BriefInput {
  orgId?: string; name?: string; objective?: string; brandId?: string; personaIds?: string[]; kbCollectionId?: string;
  groundingPolicy?: GroundingPolicy;
  competitors?: string[];
  productName?: string; productDescription?: string; industryVertical?: string;
  channels?: BriefChannel[]; messaging?: Partial<BriefMessaging>; budget?: BriefBudget | null; utm?: BriefUtm | null; status?: 'draft' | 'validated' | 'confirmed';
}
export interface ValidationResult { valid: boolean; issues: Array<{ field: string; message: string }>; enabledChannels: CampaignChannel[] }

export interface OrgRef { orgId: string; name: string }
export interface BrandRef { id: string; name: string }

export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/host/openwop-app/campaign-brief`;
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
export async function duplicateBrief(id: string, name?: string): Promise<CampaignBrief> {
  return (await asJson<{ brief: CampaignBrief }>(await fetch(`${base}/briefs/${encodeURIComponent(id)}/duplicate`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(name ? { name } : {}) })), 'duplicateBrief')).brief;
}
export async function deleteBrief(id: string): Promise<void> {
  await asJson<{ deleted: boolean }>(await fetch(`${base}/briefs/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'deleteBrief');
}
export async function validateBriefById(id: string): Promise<ValidationResult> {
  return asJson<ValidationResult>(await fetch(`${base}/briefs/${encodeURIComponent(id)}/validate`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'validateBrief');
}

// ── composed reads the forms need ──
export async function listOrgs(): Promise<OrgRef[]> {
  return (await asJson<{ orgs: OrgRef[] }>(await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}
export async function listBrands(orgId?: string): Promise<BrandRef[]> {
  const suffix = orgId ? `/brands?orgId=${encodeURIComponent(orgId)}` : '/brands';
  // R2 CB-SP-6 — only feature-OFF reads as "no brands" (optional association);
  // a 500/network failure THROWS like every other read here. The old catch-all
  // made a blip render "No brand — voice/guardrails off" as fact.
  try {
    return (await asJson<{ brands: BrandRef[] }>(await fetch(`${config.baseUrl}/host/openwop-app/brand${suffix}`, fetchOpts({ headers: authedHeaders() })), 'listBrands')).brands;
  } catch (e) {
    if (e instanceof FeatureDisabledError) return [];
    throw e;
  }
}

/** R2 CB-SP-1/CB-R2-2 — the tiny cross-feature read the delete confirm and the
 *  handoff chip need: which campaign (if any) was finalized from a brief. The
 *  per-feature-read precedent (listOrgs/listBrands above), never an import from
 *  the orchestration feature. */
export async function findCampaignForBrief(orgId: string, briefId: string): Promise<{ id: string; name: string } | null> {
  const res = await asJson<{ campaigns: Array<{ id: string; name: string; briefId: string }> }>(
    await fetch(`${config.baseUrl}/host/openwop-app/campaign-orchestration/campaigns?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() })), 'findCampaignForBrief');
  const hit = res.campaigns.find((c) => c.briefId === briefId);
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** The Brief Strategist agent id the chat deep-link scopes to (ADR 0058). */
export const BRIEF_STRATEGIST_AGENT = 'feature.campaign-brief.agents.brief-strategist';

// ── ADR 0403 — market intel (VOC evidence · angles · hook bank · targeting) ──

export const VOC_SENTIMENTS = ['pain', 'desire', 'objection', 'praise'] as const;
export type VocSentiment = (typeof VOC_SENTIMENTS)[number];

export interface VocEvidence {
  id: string; briefId: string; orgId: string;
  quote: string;
  sourceRef: { documentId: string; sourceKind: 'kb' | 'notebook' | 'web' | 'manual'; locator: string; contentHash: string };
  theme: string; sentiment: VocSentiment; personaHint?: string;
  createdBy: string; createdAt: string;
}

export interface AdAngle {
  id: string; briefId: string; orgId: string;
  claim: string; positioningLens: string; proofRefs: string[];
  hookVariants: Array<{ text: string; format: string }>;
  createdBy: string; createdAt: string;
}

export const HOOK_STATUSES = ['candidate', 'tested', 'retired'] as const;
export type HookStatus = (typeof HOOK_STATUSES)[number];

export interface Hook {
  id: string; orgId: string; text: string; format: string; angleId?: string;
  status: HookStatus; metricRef?: string; createdBy: string; createdAt: string; updatedAt: string;
}

export const TARGETING_PLATFORMS = ['meta', 'google', 'linkedin', 'tiktok'] as const;
export type TargetingPlatform = (typeof TARGETING_PLATFORMS)[number];

export interface TargetingPack {
  id: string; briefId: string; orgId: string; platform: TargetingPlatform;
  audiences: string[]; interests: string[]; keywords: string[];
  rationale: string; evidenceRefs: string[]; createdBy: string; createdAt: string; updatedAt: string;
}

export async function listVocEvidence(briefId: string, filter?: { sentiment?: VocSentiment; theme?: string }): Promise<VocEvidence[]> {
  const params = new URLSearchParams();
  if (filter?.sentiment) params.set('sentiment', filter.sentiment);
  if (filter?.theme) params.set('theme', filter.theme);
  const qs = params.toString();
  return (await asJson<{ evidence: VocEvidence[] }>(await fetch(`${base}/briefs/${encodeURIComponent(briefId)}/voc${qs ? `?${qs}` : ''}`, fetchOpts({ headers: authedHeaders() })), 'listVocEvidence')).evidence;
}
export async function deleteVocEvidence(briefId: string, evidenceId: string): Promise<void> {
  const res = await fetch(`${base}/briefs/${encodeURIComponent(briefId)}/voc/${encodeURIComponent(evidenceId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `deleteVocEvidence returned ${res.status}`);
  }
}

export async function listAngles(briefId: string): Promise<AdAngle[]> {
  return (await asJson<{ angles: AdAngle[] }>(await fetch(`${base}/briefs/${encodeURIComponent(briefId)}/angles`, fetchOpts({ headers: authedHeaders() })), 'listAngles')).angles;
}
export async function deleteAngle(briefId: string, angleId: string): Promise<void> {
  const res = await fetch(`${base}/briefs/${encodeURIComponent(briefId)}/angles/${encodeURIComponent(angleId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteAngle returned ${res.status}`);
}

export async function listHooks(orgId: string, status?: HookStatus): Promise<Hook[]> {
  const params = new URLSearchParams({ orgId });
  if (status) params.set('status', status);
  return (await asJson<{ hooks: Hook[] }>(await fetch(`${base}/hooks?${params.toString()}`, fetchOpts({ headers: authedHeaders() })), 'listHooks')).hooks;
}
export async function promoteHook(hookId: string, orgId: string, status: HookStatus, metricRef?: string): Promise<Hook> {
  return (await asJson<{ hook: Hook }>(await fetch(`${base}/hooks/${encodeURIComponent(hookId)}/promote`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, status, ...(metricRef ? { metricRef } : {}) }) })), 'promoteHook')).hook;
}

export async function listTargetingPacks(briefId: string): Promise<TargetingPack[]> {
  return (await asJson<{ packs: TargetingPack[] }>(await fetch(`${base}/briefs/${encodeURIComponent(briefId)}/targeting`, fetchOpts({ headers: authedHeaders() })), 'listTargetingPacks')).packs;
}
export async function deleteTargetingPack(briefId: string, platform: TargetingPlatform): Promise<void> {
  const res = await fetch(`${base}/briefs/${encodeURIComponent(briefId)}/targeting/${encodeURIComponent(platform)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteTargetingPack returned ${res.status}`);
}
