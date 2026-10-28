/**
 * ADR 0941 D2b — the campaign run tag, the per-campaign run index and the
 * frozen goal.
 *
 * - **Run tag.** `campaignOrchestration = {campaignId, orgId, briefId?,
 *   goalVersion, role?, agentId?}` on `run.metadata`. It is in
 *   `CAMPAIGN_ATTRIBUTION_KEYS` (`host/runDispatch.ts`), so a caller can never
 *   supply it; only `stampCampaignRun` composes it, `:fork` copies it verbatim
 *   and a sub-workflow child inherits it (`host/inheritedRunMetadata.ts`).
 *   Every campaign-scoped read trusts ONLY this tag (`readCampaignRunTag`),
 *   never a `campaignId` argument.
 * - **Run index.** `campaign-orchestration:run-index`, keyed
 *   `tenant::campaignId::startedAt::runId`, written by a post-insert hook
 *   (`registerRunInsertedHook`) so fresh starts, forks and children all land in
 *   it. A point-lookup prefix, never a tenant scan. Cleared with the campaign.
 * - **Frozen goal.** A run-start contributor copies the tagged campaign's goal
 *   into the reserved `run.metadata.campaignGoal`, only when the goal's version
 *   still equals the tag's `goalVersion`, and never on a `:fork` copy.
 *
 * @see docs/adr/0941-campaign-studio-program-and-canonical-campaign.md
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerRunInsertedHook } from '../../host/runInsert.js';
import { registerRunStartContributor } from '../../host/runStartContext.js';
import { registerInheritedRunMetadataKey } from '../../host/inheritedRunMetadata.js';
import { onCampaignDeleted } from '../../host/campaignLifecycle.js';
import { CAMPAIGN_RUN_TAG_KEY, readCampaignRunTag, registerCampaignRefResolver } from '../../host/campaignRefs.js';
import { createLogger } from '../../observability/logger.js';
import type { RunRecord } from '../../types.js';
import { getCampaign, getCampaignByBrief } from './campaignService.js';
import type { CampaignRunIndexRow, CampaignRunRole, CampaignRunTag, MarketingCampaign } from './types.js';

const log = createLogger('campaign-orchestration.run-tag');

/** The reserved run-metadata key holding the goal frozen at run start. */
export const CAMPAIGN_GOAL_KEY = 'campaignGoal';

// The tag key and its reader live in host (`host/campaignRefs.ts`), beside the
// key's caller-strip list, so core modules can read the tag. Re-exported here.
export { CAMPAIGN_RUN_TAG_KEY, CampaignRunWrongClientError, readCampaignRunTag } from '../../host/campaignRefs.js';

const runIndex = new DurableCollection<CampaignRunIndexRow>(
  'campaign-orchestration:run-index',
  (r) => `${r.tenantId}::${r.campaignId}::${r.startedAt}::${r.runId}`,
  undefined,
  (r) => r.tenantId,
);

/** Compose the run tag for a campaign. The ONE writer of the block. */
export function stampCampaignRun(campaign: MarketingCampaign, opts: { role: CampaignRunRole; agentId?: string }): CampaignRunTag {
  return {
    campaignId: campaign.id,
    orgId: campaign.orgId,
    ...(campaign.briefId ? { briefId: campaign.briefId } : {}),
    goalVersion: campaign.goal?.version ?? 0,
    role: opts.role,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  };
}

/** The tag, or null on a malformed / mismatched one (the index and the goal
 *  contributor skip such a run; the readers that act on it refuse). */
function safeTag(metadata: Readonly<Record<string, unknown>> | undefined): CampaignRunTag | null {
  try {
    return readCampaignRunTag(metadata);
  } catch (err) {
    log.warn('campaign_run_tag_wrong_client', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The tagged campaign, only when it exists in the run's tenant under the tag's org. */
async function taggedCampaign(tenantId: string, tag: CampaignRunTag): Promise<MarketingCampaign | null> {
  const campaign = await getCampaign(tenantId, tag.campaignId);
  return campaign && campaign.orgId === tag.orgId ? campaign : null;
}

/** Post-insert hook: index a campaign run. Idempotent (`putIfAbsent`). */
export async function indexCampaignRun(run: Readonly<RunRecord>, ctx: { derivedFromRun: boolean }): Promise<void> {
  const metadata = run.metadata as Record<string, unknown> | undefined;
  const tag = safeTag(metadata);
  if (!tag) return;
  if (!(await taggedCampaign(run.tenantId, tag))) {
    log.warn('campaign_run_tag_dangling', { runId: run.runId, campaignId: tag.campaignId });
    return;
  }
  const parent = typeof run.parentRunId === 'string' && run.parentRunId ? run.parentRunId : undefined;
  await runIndex.putIfAbsent({
    tenantId: run.tenantId,
    campaignId: tag.campaignId,
    orgId: tag.orgId,
    runId: run.runId,
    workflowId: run.workflowId,
    startedAt: run.createdAt,
    ...(tag.role ? { role: tag.role } : {}),
    // A copied blob (`:fork`, redrive) names its source; a fresh child names its parent.
    ...(parent && ctx.derivedFromRun ? { forkOf: parent } : {}),
    ...(parent && !ctx.derivedFromRun ? { parentRunId: parent } : {}),
  });
}

/** The campaign's runs, newest first. A prefix read on one campaign. */
export async function listCampaignRuns(tenantId: string, campaignId: string): Promise<CampaignRunIndexRow[]> {
  const rows = await runIndex.listByPrefix(`${tenantId}::${campaignId}::`);
  return rows
    .filter((r) => r.tenantId === tenantId && r.campaignId === campaignId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
}

/**
 * Run-start contributor: freeze the campaign's goal. Pure read. Contributes
 * nothing on a `:fork` copy (the copied blob is authoritative, present or
 * absent — ADR 0604), nothing when the run is not a campaign run, and nothing
 * when the goal has moved past the version the tag was stamped with (the run
 * is then held to no goal rather than to one it was not started under).
 */
export async function campaignGoalContributor(ctx: { tenantId: string; derivedFromRun?: boolean; metadata?: Readonly<Record<string, unknown>> }): Promise<Record<string, unknown>> {
  if (ctx.derivedFromRun) return {};
  const tag = safeTag(ctx.metadata);
  if (!tag || tag.goalVersion === 0) return {};
  const campaign = await taggedCampaign(ctx.tenantId, tag);
  const goal = campaign?.goal;
  if (!goal) return {};
  if (goal.version !== tag.goalVersion) {
    log.warn('campaign_goal_version_moved', { campaignId: tag.campaignId, tagged: tag.goalVersion, current: goal.version });
    return {};
  }
  return { [CAMPAIGN_GOAL_KEY]: structuredClone(goal) };
}

/** Boot wiring (`feature.ts`). Keyed / idempotent where the seam allows. */
let contributorRegistered = false;
export function registerCampaignRunTagHooks(): void {
  // ADR 0941 P2 — the campaign reference seam the child-record owners call.
  registerCampaignRefResolver({
    get: async (tenantId, campaignId) => {
      const c = await getCampaign(tenantId, campaignId);
      return c ? { campaignId: c.id, orgId: c.orgId, ...(c.briefId ? { briefId: c.briefId } : {}) } : null;
    },
    forBrief: async (tenantId, briefId) => {
      const c = await getCampaignByBrief(tenantId, briefId);
      return c ? { campaignId: c.id, orgId: c.orgId, briefId } : null;
    },
    runTagForBrief: async (tenantId, briefId, opts) => {
      const c = await getCampaignByBrief(tenantId, briefId);
      return c ? stampCampaignRun(c, opts) : null;
    },
  });
  registerRunInsertedHook('campaign-orchestration.run-index', indexCampaignRun);
  registerInheritedRunMetadataKey(CAMPAIGN_RUN_TAG_KEY);
  registerInheritedRunMetadataKey(CAMPAIGN_GOAL_KEY);
  if (!contributorRegistered) {
    // The contributor registry is append-only (no key), so register once per process.
    registerRunStartContributor(campaignGoalContributor);
    contributorRegistered = true;
  }
  onCampaignDeleted('campaign-run-index', async ({ tenantId, campaignId }) => {
    for (const row of await runIndex.listByPrefix(`${tenantId}::${campaignId}::`)) {
      if (row.tenantId === tenantId && row.campaignId === campaignId) {
        await runIndex.delete(`${row.tenantId}::${row.campaignId}::${row.startedAt}::${row.runId}`);
      }
    }
  });
}
