/**
 * ADR 0946 P5 — read client for a campaign's variant sets (P0 routes). Kept in
 * its own module so it loads with the lazy Variants section, not the page.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { FeatureDisabledError } from './campaignStudioClient.js';

export type VariantSetStatus = 'draft' | 'preflight' | 'in_review' | 'approved' | 'superseded';
export type VariantMemberKind = 'copy' | 'image' | 'video' | 'landing' | 'email';

export interface VariantConcept {
  conceptId: string;
  axes: { angle: string; personaId?: string; hook: string; visual: string; format: string };
  rationale: string;
}

export interface VariantMember {
  memberId: string;
  conceptId: string;
  channel: string;
  kind: VariantMemberKind;
  ref: { copy: Record<string, string> } | { mediaAssetId: string } | { pageId: string; pageVersion: number } | { emailTemplateId: string; version: number };
  contentHash: string;
}

export interface VariantFinding {
  id: string;
  ruleId: string;
  action: 'block' | 'needs_review' | 'info';
  assetId: string;
  message: string;
}

export interface VariantSet {
  setId: string;
  campaignId: string;
  version: number;
  headVersion: number;
  hash: string;
  status: VariantSetStatus;
  concepts: VariantConcept[];
  members: VariantMember[];
  diversity?: {
    conceptDistance: { mean: number; min: number; axisCoverage: Record<string, number> };
    clusters: Array<{ memberIds: string[] }>;
    embeddingModel?: string;
    scoredAt: string;
  };
  preflight?: { rulesetVersion: string; digest: string; findings: VariantFinding[] };
  createdAt: string;
}

const base = (campaignId: string): string => `${config.baseUrl}/host/openwop-app/campaign-orchestration/campaigns/${encodeURIComponent(campaignId)}/variant-sets`;

async function read<T>(url: string, ctx: string): Promise<T> {
  const res = await fetch(url, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    if (res.status === 404 && /not enabled/i.test(detail)) throw new FeatureDisabledError(detail);
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listVariantSets(campaignId: string): Promise<VariantSet[]> {
  return (await read<{ variantSets: VariantSet[] }>(base(campaignId), 'listVariantSets')).variantSets;
}

export async function listVariantSetVersions(campaignId: string, setId: string): Promise<VariantSet[]> {
  return (await read<{ versions: VariantSet[] }>(`${base(campaignId)}/${encodeURIComponent(setId)}/versions`, 'listVariantSetVersions')).versions;
}
