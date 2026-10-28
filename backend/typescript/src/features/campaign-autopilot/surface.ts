/**
 * `ctx.features['campaign-autopilot']` (ADR 0961 D7, D4).
 *
 * Binding rules: the campaign comes only from the calling run's stored tag
 * (ADR 0941 D2b), never from an argument, so a node cannot read or act on
 * another campaign by naming it. The run must have a person behind it (acting
 * user, or the member who caused it, ADR 0832 D3) holding `workspace:read`
 * (preflight) or `workspace:write` (starting a stage) on the campaign's client
 * org. An untagged or actorless run is refused.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { runPreflight } from './preflight.js';
import { isAutopilotStage, startStageRun, taggedCampaignOf } from './stageRun.js';

export function buildCampaignAutopilotSurface(scope: BundleScope): FeatureSurface {
  return {
    /** The preflight checklist (ADR 0961 D7). Read-only. */
    preflight: async () => ({ ...(await runPreflight(scope.tenantId, (await taggedCampaignOf(scope, 'workspace:read')).campaign)) }),
    /** Start (or resolve) a stage as its own campaign run (ADR 0961 D4). */
    startStage: async (args) => {
      const stage = str(args.stage);
      if (!isAutopilotStage(stage)) throw new OpenwopError('validation_error', `Unknown autopilot stage: ${stage}`, 400, { field: 'stage' });
      const provider = optStr(args.provider);
      const model = optStr(args.model);
      return { ...(await startStageRun(scope, { stage, ...(provider ? { provider } : {}), ...(model ? { model } : {}) })) };
    },
  };
}
