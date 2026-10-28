/**
 * ADR 0961 P0 — launch the autopilot for one campaign.
 *
 * The campaign must already exist (ADR 0941 D2); launch never creates one. The
 * run is tagged by the ONE tag writer (`stampCampaignRun`, role `spine`), and the
 * goal is frozen by ADR 0941's run-start contributor, never here. A repeated
 * launch reuses the run already started: inside the ignition window by the
 * claim, and later while that spine is still live (running or waiting on a gate).
 *
 * Until ADR 0959 ships installations, a launch starts the chain-backed
 * `campaign-studio.autopilot` workflow directly and carries no playbook stamp.
 */
import { isTerminalRunStatus } from '@openwop/openwop';
import { claimIgnition, ignitionKey, recordIgnitionRun, releaseIgnition } from '../../host/ignitionGuard.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { createLogger } from '../../observability/logger.js';
import { OpenwopError } from '../../types.js';
import { CAMPAIGN_RUN_TAG_KEY, listCampaignRuns, stampCampaignRun } from '../campaign-orchestration/campaignRunTag.js';
import type { MarketingCampaign } from '../campaign-orchestration/types.js';
import { AUTOPILOT_CHAIN_ID } from './ids.js';
import { STAGE_RUN_PREFIX } from './stageRun.js';

const log = createLogger('campaign-autopilot.launch');

/** The campaign's live autopilot run, if one is still running or waiting: the
 *  spine itself, or a stage run it started (a drafting stage waits on review
 *  gates for days after the spine has completed). A prefix read on ONE
 *  campaign's run index (never a tenant scan), then one run read per candidate. */
async function liveAutopilotRun(deps: StartRunDeps, tenantId: string, campaignId: string): Promise<string | null> {
  for (const row of await listCampaignRuns(tenantId, campaignId)) {
    if (row.parentRunId || row.forkOf) continue;
    const isSpine = row.workflowId === AUTOPILOT_CHAIN_ID && row.role === 'spine';
    const isStage = row.role === 'stage' && row.runId.startsWith(STAGE_RUN_PREFIX);
    if (!isSpine && !isStage) continue;
    const run = await deps.storage.getRun(row.runId);
    if (run && run.tenantId === tenantId && !isTerminalRunStatus(run.status)) return row.runId;
  }
  return null;
}

export interface LaunchResult { runId: string; campaignId: string; reused: boolean }

export async function launchAutopilot(
  deps: StartRunDeps,
  input: { tenantId: string; campaign: MarketingCampaign; actingUserId: string },
): Promise<LaunchResult> {
  const { tenantId, campaign, actingUserId } = input;
  if (!campaign.briefId) {
    throw new OpenwopError('validation_error', 'This campaign has no brief, so the autopilot has nothing to work from.', 422, { reason: 'brief_missing' });
  }
  const key = ignitionKey('campaign-autopilot.launch', campaign.id);
  const claim = await claimIgnition(tenantId, key);
  if (!claim.claimed) {
    if (claim.existingRunId) return { runId: claim.existingRunId, campaignId: campaign.id, reused: true };
    throw new OpenwopError('conflict', 'This campaign is being launched already.', 409, { reason: 'launch_in_progress' });
  }
  // The ignition window is minutes; a spine waits on review gates for days. A
  // campaign has at most one live autopilot (spine or stage): a later launch joins it.
  const live = await liveAutopilotRun(deps, tenantId, campaign.id);
  if (live) {
    await recordIgnitionRun(tenantId, key, live);
    return { runId: live, campaignId: campaign.id, reused: true };
  }
  const runId = await startWorkflowRun(deps, {
    tenantId,
    workflowId: AUTOPILOT_CHAIN_ID,
    // No inputs: every autopilot node reads the campaign (and its brief) from the tag.
    inputs: {},
    metadata: {
      actingUserId,
      // ADR 0941 D2b — the run tag, composed by its one writer.
      [CAMPAIGN_RUN_TAG_KEY]: stampCampaignRun(campaign, { role: 'spine' }),
    },
  }).catch((err: unknown) => {
    log.warn('campaign_autopilot_dispatch_threw', { tenantId, campaignId: campaign.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!runId) {
    // Nothing started: release the claim so an honest retry is not latched shut.
    await releaseIgnition(tenantId, key);
    throw new OpenwopError('internal_error', 'The autopilot workflow could not start.', 502, { reason: 'dispatch_failed' });
  }
  await recordIgnitionRun(tenantId, key, runId);
  log.info('campaign_autopilot_launched', { tenantId, campaignId: campaign.id, runId });
  return { runId, campaignId: campaign.id, reused: false };
}
