/**
 * Marketing Campaign entity (ADR 0158) — the campaign container the orchestration
 * finalizes from a confirmed brief (ADR 0156). Holds the brief reference + the
 * kernel snapshot + the enabled channels + status. Channel drafts are run
 * artifacts (ADR 0157) referenced by the run, NOT embedded here.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */

import type { CampaignRunRole } from '../../host/campaignRefs.js';
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
  /** ADR 0941 D2 — set when `ensureDraftCampaign` created this row at ignition
   *  (before the first run). Absent on rows born at finalize (pre-0941). */
  ignitedAt?: string;
  /** ADR 0941 D2 — the first finalize. With `ignitedAt`, tells an ignition
   *  draft (not yet finalized) from a finalized campaign; a pre-0941 row has
   *  neither and was finalized when it was created. */
  finalizedAt?: string;
  /** ADR 0941 D1/D2b — the outcome target, media budget and guardrails, frozen
   *  into each run as `run.metadata.campaignGoal` at run start. */
  goal?: CampaignGoal;
  /** ADR 0941 D3 — catalog products (ADR 0410) of the SAME org this campaign
   *  sells; at most one `primary`. Validated against commerce on write. */
  productRefs?: CampaignProductRef[];
  /** ADR 0941 D1 / ADR 0942 — the autonomy policy binding (absent ⇒ the client
   *  org's default). Written only by ADR 0942's binding service. */
  autonomy?: { policyId: string; version: number };
  /** ADR 0941 D3 — system-raised flags needing a person (the `needs_attention`
   *  state). Not a `status`: status is the campaign's lifecycle. */
  attention?: CampaignAttention[];
  /** The last goal version before the goal was cleared, so a later goal never
   *  reuses a version a run may already name. */
  goalVersionFloor?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** ADR 0941 D1 — the campaign's outcome target. Owned here; read by the
 *  program's spend caps (0952), attribution (0956), cockpit (0960) and
 *  autopilot (0961). `version` bumps on every edit, and a run names the version
 *  it was started under (the run tag's `goalVersion`). */
export interface CampaignGoal {
  outcome: {
    metric: 'conversions' | 'purchases' | 'revenue' | 'leads' | 'qualified_leads' | 'roas' | 'cpa' | 'cpl';
    target: number;
    by?: string;
  };
  mediaBudget?: { totalMinor: number; currency: string; dailyCapMinor?: number };
  guardrails?: Array<{ metric: string; op: '<=' | '>='; value: number }>;
  version: number;
}

/** ADR 0941 D3 — a link to a commerce catalog product. */
export interface CampaignProductRef {
  productId: string;
  role: 'primary' | 'secondary';
}

/** ADR 0941 D3 — a flag the system raised on a campaign. */
export interface CampaignAttention {
  reason: 'product_deleted';
  productId: string;
  at: string;
}

/** ADR 0941 D2b — the run tag and its roles are host types (`host/campaignRefs.ts`). */
export type { CampaignRunRole, CampaignRunTag } from '../../host/campaignRefs.js';

/** ADR 0941 D2b — one row of the per-campaign run index. */
export interface CampaignRunIndexRow {
  tenantId: string;
  campaignId: string;
  orgId: string;
  runId: string;
  workflowId: string;
  startedAt: string;
  role?: CampaignRunRole;
  /** Set when the run is a `:fork`/redrive of `forkOf`. */
  forkOf?: string;
  /** Set when the run is a sub-workflow child of `parentRunId`. */
  parentRunId?: string;
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
