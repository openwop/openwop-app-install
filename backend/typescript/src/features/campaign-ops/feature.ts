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
import { OpenwopError } from '../../types.js';
import { registerInheritedRunMetadataKey } from '../../host/inheritedRunMetadata.js';
import { CAMPAIGN_OPS_RUN_STAMP, buildCampaignOpsSurface } from './surface.js';
import { registerCampaignOpsErasure } from './erasure.js';
import { registerClientAutonomyStamp } from './autonomyStamp.js';
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { CHANGE_REQUEST_CHAIN_ID, EXECUTE_CHAIN_ID, startChangeRequestRun, startExecutionRun } from './runLauncher.js';
import { registerChangeSetApproval, registerChangeSetExecutionStarter } from './approval.js';
import { CHANGE_SET_GRANT_KIND, CLIENT_PORTAL_TOGGLE } from './portal.js';
import { getChangeSet } from './changeSetService.js';
import { wireAgentBindingStamping } from './agentBindingContributor.js';
import { registerClientReportRoutes, CLIENT_REPORTS_TOGGLE } from './reports/routes.js';
import { ownsReportJob, reportFireGate, REPORT_JOB_PREFIX } from './reports/schedule.js';
import { registerScheduledJobFireGate } from '../../host/scheduledJobFireGates.js';
import { getChain } from '../../host/workflowChainPackLoader.js';
import { CLIENT_REPORT_CHAIN_ID } from './reports/types.js';
import { registerRunStartContributor } from '../../host/runStartContext.js';
import { registerRunContextProvider } from '../../host/runContextProviders.js';
import { registerRunClientKnowledge } from '../../host/runClientKnowledge.js';
import { clientContextProvider, clientContextRunStartContributor, clientKnowledgeForRun } from './clientContext.js';
import { setAutonomyClientResolver } from '../../host/autonomyPolicy/index.js';
import { getClient } from './clientService.js';
import { registerCampaignMcpReadTools } from './mcpTools.js';
import { registerMcpChangeRequestStarter } from './externalRead.js';
import { registerCollaborationRoutes, EXTERNAL_COLLAB_TOGGLE } from './collaboration/routes.js';
import { registerCollaborationOrgGate, registerGrantResourceKind } from '../../host/externalCollaborators.js';

export const campaignOpsFeature: BackendFeature = {
  id: CAMPAIGN_OPS_TOGGLE,
  dependsOn: ['cms'],
  registerRoutes: (deps) => {
    registerCampaignOpsErasure();
    // Children inherit client scope, never approval/hash/request execution authority.
    registerInheritedRunMetadataKey(CAMPAIGN_OPS_RUN_STAMP, (raw) => {
      const orgId = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).orgId : undefined;
      if (typeof orgId !== 'string' || !orgId.trim()) {
        throw new OpenwopError('validation_error', 'The parent campaign client stamp is invalid.', 422, { reason: 'campaign_client_unresolved' });
      }
      return { orgId };
    });
    // ADR 0942 P2b — a client-bound run (no campaign) freezes the client's policy.
    registerClientAutonomyStamp();
    // ADR 0923 — the change-request chain, SAME-ID chain-backed (the crm-ops.triage
    // precedent): the request routes launch it by this stable id, gated on the toggle.
    registerChainBackedWorkflow(CHANGE_REQUEST_CHAIN_ID, { featureId: CAMPAIGN_OPS_TOGGLE });
    registerChainBackedWorkflow(EXECUTE_CHAIN_ID, { featureId: CAMPAIGN_OPS_TOGGLE });
    // ADR 0962 P1 — the external-agent read tools on the MCP mount.
    registerCampaignMcpReadTools(CAMPAIGN_OPS_TOGGLE);
    registerMcpChangeRequestStarter((input) => startChangeRequestRun({ storage: deps.storage, hostSuite: deps.hostSuite }, input));
    // ADR 0924 — the campaign-change-set decide handler, and the run it starts.
    registerChangeSetApproval();
    registerChangeSetExecutionStarter((input) => startExecutionRun({ storage: deps.storage, hostSuite: deps.hostSuite }, input));
    // ADR 0943 D2 — freeze a client's agent bindings into its runs at start.
    wireAgentBindingStamping();
    // ADR 0944 D5 — the per-client context block: a snapshot reference stamped at
    // run start, materialized on first read, served verbatim to forks.
    registerRunStartContributor(clientContextRunStartContributor);
    registerRunContextProvider('campaign-client-context', clientContextProvider);
    registerRunClientKnowledge(clientKnowledgeForRun);
    registerCampaignOpsRoutes(deps);
    // ADR 0957 P0 — report definitions and draft client reports.
    registerClientReportRoutes(deps);
    if (getChain(CLIENT_REPORT_CHAIN_ID)) {
      registerChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID, { featureId: CLIENT_REPORTS_TOGGLE });
    }
    // ADR 0957 D2 — scheduled reports: refuse a slot when the toggles are off, the
    // client is not active, or the definition moved past the job's pinned version.
    registerScheduledJobFireGate('campaign-ops.client-reports', { owns: ownsReportJob, gate: reportFireGate, refusal: 'dispatch-error', reservedJobIdPrefix: REPORT_JOB_PREFIX,
      managedBy: { id: 'client-report', message: 'This schedule belongs to a client report. Change or pause it from the report.' } });
    // ADR 0942 D3 layer 1 — the client floor at every effect chokepoint: a preview
    // or non-active client blocks external effects. An org with no client account
    // is not an agency client, so no client floor applies to it.
    setAutonomyClientResolver(async (tenantId, orgId) => {
      const c = await getClient(tenantId, orgId);
      return c ? { mode: c.mode, status: c.status } : null;
    });
    // ADR 0958 — external collaborators. The org gate is the client account: a
    // paused or archived client refuses every collaborator use (D2, D7).
    registerCollaborationOrgGate(async (tenantId, orgId) => (await getClient(tenantId, orgId))?.status === 'active');
    // ADR 0958 P1 — the ADR 0924 client approval link decides through a grant on
    // the change set. Only the portal mints these (`system:` actor); no member
    // route, agent tool or node can. Nothing to show in "Shared with me": a
    // link-only approver has no session.
    registerGrantResourceKind(CHANGE_SET_GRANT_KIND, {
      featureId: CAMPAIGN_OPS_TOGGLE,
      actions: ['view', 'decide'],
      systemMintOnly: true,
      async exists(tenantId, orgId, id) { return (await getChangeSet(tenantId, orgId, id)) !== null; },
      async project() { return null; },
    });
    registerCollaborationRoutes(deps);
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
  // ADR 0924 D5 — the public client approver portal, gated separately so a
  // workspace can use internal approval without exposing a public surface. A
  // sub-toggle: every check also requires `campaign-ops` (`portal.portalEnabled`).
  extraToggleDefaults: [{
    id: CLIENT_PORTAL_TOGGLE,
    label: 'Client approval portal',
    description: 'Let a person at a client approve or reject a campaign change from a private link, without an account. They see only that change: the request and the before-and-after of each page or email.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-ops-client-portal-v1',
  }, {
    // ADR 0957 matrix #2 (ADR 0941 D5 sub-toggle rule) — AND-gated in code with
    // `campaign-ops`; no `dependsOn`.
    id: CLIENT_REPORTS_TOGGLE,
    label: 'Client reports',
    description: 'Reports for each client built from numbers the app already computes (KPIs, attribution, email), frozen into a snapshot with each figure\'s source. Nothing reaches a client until review and publishing ship. A sub-capability of Campaign operations. Off until a workspace opts in.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-ops-client-reports',
  }, {
    // ADR 0958 — a sub-toggle (ADR 0941 D5): AND-gated with `campaign-ops` in code.
    id: EXTERNAL_COLLAB_TOGGLE,
    label: 'External collaborators',
    description:
      'Invite vendors, freelancers and client reviewers to work on one client at a time. They sign in with their own account, never join your workspace, and see only what you grant them, until the grant expires or you revoke it. Requires Campaign operations to be on as well.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-ops-external-collab',
  }],
  recommends: ['email', 'brand'],
};
