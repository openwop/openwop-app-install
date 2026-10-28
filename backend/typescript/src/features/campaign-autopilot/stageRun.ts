/**
 * ADR 0961 D4 — a gated stage runs as its OWN campaign run (role `stage`).
 *
 * Why not a nested sub-chain: on this host a `core.subWorkflow` child that
 * suspends (an approval gate, a clarification) suspends its parent too, and
 * nothing resumes the parent when the child later completes
 * (`bootstrap/nodes.ts` core.subWorkflow; no child-terminal → parent-resume
 * cascade exists). The campaign spine waits on a kernel approval, so nesting it
 * would strand the autopilot run. A stage run carries the same campaign tag
 * (ADR 0941 D2b, role `stage`), so the per-campaign run index, the frozen goal
 * and the campaign's views see it as part of the campaign.
 *
 * The stage run's id is derived from (tenant, autopilot run, stage), so a retry
 * or a re-entered node resolves the SAME run instead of starting a second
 * (`startWorkflowRun({ runId })`). The node that calls this is `role:
 * side-effect`, so a replay fork serves the recorded result and starts nothing.
 */
import { createHash } from 'node:crypto';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { assertRunScopeOrg } from '../../host/accessControlService.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { OpenwopError } from '../../types.js';
import { CAMPAIGN_RUN_TAG_KEY, readCampaignRunTag, stampCampaignRun } from '../campaign-orchestration/campaignRunTag.js';
import { getCampaign } from '../campaign-orchestration/campaignService.js';
import type { MarketingCampaign } from '../campaign-orchestration/types.js';

/** The closed set of stages a v0.x autopilot starts as their own run. */
export const AUTOPILOT_STAGES = { drafts: 'campaign-studio.campaign-orchestration' } as const;
export type AutopilotStage = keyof typeof AUTOPILOT_STAGES;
export const isAutopilotStage = (v: unknown): v is AutopilotStage => typeof v === 'string' && Object.hasOwn(AUTOPILOT_STAGES, v);

let starterDeps: StartRunDeps | null = null;
/** Boot wiring (`feature.ts`): the run starter's deps (surfaces carry none). */
export function setStageRunDeps(deps: StartRunDeps): void { starterDeps = deps; }

/** Every autopilot stage run's id starts with this. */
export const STAGE_RUN_PREFIX = 'autopilot-stage-';

/** The deterministic stage-run id for one autopilot run. */
export function stageRunId(tenantId: string, autopilotRunId: string, stage: AutopilotStage): string {
  const digest = createHash('sha256').update([tenantId, autopilotRunId, stage].join('\u0000')).digest('hex').slice(0, 32);
  return `${STAGE_RUN_PREFIX}${digest}`;
}

/**
 * The calling run's campaign and person, or a typed refusal. The campaign comes
 * only from the run's stored tag; the person (acting user, else the member who
 * caused the run) must hold `need` on the campaign's client org.
 */
export async function taggedCampaignOf(scope: BundleScope, need: 'workspace:read' | 'workspace:write'): Promise<{ campaign: MarketingCampaign; person: string; metadata: Record<string, unknown> }> {
  const person = scope.actingUserId ?? scope.orgScopeSubject;
  if (!person) {
    throw new OpenwopError('forbidden_scope', 'The autopilot needs a person behind the run.', 403, { reason: 'no_acting_user' });
  }
  const run = scope.runId ? await hostExtStorage().getRun(scope.runId) : null;
  const metadata = (run && run.tenantId === scope.tenantId ? run.metadata : undefined) as Record<string, unknown> | undefined;
  const tag = readCampaignRunTag(metadata);
  if (!tag || !metadata) {
    throw new OpenwopError('forbidden_scope', 'This run is not a campaign run.', 403, { reason: 'not_campaign_run' });
  }
  const campaign = await getCampaign(scope.tenantId, tag.campaignId);
  if (!campaign || campaign.orgId !== tag.orgId) {
    throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: tag.campaignId });
  }
  await assertRunScopeOrg(scope, campaign.orgId, need);
  return { campaign, person, metadata };
}

/** Start (or resolve) the stage run for the calling autopilot run. */
export async function startStageRun(scope: BundleScope, args: { stage: AutopilotStage; provider?: string; model?: string }): Promise<{ stage: AutopilotStage; runId: string; workflowId: string }> {
  if (!starterDeps) throw new OpenwopError('internal_error', 'The autopilot stage starter is not wired.', 500, {});
  if (!scope.runId) throw new OpenwopError('forbidden_scope', 'A stage can only be started from an autopilot run.', 403, { reason: 'not_campaign_run' });
  const { campaign, metadata } = await taggedCampaignOf(scope, 'workspace:write');
  if (!campaign.briefId) throw new OpenwopError('validation_error', 'This campaign has no brief.', 422, { reason: 'brief_missing' });
  const workflowId = AUTOPILOT_STAGES[args.stage];
  const runId = await startWorkflowRun(starterDeps, {
    tenantId: scope.tenantId,
    workflowId,
    inheritFromRunId: scope.runId,
    runId: stageRunId(scope.tenantId, scope.runId, args.stage),
    inputs: { briefId: campaign.briefId, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) },
    metadata: {
      ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
      // The campaign's ONE tag writer, role `stage`, at the goal version the
      // autopilot run was tagged with (the contributor freezes that goal or none).
      [CAMPAIGN_RUN_TAG_KEY]: { ...stampCampaignRun(campaign, { role: 'stage' }), goalVersion: readCampaignRunTag(metadata)?.goalVersion ?? 0 },
    },
    ...(!scope.actingUserId && scope.orgScopeSubject ? { orgScopeSubject: scope.orgScopeSubject } : {}),
  });
  if (!runId) throw new OpenwopError('internal_error', 'The stage workflow could not start.', 502, { reason: 'dispatch_failed', workflowId });
  return { stage: args.stage, runId, workflowId };
}
