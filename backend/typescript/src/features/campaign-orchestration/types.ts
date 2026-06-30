/**
 * Marketing Campaign entity (ADR 0158) — the campaign container the orchestration
 * finalizes from a confirmed brief (ADR 0156). Holds the brief reference + the
 * kernel snapshot + the enabled channels + status. Channel drafts are run
 * artifacts (ADR 0157) referenced by the run, NOT embedded here.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */

import type { CampaignChannel, MessagingKernel } from '../campaign-brief/types.js';

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
  /** The messaging kernel snapshot (the strategic foundation). */
  kernel?: MessagingKernel;
  status: CampaignStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
