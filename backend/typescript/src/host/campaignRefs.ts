/**
 * ADR 0941 D1 / D2b — the campaign reference seam.
 *
 * Every campaign-scoped child record (an email send, an ad dispatch, a plan, a
 * campaign-ops asset or change request) points UP at its `MarketingCampaign`.
 * Those owners must not import `features/campaign-orchestration` (some sit
 * below it, and the reverse edges exist), so the campaign owner registers a
 * resolver here at boot and the writers call through it.
 *
 * - `assertCampaignRef` refuses a dangling id: a campaign that does not exist
 *   and a campaign of another org are the same 404 (no cross-client existence
 *   leak). With no resolver registered it FAILS CLOSED.
 * - `readCampaignRunTag` is the one reader of the host-written run tag
 *   (`run.metadata.campaignOrchestration`). It lives here, beside the key's
 *   strip list (`host/runDispatch.ts` `CAMPAIGN_ATTRIBUTION_KEYS`), so core
 *   modules (the ads adapter) can read the tag without importing the feature.
 *
 * @see docs/adr/0941-campaign-studio-program-and-canonical-campaign.md
 */

import { OpenwopError } from '../types.js';

/** The host-written run-metadata key holding the campaign run tag. */
export const CAMPAIGN_RUN_TAG_KEY = 'campaignOrchestration';
/** The ADR 0921 client stamp a campaign-ops run carries. */
const CAMPAIGN_OPS_STAMP_KEY = 'openwop-app.campaignOps';

export type CampaignRunRole = 'spine' | 'stage' | 'optimizer' | 'report';
const ROLES: readonly CampaignRunRole[] = ['spine', 'stage', 'optimizer', 'report'];

/** ADR 0941 D2b — the run tag. The ONE source of "which campaign and client is this run for". */
export interface CampaignRunTag {
  campaignId: string;
  orgId: string;
  briefId?: string;
  /** The goal version the run was started under; 0 when the campaign had none. */
  goalVersion: number;
  role?: CampaignRunRole;
  agentId?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Thrown when the run tag and the ADR 0921 client stamp disagree about the client. */
export class CampaignRunWrongClientError extends Error {
  readonly code = 'wrong_client';
  constructor(readonly tagOrgId: string, readonly stampOrgId: string) {
    super('The run names two different clients.');
  }
}

/**
 * Read a run's campaign tag from its stored metadata. Null when the run is not
 * a campaign run (pre-0941 tags carried only `briefId` and are not one either).
 * Throws `CampaignRunWrongClientError` when the run also carries an ADR 0921
 * client stamp naming a different org (D2b: "the run is refused `wrong_client`").
 */
export function readCampaignRunTag(metadata: Readonly<Record<string, unknown>> | undefined): CampaignRunTag | null {
  const block = metadata?.[CAMPAIGN_RUN_TAG_KEY];
  if (!isObj(block) || !nonEmpty(block.campaignId) || !nonEmpty(block.orgId)) return null;
  const goalVersion = typeof block.goalVersion === 'number' && Number.isInteger(block.goalVersion) && block.goalVersion >= 0 ? block.goalVersion : 0;
  const role = ROLES.includes(block.role as CampaignRunRole) ? (block.role as CampaignRunRole) : undefined;
  const ops = metadata?.[CAMPAIGN_OPS_STAMP_KEY];
  if (isObj(ops) && nonEmpty(ops.orgId) && ops.orgId !== block.orgId) throw new CampaignRunWrongClientError(block.orgId, ops.orgId);
  return {
    campaignId: block.campaignId,
    orgId: block.orgId,
    ...(nonEmpty(block.briefId) ? { briefId: block.briefId } : {}),
    goalVersion,
    ...(role ? { role } : {}),
    ...(nonEmpty(block.agentId) ? { agentId: block.agentId } : {}),
  };
}

/** What the campaign owner answers about one campaign. */
export interface CampaignRef { campaignId: string; orgId: string; briefId?: string }

export interface CampaignRefResolver {
  /** The campaign, or null when it does not exist in this tenant. */
  get(tenantId: string, campaignId: string): Promise<CampaignRef | null>;
  /** The campaign made for a brief, or null (never creates one). */
  forBrief(tenantId: string, briefId: string): Promise<CampaignRef | null>;
  /** The run tag for a run about this brief's campaign, or null when the brief has no campaign. */
  runTagForBrief(tenantId: string, briefId: string, opts: { role: CampaignRunRole; agentId?: string }): Promise<CampaignRunTag | null>;
}

let resolver: CampaignRefResolver | null = null;

/** The campaign owner (`features/campaign-orchestration`) registers at boot. */
export function registerCampaignRefResolver(r: CampaignRefResolver): void {
  resolver = r;
}

function requireResolver(): CampaignRefResolver {
  if (!resolver) throw new OpenwopError('not_found', 'Campaign not found.', 404, { reason: 'campaign_not_found' });
  return resolver;
}

/**
 * Refuse a dangling or cross-org campaign id. Returns the campaign when it
 * exists in `tenantId` under `orgId`; otherwise throws a uniform 404.
 */
export async function assertCampaignRef(tenantId: string, orgId: string, campaignId: string): Promise<CampaignRef> {
  const ref = await requireResolver().get(tenantId, campaignId);
  if (!ref || ref.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Campaign not found.', 404, { reason: 'campaign_not_found', campaignId });
  }
  return ref;
}

/** The campaign a brief belongs to, or null (also null with no resolver: a
 *  provenance read, never an authorization). */
export async function campaignForBrief(tenantId: string, briefId: string): Promise<CampaignRef | null> {
  return resolver ? resolver.forBrief(tenantId, briefId) : null;
}

/** The run tag for a run about this brief, or null. */
export async function campaignRunTagForBrief(tenantId: string, briefId: string, opts: { role: CampaignRunRole; agentId?: string }): Promise<CampaignRunTag | null> {
  return resolver ? resolver.runTagForBrief(tenantId, briefId, opts) : null;
}

/**
 * The campaign a run belongs to, read from the STORED run's tag, else from the
 * brief it names (pre-0941 runs). Null when neither resolves. A wrong_client
 * run resolves to null: its owner refuses it, and a back-link must not guess.
 */
export async function campaignForRun(
  getRun: (runId: string) => Promise<{ tenantId: string; metadata?: unknown } | null | undefined>,
  tenantId: string,
  runId: string | undefined,
  briefId: string | undefined,
): Promise<CampaignRef | null> {
  if (runId) {
    const run = await getRun(runId).catch(() => null);
    if (run && run.tenantId === tenantId) {
      let tag: CampaignRunTag | null = null;
      try { tag = readCampaignRunTag(isObj(run.metadata) ? run.metadata : undefined); } catch { return null; }
      if (tag && resolver) {
        const ref = await resolver.get(tenantId, tag.campaignId);
        if (ref && ref.orgId === tag.orgId) return ref;
      }
    }
  }
  return briefId ? campaignForBrief(tenantId, briefId) : null;
}
