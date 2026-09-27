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
import { registerCampaignOrchestrationAgentTools } from './agentTools.js';
import { buildCampaignStudioSurface } from './surface.js';

export const campaignOrchestrationFeature: BackendFeature = {
  id: 'campaign-orchestration',
  registerRoutes: (deps) => {
    registerCampaignStudioRoutes(deps);
    // CFP-1 (ADR 0308 D2) — register the Campaign Strategist's real tools. The
    // run-starter deps ride the closure (a chat-time tool scope carries no
    // storage/hostSuite); the tools resolve the target brief and share the
    // routes' org-scope predicate.
    registerCampaignOrchestrationAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
  },
  surface: { id: 'campaign-orchestration', build: buildCampaignStudioSurface },
  requiredPacks: [
    { name: 'feature.campaign-orchestration.nodes', version: '1.1.2' },
    { name: 'feature.campaign-orchestration.agents', version: '1.2.0' },
  ],
  toggleDefault: {
    id: 'campaign-orchestration',
    label: 'Campaign Studio',
    description:
      'The composable campaign workflow that ties Campaign Studio together — from a confirmed brief, generate the messaging kernel, fan out the five channels, check cross-asset consistency, and finalize a marketing campaign. Driven through the one chat by the Campaign Strategist (ADR 0058). Channels run sequentially today; parallel fan-out is a planned upgrade. OFF by default.',
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
