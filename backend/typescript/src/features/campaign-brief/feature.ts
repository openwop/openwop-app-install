/**
 * Personas & Campaign Brief (ADR 0156). A toggle-gated feature-package — the
 * second layer of the Campaign Studio cluster (docs/campaign-studio-prd.md).
 * Owns the `Persona` (content-targeting archetype, distinct from a CRM contact)
 * and `CampaignBrief` entities, the brief context assembler, and the messaging
 * kernel generator (Phase 3 packs + `ctx.features['campaign-brief']` surface).
 *
 * RFC gate (ADR 0156): host-extension under /v1/host/openwop-app/campaign-brief/*,
 * composing accepted feature surfaces (brand · kb · crm). NO new RFC.
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

import type { BackendFeature } from '../types.js';
import { registerCampaignBriefRoutes } from './routes.js';
import { buildCampaignBriefSurface } from './surface.js';

export const campaignBriefFeature: BackendFeature = {
  id: 'campaign-brief',
  registerRoutes: (deps) => registerCampaignBriefRoutes(deps),
  surface: { id: 'campaign-brief', build: buildCampaignBriefSurface },
  requiredPacks: [
    { name: 'feature.campaign-brief.nodes', version: '1.0.0' },
    { name: 'feature.campaign-brief.agents', version: '1.0.0' },
  ],
  toggleDefault: {
    id: 'campaign-brief',
    label: 'Personas & Campaign Brief',
    description:
      'Define marketing personas (buyer stage, pain points, objections) and campaign briefs that gather product, persona, brand, and channels into one workspace — then generate the messaging kernel, the shared strategic foundation every channel echoes, grounded in your knowledge base with citations. The second layer of Campaign Studio. OFF by default.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-brief',
  },
};
