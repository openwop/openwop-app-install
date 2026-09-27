/**
 * ADR 0539 — the job-search vertical.
 *
 * A vertical application over primitives this host already owns. The boundaries
 * audit in the ADR is the whole decision: the application pipeline is CRM's
 * `Deal`, the inbox is CRM's `gmailSyncService`, the browser is `computer-use`,
 * the ranking is `host/weightedScoring.ts`, the autonomous loop is the heartbeat
 * daemon + kanban + ADR 0534/0535. This package owns only what is genuinely new
 * — the job-search DOMAIN — and composes the rest.
 *
 * ONE package, ONE toggle, ONE sellable bundle (D0). The six concerns stay
 * separated in code as internal modules without being separately gated or
 * separately purchasable.
 *
 * Default OFF and bucketed per TENANT: the vertical is sold per workspace
 * (ADR 0419 bundles grant per-tenant, unlimited seats), so a per-user bucket
 * would let one member of a paying workspace see it and another not. The
 * stricter per-SUBJECT rules — an admin must never read an employee's salary
 * expectation or disability disclosure (ADR 0545) — are in-feature authorization,
 * deliberately NOT expressed as a toggle bucket.
 *
 * `computer-use` is deliberately NOT in `dependsOn`: without it the chains
 * degrade to manual-entry applications rather than failing (ADR 0543 matrix
 * row 2), and a disable-lock would misrepresent that as breaking.
 *
 * @see docs/adr/0539-job-search-vertical-strategy.md
 */
import type { BackendFeature } from '../types.js';
import { JOB_SEARCH_TOGGLE, JOB_SEARCH_LABEL } from './service.js';
import { registerJobSearchRoutes, registerPublicAttestationRoutes } from './routes.js';
import { registerAnswerBankRoutes } from './autopilot/routes.js';
import { registerJobSearchAgentTools } from './agentTools.js';
import { buildJobSearchSurface } from './surface.js';
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { CAREER_CAMPAIGN_CARD_WORKFLOW_ID } from './agent/provision.js';
import { registerJobSearchCrmCascade } from './lifecycle/crmCascade.js';

export const jobSearchFeature: BackendFeature = {
  id: JOB_SEARCH_TOGGLE,
  registerRoutes: (deps) => {
    registerJobSearchAgentTools();
    // JS-RI-1 — deal-deletion cascade (ADR 0283 seam): follow-ups, drafts and
    // digests die with their deal instead of orphaning into funnel joins.
    registerJobSearchCrmCascade();
    registerJobSearchRoutes(deps);
    registerPublicAttestationRoutes(deps);
    registerAnswerBankRoutes(deps);
    // WF-JS-1 / ADR 0543 D3 — the campaign chain, SAME-ID chain-backed. The
    // lane choice, deliberately (closes WF-JS-3): `career.search`/`career.apply`
    // stay gallery-only — a user instantiates an editable copy via from-chain,
    // and nothing resolves them by a fixed id. `career.campaign` is ALSO
    // registered under its stable id because the career agent's kanban cards
    // must name a `workflowId` that resolves on every instance (the heartbeat
    // passes the id straight to `startWorkflowRun`); a from-chain mint would
    // give each tenant a different id no card could know in advance. Same-id
    // registration keeps it gallery-editable AND card-runnable (ADR 0472 P4).
    registerChainBackedWorkflow(CAREER_CAMPAIGN_CARD_WORKFLOW_ID);
  },
  // ADR 0539 D1 — an application IS a CRM deal (pipeline, stage history, reports,
  // merge, timeline). Without CRM the vertical has no pipeline at all, which is
  // exactly the "genuinely breaking" bar this field is for.
  dependsOn: ['crm'],
  // ADR 0014 — `ctx.features['job-search']`: read ops + ONE terminal write +
  // the WF-JS-1 campaign trigger. No op takes a submission target: the law's
  // substance is that nothing may route AROUND the ADR 0541 grant, and
  // `runCampaignPass` takes nothing but the run's own tenant — every submission
  // inside the pass is grant-consulted, pace-bounded and claim-CAS'd (see the
  // surface.ts header + the ADR 0543 §D3 correction note).
  surface: { id: JOB_SEARCH_TOGGLE, build: buildJobSearchSurface },
  // ADR 0540 P4 — the pack now exists, so it is declared.
  requiredPacks: [
    { name: 'feature.job-search.nodes', version: '1.1.0' },
    // ADR 0543 P1 — the career persona is DATA. Nothing about it lives in host
    // source, and the heartbeat needs no change to run it.
    { name: 'feature.career-agent.agents', version: '1.0.0' },
  ],
  toggleDefault: {
    id: JOB_SEARCH_TOGGLE,
    label: JOB_SEARCH_LABEL,
    description:
      'Find, score and apply to roles as an autonomous vertical over CRM, Documents and ' +
      'the work loop — job listings, résumé variants, a bounded auto-submit grant, and the ' +
      'follow-up/interview lifecycle. Off ⇒ none of the job-search surfaces exist.',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'job-search',
  },
};
