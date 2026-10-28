/**
 * Campaign-studio canvas (ADR 0153 Phase 3). The Campaign Strategist agent or a run
 * emits a structured `canvas.campaign` (channels + funnel + assets) that renders inline
 * in the chat artifact workbench — no new surface. Toggle `campaign-studio`, OFF by
 * default, per-tenant.
 *
 * @see docs/adr/0153-canvas-projects-program.md
 */
import type { BackendFeature } from '../types.js';
import { registerCampaignArtifactType } from './artifactTypes.js';
import { registerCampaignStudioEditorRoutes } from './routes.js';
import { registerCampaignStudioAgentTools } from './agentTools.js';
import { registerPlanLinkHooks } from './planLinks.js';

export const campaignStudioFeature: BackendFeature = {
  id: 'campaign-studio',
  registerRoutes: (deps) => {
    registerCampaignArtifactType();
    registerCampaignStudioEditorRoutes(deps);
    // ADR 0941 P2 — canvas or campaign delete clears a plan's campaign link.
    registerPlanLinkHooks();
    // CFP-1 (chat-first port E1) — the Campaign Strategist's real get-design +
    // render tools (the ADR 0308 D2 feature-registered-builtin seam). Inert
    // until the agent allowlists the ids; per-tenant toggle honesty lives inside
    // each tool's run().
    registerCampaignStudioAgentTools();
  },
  // ONE toggle per canvas type (ADR 0319): generation + the full-screen editor +
  // creation are a single feature, not two (the former `campaign-studio-editor` split is retired).
  toggleDefault: {
    id: 'campaign-studio',
    // ADR 0941 D5 — the canvas is a campaign's PLAN document; "Campaign Studio" is
    // the console. Display label only; the id is unchanged.
    label: 'Campaign plans (canvas)',
    description:
      'Multi-channel marketing campaigns — design them with the AI chat (the Campaign Strategist agent emits a structured campaign inline in chat) AND create/edit them full-screen: channels, funnel stages, and content assets as editable lists plus doc-level objective/audience, with undo/redo and version history. Constrained typed JSON, never executable code.',
    category: 'Documents',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'campaign-studio',
  },
  requiredPacks: [
    'feature.campaign-studio.nodes',
    'vendor.openwop-app.campaign-studio.agents',
  ],
};
