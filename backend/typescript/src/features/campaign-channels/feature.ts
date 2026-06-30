/**
 * Campaign Studio: Channel Generation (ADR 0157). A toggle-gated feature-package —
 * the third layer of the Campaign Studio cluster (docs/campaign-studio-prd.md).
 * Ships the channel generator + content-quality nodes, the five channel child
 * workflows (Phase 2 `builtinWorkflows`), and the channel artifact types.
 *
 * Composes, never forks: generation rides ctx.callAI, grounding rides kb.rag,
 * brand compliance reuses feature.brand.nodes (ADR 0155). Drafts are recorded node
 * outputs (no parallel store) the orchestration (ADR 0158) bundles into a campaign.
 *
 * RFC gate (ADR 0157): host-extension composing accepted feature surfaces. NO new RFC.
 *
 * @see docs/adr/0157-campaign-studio-channel-generation.md
 */

import type { BackendFeature } from '../types.js';
import { CHANNEL_WORKFLOWS } from './channelWorkflows.js';

export const campaignChannelsFeature: BackendFeature = {
  id: 'campaign-channels',
  // No REST routes — the surface is the node pack + the channel workflows,
  // driven through the existing run/chat surfaces (ADR 0058).
  registerRoutes: () => { /* node/workflow surface only */ },
  builtinWorkflows: CHANNEL_WORKFLOWS,
  requiredPacks: [
    { name: 'feature.campaign-channels.nodes', version: '1.0.0' },
    { name: 'feature.campaign-channels.agents', version: '1.0.0' },
  ],
  toggleDefault: {
    id: 'campaign-channels',
    label: 'Campaign Channels',
    description:
      'Turn a campaign brief\'s messaging kernel into channel deliverables — landing page, ad variants, email sequence, creative briefs, and social posts — each grounded in your knowledge base (with citations), echoing the kernel, and scored for content quality + brand compliance. The third layer of Campaign Studio. OFF by default.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-channels',
  },
};
