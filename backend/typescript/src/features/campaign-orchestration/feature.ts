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
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { registerCampaignStudioRoutes } from './routes.js';
import { registerCampaignProjectHooks } from './campaignProject.js';
import { registerCampaignRunTagHooks } from './campaignRunTag.js';
import { registerCampaignLinkHooks } from './campaignLinks.js';
import { registerCampaignOrchestrationAgentTools } from './agentTools.js';
import { buildCampaignStudioSurface } from './surface.js';
import { registerFeatureDataExporter } from '../../host/featureDataExport.js';
import { exportCampaignOrchestrationData } from './dataExport.js';
import { onCampaignDeleted } from '../../host/campaignLifecycle.js';
import { registerCampaignAutonomyStamp, autonomyTogglesOn } from './autonomyStamp.js';
import { getCampaign, listCampaigns } from './campaignService.js';
import {
  DIGEST_CHAIN_ID, registerAutonomySpendEligibility, setApprovalResumeDeps, setAutonomyCampaignStatusResolver, setAutonomyToggleResolver,
} from '../../host/autonomyPolicy/index.js';
import { AUTONOMY_TOGGLE, deleteCampaignBinding } from '../../host/autonomyPolicy/index.js';
import { registerGrantResourceKind } from '../../host/externalCollaborators.js';

import { registerCreativeReviewApproval } from '../../host/creativePublishGate.js';
import { isCreativeReviewApproved } from './creativeReview.js';
import { registerVariantSetRoutes, VARIANT_FACTORY_TOGGLE } from './variants/routes.js';
import { deleteVariantSetsForCampaign } from './variants/variantSetService.js';
import { registerVariantSetErasure } from './variants/erasure.js';

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
    // ADR 0945 × 0942 — the publish gate's "did a person approve this asset at this verdict?"
    registerCreativeReviewApproval(isCreativeReviewApproved);
    // ADR 0946 P0 — VariantSets (versioned creative rounds) under each campaign;
    // a deleted campaign takes its sets with it.
    registerVariantSetRoutes(deps);
    registerVariantSetErasure();
    onCampaignDeleted('campaign-orchestration.variant-sets', async (e) => { await deleteVariantSetsForCampaign(e.tenantId, e.campaignId); });
    // ADR 0852 — campaign delete ⇒ archive its project; campaign runs bind to that project.
    registerCampaignProjectHooks();
    // ADR 0941 D2b — the run index (post-insert hook), the frozen goal
    // (run-start contributor) and child inheritance of the run tag.
    registerCampaignRunTagHooks();
    // ADR 0941 D3 — a deleted catalog product detaches and flags the campaign.
    registerCampaignLinkHooks();
    // ADR 0942 D4 — freeze the campaign's autonomy policy into each campaign run;
    // children inherit it, forks copy it, branch forks and redrives are attended.
    registerCampaignAutonomyStamp();
    // Lifecycle cleanup keeps immutable policy history, removing only this binding.
    onCampaignDeleted('autonomy-binding', async ({ tenantId, orgId, campaignId }) => {
      await deleteCampaignBinding(tenantId, orgId, campaignId);
    });
    // ADR 0942 D3 layer 5 + the toggle, for the host effect chokepoints (seams:
    // the host never imports this feature).
    setAutonomyCampaignStatusResolver(async (tenantId, campaignId) => (await getCampaign(tenantId, campaignId))?.status ?? null);
    setAutonomyToggleResolver(autonomyTogglesOn);
    // ADR 0942 D5 — the PendingApproval lane: decide-time eligibility for
    // autonomy-gated spend rows, and the deps that resume runs waiting on them.
    registerAutonomySpendEligibility(deps.storage);
    // ADR 0942 D7 — the per-tenant daily digest is a CHAIN (chain-backed, same id),
    // run by a host-owned schedule the policy save registers; gated on this feature.
    registerChainBackedWorkflow(DIGEST_CHAIN_ID, { featureId: 'campaign-orchestration' });
    setApprovalResumeDeps({ storage: deps.storage, hostSuite: deps.hostSuite });
    // CFP-1 (ADR 0308 D2) — register the Campaign Strategist's real tools. The
    // run-starter deps ride the closure (a chat-time tool scope carries no
    // storage/hostSuite); the tools resolve the target brief and share the
    // routes' org-scope predicate.
    registerCampaignOrchestrationAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
    // ADR 0958 P2 — a collaborator can be granted a view of one campaign. The
    // projection is the working brief a vendor needs (name, objective, channels,
    // status), never the budget, the kernel or the asset list. P3 adds `upload`:
    // files sent through the grant land as inert intake (campaign-ops) until an
    // agency member accepts them.
    registerGrantResourceKind('campaign', {
      featureId: 'campaign-orchestration',
      actions: ['view', 'upload'],
      async exists(tenantId, orgId, id) { return (await getCampaign(tenantId, id))?.orgId === orgId; },
      async project(tenantId, orgId, id) {
        const c = await getCampaign(tenantId, id);
        if (!c || c.orgId !== orgId || c.status === 'archived') return null;
        return { title: c.name, body: { kind: 'campaign', objective: c.objective, channels: [...c.channels], status: c.status } };
      },
      async list(tenantId, orgId) {
        return (await listCampaigns(tenantId, orgId))
          .filter((c) => c.orgId === orgId && c.status !== 'archived')
          .map((c) => ({ id: c.id, title: c.name }));
      },
    });
  },
  // ADR 0942 — per-campaign HITL (the ADR 0941 D5 sub-toggle rule: no dependsOn;
  // consumers AND-gate the parent in code). OFF ⇒ no policy routes, no run stamp.
  extraToggleDefaults: [{
    id: AUTONOMY_TOGGLE,
    label: 'Campaign autonomy policy',
    description: 'Each campaign says how much human review it needs: for every kind of action (publish a page, launch ads, change a budget, send email, post to social, and more) the step runs automatically, notifies after, waits for a named approver, or is blocked, tightened by spend, audience and content-risk thresholds. Clients default to Guarded. Never looser than workspace governance or an agent\'s own rules. A sub-capability of Campaign Studio orchestration.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-orchestration-autonomy',
  }, {
    // ADR 0946 — AND-gated with orchestration and creative-briefs; no lock.
    id: VARIANT_FACTORY_TOGGLE,
    label: 'Creative variant factory',
    description: 'Versioned variant sets for a campaign: concepts first, then copy, images, video, email and landing members per concept and channel. Each change makes a new version with its own hash, so a review or an experiment names exactly what it covered. A sub-capability of Campaign Studio that also needs Creative briefs. Off until a workspace opts in.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-orchestration-variant-factory',
  }],
  // The writes a run makes on a campaign need the bar their routes set; reads
  // stay at membership. Rows named by id are scoped inside the surface.
  surface: { id: 'campaign-orchestration', build: buildCampaignStudioSurface, orgPolicy: { methodScopes: { finalizeFromBrief: 'workspace:write', attachAssets: 'workspace:write' } } },
  requiredPacks: [
    'feature.campaign-orchestration.nodes',
    'vendor.openwop-app.campaign-orchestration.agents',
  ],
  toggleDefault: {
    id: 'campaign-orchestration',
    // ADR 0941 D5 — "Campaign Studio" is the console (`campaigns`); this toggle is
    // its orchestration engine. Display label only; the id is unchanged.
    label: 'Campaign Studio — orchestration',
    description:
      'The composable campaign workflow that ties Campaign Studio together — from a confirmed brief, generate the messaging kernel, fan out the five channels, check cross-asset consistency, and finalize a marketing campaign. Driven through the one chat by the Campaign Strategist. The channels are drafted in parallel.',
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
