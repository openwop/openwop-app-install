/**
 * Campaign autopilot (ADR 0961) — a brief becomes a running campaign as one
 * visible workflow of stage sub-chains. P0: the package, the toggle, the launch
 * and preflight routes, the preflight surface, and the chain-backed spine
 * `campaign-studio.autopilot` (preflight → start the drafting stage: the existing
 * campaign spine as its own campaign run, drafts only, no external effect).
 * Host extension, no RFC, nothing advertised.
 *
 * @see docs/adr/0961-brief-to-launch-autopilot.md
 */
import type { BackendFeature } from '../types.js';
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { AUTOPILOT_CHAIN_ID, AUTOPILOT_TOGGLE } from './ids.js';
import { setStageRunDeps } from './stageRun.js';
import { registerCampaignAutopilotRoutes } from './routes.js';
import { buildCampaignAutopilotSurface } from './surface.js';

export const campaignAutopilotFeature: BackendFeature = {
  id: AUTOPILOT_TOGGLE,
  // `projects` (the campaign board, ADR 0961 D6) joins when P3's card stage imports it.
  dependsOn: ['campaign-orchestration', 'campaign-brief'],
  registerRoutes: (deps) => {
    registerChainBackedWorkflow(AUTOPILOT_CHAIN_ID, { featureId: AUTOPILOT_TOGGLE });
    setStageRunDeps({ storage: deps.storage, hostSuite: deps.hostSuite });
    registerCampaignAutopilotRoutes(deps);
  },
  surface: { id: AUTOPILOT_TOGGLE, build: buildCampaignAutopilotSurface },
  requiredPacks: ['feature.campaign-autopilot.nodes'],
  toggleDefault: {
    id: AUTOPILOT_TOGGLE,
    label: 'Campaign autopilot',
    description:
      'Turn a brief into a running campaign as one visible workflow. A preflight checks what the campaign still needs, then the campaign is drafted stage by stage, with as much human review as you choose.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-autopilot',
  },
};
