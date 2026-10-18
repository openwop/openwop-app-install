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
import { campaignOrchestrationParallel } from './orchestrationWorkflow.js';
import { registerWorkflowsFeature } from '../../host/workflowFeatureGate.js';
import { registerCampaignStudioRoutes } from './routes.js';
import { registerCampaignProjectHooks } from './campaignProject.js';
import { registerCampaignOrchestrationAgentTools } from './agentTools.js';
import { buildCampaignStudioSurface } from './surface.js';
import { registerFeatureDataExporter } from '../../host/featureDataExport.js';
import { exportCampaignOrchestrationData } from './dataExport.js';

export const campaignOrchestrationFeature: BackendFeature = {
  id: 'campaign-orchestration',
  // ADR 0852 D1 — a campaign's board, chat and team ledger live on its linked project.
  dependsOn: ['projects'],
  registerRoutes: (deps) => {
    registerFeatureDataExporter('campaign-orchestration', exportCampaignOrchestrationData); // ADR 0820 §7 — read-only export, served after a plan lapse
    // ADR 0820 §7 / G6 — this feature OWNS its chain-backed workflows (registered
    // in `features/index.ts`): every launch resolves 'campaign-orchestration' (toggle + plan).
    registerWorkflowsFeature([campaignOrchestrationParallel].map((w) => w.workflowId), 'campaign-orchestration');
    registerCampaignStudioRoutes(deps);
    // ADR 0852 — campaign delete ⇒ archive its project; campaign runs bind to that project.
    registerCampaignProjectHooks();
    // CFP-1 (ADR 0308 D2) — register the Campaign Strategist's real tools. The
    // run-starter deps ride the closure (a chat-time tool scope carries no
    // storage/hostSuite); the tools resolve the target brief and share the
    // routes' org-scope predicate.
    registerCampaignOrchestrationAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
  },
  surface: { id: 'campaign-orchestration', build: buildCampaignStudioSurface },
  requiredPacks: [
    { name: 'feature.campaign-orchestration.nodes', version: '1.2.0' },
    { name: 'vendor.openwop-app.campaign-orchestration.agents', version: '1.2.1' },
  ],
  toggleDefault: {
    id: 'campaign-orchestration',
    label: 'Campaign Studio',
    description:
      'The composable campaign workflow that ties Campaign Studio together — from a confirmed brief, generate the messaging kernel, fan out the five channels, check cross-asset consistency, and finalize a marketing campaign. Driven through the one chat by the Campaign Strategist. Channels run sequentially today; parallel fan-out is a planned upgrade.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-orchestration',
  },
  // ADR 0200 Phase 1 — SOFT deps (advisory, never a lock): the orchestration ties
  // the Campaign Studio chain together, composing the brief (getBrief) + the channel
  // workflows. Both are toggle-decoupled (services/workflows resolve regardless of
  // the sub-toggle — the imports bypass it), so orchestration DEGRADES rather than
  // orphans without them; the console suggests enabling them to complete the chain.
  recommends: ['campaign-brief', 'campaign-channels'],
};
