/**
 * Campaign ops — agency campaign operations in the Campaign Studio family
 * (ADRs 0921–0928). An agency is a `ws:` workspace, each client an org; an
 * operator describes a change, a hashed change set is approved, written one
 * destination at a time and confirmed by reading the destination back.
 *
 * P0 here (ADR 0921 + ADR 0922): client accounts, the asset registry, the CMS
 * page destination adapter and the client-bound workflow surface. Host
 * extension, no RFC, nothing advertised.
 *
 * @see docs/adr/0921-campaign-ops-agency-client-accounts.md
 * @see docs/adr/0922-campaign-ops-asset-registry-and-destinations.md
 */
import type { BackendFeature } from '../types.js';
import { registerCampaignOpsRoutes, CAMPAIGN_OPS_TOGGLE } from './routes.js';
import { buildCampaignOpsSurface } from './surface.js';
import { registerCampaignOpsErasure } from './erasure.js';
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { CHANGE_REQUEST_CHAIN_ID, EXECUTE_CHAIN_ID, startExecutionRun } from './runLauncher.js';
import { registerChangeSetApproval, registerChangeSetExecutionStarter } from './approval.js';

export const campaignOpsFeature: BackendFeature = {
  id: CAMPAIGN_OPS_TOGGLE,
  dependsOn: ['cms'],
  registerRoutes: (deps) => {
    registerCampaignOpsErasure();
    // ADR 0923 — the change-request chain, SAME-ID chain-backed (the crm-ops.triage
    // precedent): the request routes launch it by this stable id, gated on the toggle.
    registerChainBackedWorkflow(CHANGE_REQUEST_CHAIN_ID, { featureId: CAMPAIGN_OPS_TOGGLE });
    registerChainBackedWorkflow(EXECUTE_CHAIN_ID, { featureId: CAMPAIGN_OPS_TOGGLE });
    // ADR 0924 — the campaign-change-set decide handler, and the run it starts.
    registerChangeSetApproval();
    registerChangeSetExecutionStarter((input) => startExecutionRun({ storage: deps.storage, hostSuite: deps.hostSuite }, input));
    registerCampaignOpsRoutes(deps);
  },
  surface: { id: CAMPAIGN_OPS_TOGGLE, build: buildCampaignOpsSurface },
  requiredPacks: ['feature.campaign-ops.nodes'],
  toggleDefault: {
    id: CAMPAIGN_OPS_TOGGLE,
    label: 'Campaign operations',
    description:
      'Make client-approved campaign changes and see which ones were verified. An operator describes a change, reviews the proposed edits per page and email, gets the approval, and each destination is checked after it is written. Built for agencies: each client is an organization, kept separate from every other client.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-ops',
  },
  recommends: ['email', 'brand'],
};
