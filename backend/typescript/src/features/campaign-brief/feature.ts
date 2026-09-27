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
import { registerCampaignBriefAgentTools } from './agentTools.js';
import { buildCampaignBriefSurface } from './surface.js';
import { onKnowledgeDocumentChanged } from '../../host/knowledgeLifecycle.js';
import { markKernelsStaleForDoc } from './briefService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';

export const campaignBriefFeature: BackendFeature = {
  id: 'campaign-brief',
  registerRoutes: (deps) => {
    registerCampaignBriefRoutes(deps);
    // CFP-1 — the Campaign Brief Strategist's chat tools: reads (get-brief,
    // validate) + the two pipeline igniters (research.run → market-intel,
    // generate-kernel → the messaging-kernel workflow), sharing the routes'
    // org-scope predicate. Before this the pack allowlisted raw node typeIds
    // that project into no conversational tool, so the Strategist was toothless
    // and the flagship kernel + market-intel pipeline had no igniter (ADR 0308
    // seam; the run-starter deps ride the closure — kicktodo-creator pattern).
    registerCampaignBriefAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
    // ADR 0351 P3 — KB-source-change → kernel staleness. A changed knowledge
    // document flags every kernel that CITES it (sourceDocIds) and notifies the
    // brief's workspace with a deep link (never a bare tab — ADR 0336).
    onKnowledgeDocumentChanged('campaign-brief', async ({ tenantId, documentId, title }) => {
      const affected = await markKernelsStaleForDoc(tenantId, documentId);
      for (const brief of affected) {
        await getNotificationEmitter().emit({
          tenantId,
          type: 'campaign.kernel-stale',
          priority: 'normal',
          title: 'Campaign kernel is out of date',
          message: `The knowledge document "${title}" changed. The messaging kernel for "${brief.name}" cites it — regenerate to stay grounded.`,
          actionUrl: `/campaign-brief?brief=${encodeURIComponent(brief.id)}`,
        });
      }
    });
  },
  surface: { id: 'campaign-brief', build: buildCampaignBriefSurface },
  requiredPacks: [
    { name: 'feature.campaign-brief.nodes', version: '1.5.0' },
    { name: 'feature.campaign-brief.agents', version: '1.3.1' },
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
