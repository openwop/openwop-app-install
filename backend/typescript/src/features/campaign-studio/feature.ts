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

export const campaignStudioFeature: BackendFeature = {
  id: 'campaign-studio',
  registerRoutes: () => { registerCampaignArtifactType(); },
  toggleDefault: {
    id: 'campaign-studio',
    label: 'Campaign Studio',
    description:
      'Design multi-channel marketing campaigns with the AI chat: the Campaign Strategist agent emits a structured campaign (channels, a funnel, and content assets) that renders inline in chat. Constrained typed JSON, never executable code. OFF by default.',
    category: 'Canvases',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-studio',
  },
  requiredPacks: [
    { name: 'feature.campaign-studio.nodes', version: '1.0.0' },
    { name: 'feature.campaign-studio.agents', version: '1.0.0' },
  ],
};
