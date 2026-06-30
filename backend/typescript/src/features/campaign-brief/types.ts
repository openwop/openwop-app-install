/**
 * Personas & Campaign Brief entity types (ADR 0156) — the second layer of the
 * Campaign Studio cluster (docs/campaign-studio-prd.md). A `Persona` is a
 * content-targeting archetype (buyer stage, pain points, objections) — DISTINCT
 * from a CRM contact (a real person). A `CampaignBrief` gathers product + persona
 * + brand + channels into one workspace and holds the generated messaging kernel.
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

/** Buyer awareness stage (MyndHyve parity) — calibrates content depth + CTA. */
export const BUYER_STAGES = ['unaware', 'problem_aware', 'solution_aware', 'product_aware'] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];

/** The five Campaign Studio channels (aligned with ADR 0155/0157). */
export const CAMPAIGN_CHANNELS = [
  'landing_page', 'ad_variants', 'email_sequence', 'creative_briefs', 'social_posts',
] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

/** A content-targeting persona. Tenant+org scoped; optionally tied to a brand. */
export interface Persona {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  /** Job title / role (e.g. "Operations Director"). */
  role: string;
  buyerStage: BuyerStage;
  painPoints: string[];
  objections: string[];
  goals: string[];
  /** Free-form audience notes (industry, seniority, context). */
  demographics: string;
  /** Optional association to a Brand (ADR 0155). */
  brandId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One channel slot on a brief — enabled flag + open per-channel config. */
export interface BriefChannel {
  type: CampaignChannel;
  enabled: boolean;
  /** Open per-channel config (ad platforms, email sequence type…); typed in 0157. */
  config: Record<string, unknown>;
}

/** Messaging parameters the user sets (steer generation). */
export interface BriefMessaging {
  primaryValueProp: string;
  toneOverride: string;
  proofPoints: string[];
  ctaStrategy: string;
}

/** The messaging kernel — the shared strategic foundation every channel echoes. */
export interface MessagingKernel {
  headline: string;
  supportingStatement: string;
  proofPoints: string[];
  primaryCta: string;
  secondaryCta: string;
  tone: string;
  /** Optional per-channel tone overrides keyed by channel type. */
  channelTones: Partial<Record<CampaignChannel, string>>;
  /** KB document ids the kernel was grounded in (citation tracing). */
  sourceDocIds: string[];
  generatedAt: string;
}

export type BriefStatus = 'draft' | 'validated' | 'confirmed';

/** A campaign brief — the workspace that holds all generated assets' context. */
export interface CampaignBrief {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  objective: string;
  brandId?: string;
  personaIds: string[];
  kbCollectionId?: string;
  /** Product the campaign is about. */
  productName: string;
  productDescription: string;
  industryVertical: string;
  channels: BriefChannel[];
  messaging: BriefMessaging;
  status: BriefStatus;
  kernel?: MessagingKernel;
  /** True when the brief changed after a kernel was generated (regen needed). */
  kernelStale: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A validation finding from `brief.validate`. */
export interface BriefValidationIssue {
  field: string;
  message: string;
}

export interface BriefValidationResult {
  valid: boolean;
  issues: BriefValidationIssue[];
  /** The enabled channel types (drives the orchestration fan-out in 0158). */
  enabledChannels: CampaignChannel[];
}

export const EMPTY_MESSAGING: BriefMessaging = {
  primaryValueProp: '', toneOverride: '', proofPoints: [], ctaStrategy: '',
};

/** A brief seeds one slot per channel, all disabled until the user enables them. */
export function defaultChannels(): BriefChannel[] {
  return CAMPAIGN_CHANNELS.map((type) => ({ type, enabled: false, config: {} }));
}
