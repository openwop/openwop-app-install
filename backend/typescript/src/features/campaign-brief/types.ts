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

/** A campaign spend plan (campaign gap plan §5C C8). Minor currency units,
 *  mirroring the ads adapter's `dailyBudgetMinor`. Advisory — enforcement is
 *  the adapter's spend gate (§5B B3) + the pacing chain (C7). */
export interface BriefBudget {
  /** Total plan for the campaign, minor units. */
  totalMinor?: number;
  /** ISO-4217, display-only (the store never converts). */
  currency?: string;
  /** Per-channel plan lines, minor units, keyed by channel type. */
  perChannel?: Partial<Record<CampaignChannel, number>>;
}

/** The UTM schema stamped onto outbound URLs at publish time (feeds the C5
 *  attribution join — utm_campaign is the deterministic key). */
export interface BriefUtm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
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
  /** ADR 0355 P5 — competitor names to differentiate against in generation
   *  (prompt block + a QA guard that drafts never parrot their claims). */
  competitors?: string[];
  /** ADR 0351 Phase 2 — how generation treats KB grounding. `off` = skip
   *  retrieval; `best-effort` (default) = ground when possible, proceed
   *  otherwise; `strict` = FAIL CLOSED when retrieval is unavailable or
   *  coverage is `none` (never a silently ungrounded draft). */
  groundingPolicy?: 'off' | 'best-effort' | 'strict';
  /** Product the campaign is about. */
  productName: string;
  productDescription: string;
  industryVertical: string;
  channels: BriefChannel[];
  messaging: BriefMessaging;
  /** Spend plan (C8). */
  budget?: BriefBudget;
  /** UTM schema for outbound URLs (C8 — feeds C5's attribution join). */
  utm?: BriefUtm;
  status: BriefStatus;
  kernel?: MessagingKernel;
  /** True when the brief changed after a kernel was generated (regen needed). */
  kernelStale: boolean;
  /** Monotonic content revision (campaign gap plan §5B B4). Rows written before
   *  versioning read back as 1. */
  version?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** An immutable brief revision snapshot (the CMS `PageVersion` precedent). */
export interface BriefVersion {
  versionId: string;
  tenantId: string;
  orgId: string;
  briefId: string;
  /** The brief `version` this snapshot captured. */
  version: number;
  snapshot: {
    name: string;
    objective: string;
    brandId?: string;
    personaIds: string[];
    productName: string;
    productDescription: string;
    industryVertical: string;
    channels: BriefChannel[];
    messaging: BriefMessaging;
    budget?: BriefBudget;
    utm?: BriefUtm;
    status: BriefStatus;
    kernel?: MessagingKernel;
  };
  actor: string;
  at: string;
  /** Monotonic tiebreaker for same-millisecond snapshots. */
  seq: number;
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
