/**
 * ADR 0948 P3a (D5) — start a funnel blueprint run for an org, a confirmed brief and
 * (optionally) a campaign. The ONE service behind both doors: the HTTP route
 * (`POST …/funnels/orgs/:orgId/generate`) and the Funnel Architect's
 * `openwop:funnels.generate` tool. Both authorize the org first (the route through
 * `authorizeOrgScope`, the tool through the same RFC 0049 check), then call this, so
 * every rule after authorization lives here once.
 *
 * Refusals are typed (`details.code`), never a quiet `dispatch_failed`:
 *   unknown_blueprint · brief_not_found (absent OR another org: a uniform not-found) ·
 *   brief_not_confirmed · campaign_mismatch · invalid_params (Ajv errors against the
 *   chain's own `parameters`; `startWorkflowRun` validates nothing) · and a run-start
 *   refusal keeps its own code (budget, plan, feature gate).
 *
 * The run is the chain-backed blueprint (deterministic id; editable copies come from
 * the gallery's from-chain). It drafts a funnel and draft pages; nothing publishes:
 * publishing is a human decision on a `funnel-publish` review (P1b).
 *
 * ADR 0941 integration: the campaign owner stamps the run before insertion,
 * so its goal, client and autonomy decisions freeze through the shared run
 * contributors. Omitting campaignId cannot unbind a brief's existing campaign.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey } from '../../host/ignitionGuard.js';
import { validateRunInputs } from '../../host/runInputValidation.js';
import { canonicalJSON } from '../../host/jcs.js';
import { getBrief } from '../campaign-brief/briefService.js';
import { getCampaign } from '../campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../campaign-orchestration/campaignRunTag.js';
import { CAMPAIGN_RUN_TAG_KEY, campaignRunTagForBrief } from '../../host/campaignRefs.js';
import { FILLED_BY_GENERATE, FUNNEL_ARCHITECT_AGENT_ID, getRunnableBlueprint, runnableBlueprints } from './blueprints.js';

export interface GenerateFunnelInput {
  tenantId: string;
  /** The person starting it (already authorized for `orgId` with workspace:write). */
  actingUserId: string;
  orgId: string;
  blueprintId: string;
  briefId: string;
  campaignId?: string;
  /** The blueprint's own params, minus the ones generate fills (orgId/briefId/campaignId). */
  params?: Record<string, unknown>;
  /** Attribution for a chat-started run. */
  chatSessionId?: string;
}

export interface GenerateFunnelResult {
  runId: string;
  blueprintId: string;
  /** False when an identical request moments ago already started this run. */
  started: boolean;
}

const refuse = (code: string, message: string, status: number, extra: Record<string, unknown> = {}): never => {
  throw new OpenwopError(status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'validation_error', message, status, { code, ...extra });
};

export async function generateFunnelFromBlueprint(deps: StartRunDeps, input: GenerateFunnelInput): Promise<GenerateFunnelResult> {
  const blueprint = getRunnableBlueprint(input.blueprintId);
  if (!blueprint) {
    refuse('unknown_blueprint', `No funnel blueprint "${input.blueprintId}" is installed.`, 404, { available: runnableBlueprints().map((b) => b.chainId) });
  }
  const brief = await getBrief(input.tenantId, input.briefId);
  // Another org's brief is the same answer as a missing one (no existence leak).
  if (!brief || brief.orgId !== input.orgId) refuse('brief_not_found', 'Brief not found in this organization.', 404);
  if (brief!.status !== 'confirmed') {
    refuse('brief_not_confirmed', `The brief is ${brief!.status}; a funnel is generated only from a confirmed brief, so it reads real product and offer data.`, 409, { status: brief!.status });
  }
  let campaignTag = await campaignRunTagForBrief(input.tenantId, input.briefId, { role: 'stage', agentId: FUNNEL_ARCHITECT_AGENT_ID });
  if (campaignTag && campaignTag.orgId !== input.orgId) refuse('campaign_mismatch', 'Campaign not found in this organization.', 404);
  if (input.campaignId) {
    const campaign = await getCampaign(input.tenantId, input.campaignId);
    if (!campaign || campaign.orgId !== input.orgId || campaign.briefId !== input.briefId) {
      refuse('campaign_mismatch', 'That campaign is not in this organization or was not made from this brief.', 404);
    }
    campaignTag = stampCampaignRun(campaign!, { role: 'stage', agentId: FUNNEL_ARCHITECT_AGENT_ID });
  }
  const campaignId = campaignTag?.campaignId;
  const userParams = { ...(input.params ?? {}) };
  for (const k of FILLED_BY_GENERATE) delete userParams[k];
  const inputs: Record<string, unknown> = {
    ...userParams,
    orgId: input.orgId,
    briefId: input.briefId,
    ...(campaignId ? { campaignId } : {}),
  };
  const errors = validateRunInputs(blueprint!.parameters, inputs);
  if (errors && errors.length > 0) {
    refuse('invalid_params', 'The blueprint parameters are invalid.', 400, { errors: errors.slice(0, 10) });
  }

  // A repeated identical request inside the window reuses the run already started.
  // Canonical (deep, key-sorted) params: an array replacer would drop nested keys and
  // collapse distinct requests onto one run (the ADR 0917 defect).
  const key = ignitionKey('funnels.generate', input.orgId, input.blueprintId, input.briefId, campaignId,
    createHash('sha256').update(canonicalJSON(userParams)).digest('hex'));
  const claim = await claimIgnition(input.tenantId, key);
  if (!claim.claimed) {
    if (claim.existingRunId) return { runId: claim.existingRunId, blueprintId: input.blueprintId, started: false };
    refuse('generate_in_progress', 'An identical funnel generation is starting — try again in a moment.', 409);
  }
  let runId: string | null;
  try {
    runId = await startWorkflowRun(deps, {
      tenantId: input.tenantId,
      workflowId: input.blueprintId,
      inputs,
      metadata: {
        actingUserId: input.actingUserId,
        ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
        funnelBlueprint: { blueprintId: input.blueprintId, orgId: input.orgId, briefId: input.briefId, ...(campaignId ? { campaignId } : {}) },
        ...(campaignTag ? { [CAMPAIGN_RUN_TAG_KEY]: campaignTag } : {}),
      },
    });
  } catch (err) {
    // A typed run-start refusal (budget, plan, feature gate) keeps its own code.
    await releaseIgnition(input.tenantId, key);
    throw err;
  }
  if (!runId) {
    await releaseIgnition(input.tenantId, key);
    refuse('dispatch_failed', 'The blueprint run could not start.', 409);
  }
  await recordIgnitionRun(input.tenantId, key, runId!);
  return { runId: runId!, blueprintId: input.blueprintId, started: true };
}
