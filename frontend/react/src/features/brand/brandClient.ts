/**
 * Brand API client (ADR 0155). The Brand & Guardrails surface under
 * /v1/host/openwop-app/brand/*. Reuses the shared client config
 * (`authedHeaders`/`fetchOpts`) — no bespoke fetch. Owns the small `orgs` read
 * the create form needs (per-feature, not a cross-feature import — the
 * priorityMatrixClient precedent).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export const BRAND_CHANNELS = [
  'landing_page', 'ad_variants', 'email_sequence', 'creative_briefs', 'social_posts',
] as const;
export type BrandChannel = (typeof BRAND_CHANNELS)[number];

export type BrandLockLevel = 'none' | 'partial' | 'full';

export interface BrandVoiceProfile {
  voice: string;
  guidelines: string;
  formalityLevel: number;
  samplePhrases: string[];
  avoidPhrases: string[];
  toneRegisters: Array<{ name: string; description: string; formalityLevel?: number; samplePhrases: string[]; avoidPhrases: string[] }>;
}
export interface BrandPositioning { tagline: string; elevatorPitch: string; differentiators: string[]; competitiveFrame: string }
export interface BrandKeyPhrases { approvedTaglines: string[]; valuePropositions: string[]; productDescriptors: string[]; bannedPhrases: string[] }
export interface ChannelVoiceRule { channel: BrandChannel; tone: string; formalityOverride?: number; maxLength?: number; samplePhrases: string[]; avoidPhrases: string[] }
export interface BrandGovernance { lockLevel: BrandLockLevel; allowedEditors: string[]; requireApproval: boolean }

export interface Brand {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  parentBrandId?: string;
  voiceProfile: BrandVoiceProfile;
  positioning: BrandPositioning;
  keyPhrases: BrandKeyPhrases;
  channelVoiceRules: ChannelVoiceRule[];
  governance: BrandGovernance;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgRef { orgId: string; name: string }

/** The editable shape the create/update form posts (server fills the rest). */
export interface BrandInput {
  orgId?: string;
  name?: string;
  description?: string;
  status?: 'active' | 'archived';
  voiceProfile?: Partial<BrandVoiceProfile>;
  positioning?: Partial<BrandPositioning>;
  keyPhrases?: Partial<BrandKeyPhrases>;
  channelVoiceRules?: ChannelVoiceRule[];
  governance?: Partial<BrandGovernance>;
}

/** Thrown when the `brand` toggle is OFF (the route 404s with "not enabled"). */
export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/v1/host/openwop-app/brand`;
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

export async function listBrands(orgId?: string): Promise<Brand[]> {
  const suffix = orgId ? `/brands?orgId=${encodeURIComponent(orgId)}` : '/brands';
  const res = await fetch(`${base}${suffix}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ brands: Brand[] }>(res, 'listBrands')).brands;
}

export async function getBrand(id: string): Promise<Brand> {
  const res = await fetch(`${base}/brands/${encodeURIComponent(id)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ brand: Brand }>(res, 'getBrand')).brand;
}

export async function createBrand(input: BrandInput): Promise<Brand> {
  const res = await fetch(`${base}/brands`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ brand: Brand }>(res, 'createBrand')).brand;
}

export async function updateBrand(id: string, patch: BrandInput): Promise<Brand> {
  const res = await fetch(`${base}/brands/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return (await asJson<{ brand: Brand }>(res, 'updateBrand')).brand;
}

export async function deleteBrand(id: string): Promise<void> {
  const res = await fetch(`${base}/brands/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await asJson<{ deleted: boolean }>(res, 'deleteBrand');
}

export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}
