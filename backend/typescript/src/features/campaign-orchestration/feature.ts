/**
 * Campaign Studio: Composable Orchestration (ADR 0158). The feature that ties the
 * Campaign Studio cluster together — the MarketingCampaign container + the
 * post-generation pipeline nodes (consistency-check, finalize). Phase 2 adds the
 * parent orchestration workflow (sequential 5-channel `core.subWorkflow` spine;
 * parallel is the RFC 0118 flip) + the Campaign Strategist agent.
 *
 * RFC gate (ADR 0158): RFC 0118 for the P1.5 PARALLEL upgrade only — sequential
 * fan-out ships now on the Accepted spec. Everything else rides Accepted RFCs.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */

import type { BackendFeature } from '../types.js';
import { registerCampaignStudioRoutes } from './routes.js';
import { buildCampaignStudioSurface } from './surface.js';
import { CAMPAIGN_ORCHESTRATION } from './orchestrationWorkflow.js';

export const campaignOrchestrationFeature: BackendFeature = {
  id: 'campaign-orchestration',
  registerRoutes: (deps) => registerCampaignStudioRoutes(deps),
  surface: { id: 'campaign-orchestration', build: buildCampaignStudioSurface },
  builtinWorkflows: CAMPAIGN_ORCHESTRATION,
  requiredPacks: [
    { name: 'feature.campaign-orchestration.nodes', version: '1.0.0' },
    { name: 'feature.campaign-orchestration.agents', version: '1.0.0' },
  ],
  toggleDefault: {
    id: 'campaign-orchestration',
    label: 'Campaign Studio',
    description:
      'The composable campaign workflow that ties Campaign Studio together — from a confirmed brief, generate the messaging kernel, fan out the five channels, check cross-asset consistency, and finalize a marketing campaign. Driven through the one chat by the Campaign Strategist (ADR 0058). Channels run sequentially today; parallel fan-out is the RFC 0118 upgrade. OFF by default.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-orchestration',
  },
};
