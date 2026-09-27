/**
 * Marketing Campaign entity (ADR 0158) — the campaign container the orchestration
 * finalizes from a confirmed brief (ADR 0156). Holds the brief reference + the
 * kernel snapshot + the enabled channels + status. Channel drafts are run
 * artifacts (ADR 0157) referenced by the run, NOT embedded here.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */

import type { BriefBudget, BriefUtm, CampaignChannel, MessagingKernel } from '../campaign-brief/types.js';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';

export interface MarketingCampaign {
  id: string;
  tenantId: string;
  orgId: string;
  /** The brief this campaign was finalized from (one campaign per brief). */
  briefId: string;
  name: string;
  objective: string;
  brandId?: string;
  personaIds: string[];
  kbCollectionId?: string;
  /** The enabled channel types at finalize time. */
  channels: CampaignChannel[];
  /** ADR 0356 P1 — the production plan generated in the spine's post-merge slot. */
  productionPlanId?: string;
  /** The messaging kernel snapshot (the strategic foundation). */
  kernel?: MessagingKernel;
  /** Spend plan carried from the brief at finalize (C8). */
  budget?: BriefBudget;
  /** UTM schema carried from the brief at finalize (C8 — the C5 join key). */
  utm?: BriefUtm;
  /** Optional parent for campaign hierarchy (C8) — a plain reference, no cascade. */
  parentCampaignId?: string;
  /** Media asset ids associated with this campaign (generated concepts +
   *  attached library assets); the durable campaign→asset edge (CS-DATA-5). */
  assetIds?: string[];
  status: CampaignStatus;
  /** Monotonic revision, bumped on re-finalize (campaign gap plan §5B B4).
   *  Rows written before versioning read back as 1. */
  version?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** An immutable campaign revision snapshot (the CMS `PageVersion` precedent). */
export interface CampaignVersion {
  versionId: string;
  tenantId: string;
  orgId: string;
  campaignId: string;
  version: number;
  snapshot: {
    name: string;
    objective: string;
    brandId?: string;
    personaIds: string[];
    channels: CampaignChannel[];
    kernel?: MessagingKernel;
    status: CampaignStatus;
  };
  actor: string;
  at: string;
  seq: number;
}

/** One dimension of the cross-asset consistency report. */
export interface ConsistencyDimension {
  name: string;
  score: number;
  description: string;
}

/** The consistency report (drafts vs the kernel). */
export interface ConsistencyReport {
  score: number;
  dimensions: ConsistencyDimension[];
  divergences: Array<{ channel: string; severity: 'low' | 'medium' | 'high'; description: string }>;
  /** Whether the score meets the advisory threshold (default 80). */
  passesThreshold: boolean;
  checkedAt: string;
}

export type { CampaignChannel, MessagingKernel };
