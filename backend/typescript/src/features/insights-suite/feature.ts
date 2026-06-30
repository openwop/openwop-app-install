/**
 * Insights & Drafting (ADR 0082 — rebuilt ON the workflow engine). A toggle-gated
 * feature-package that is now PURE composition: 3 domain agents (Financial / Communication /
 * Talent) + a compute node pack (variance-compute, talent-score) + 3 built-in meta-workflows
 * (weekly-variance, talent, anniversary-draft) wired to REAL source/analysis/LLM/draft/notify
 * nodes (BigQuery, Workday, core.ai.chatCompletion, email.draft, notification-push), plus a
 * config-reconciliation seam (the schedule + anniversary trigger).
 *
 * ADR 0082 DELETED the parallel surface 0078 shipped — the bespoke dashboard, the
 * VarianceReport/TalentSnapshot read model, the demo seeder, and the read routes. Insights
 * are now the LIVE output of running these workflows (via chat / builder / scheduler /
 * trigger), surfaced through the EXISTING runs / artifacts / chat / notification surfaces.
 * No page, no result store, no seed. The feature retains only: packs + toggle + builtin
 * workflows + the config/reconciliation route.
 *
 * RFC gate: host-extension only (providerRegistry entry + node-pack typeId + host catalog
 * workflows); agents ride Accepted RFC 0070; reads reuse `workspace:read`. NO new RFC.
 *
 * @see docs/adr/0082-insights-suite-on-workflows.md (supersedes 0078/0081 dashboard parts)
 */

import type { BackendFeature } from '../types.js';
import { registerInsightsSuiteRoutes } from './routes.js';
import { insightsBuiltinWorkflows } from './metaWorkflows.js';

export const insightsSuiteFeature: BackendFeature = {
  id: 'insights-suite',
  registerRoutes: (deps) => registerInsightsSuiteRoutes(deps),
  // ADR 0078 P2 — the 3 pinned meta-workflows (weekly-variance, anniversary-draft,
  // talent-prep), resolved in catalog source A on every instance.
  builtinWorkflows: insightsBuiltinWorkflows,
  toggleDefault: {
    id: 'insights-suite',
    label: 'Insights & Drafting',
    description:
      'Three domain agents + built-in workflows driven through the existing chat / builder / scheduler / triggers: Financial (Actual-vs-Plan variance from the data lake), Talent (9-box readiness from Workday), Communication (in-voice recognition drafting from Workday milestones — always a draft for approval, never auto-send). Results surface as run outputs + notifications — no dashboard, no parallel store (ADR 0082). OFF by default.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'insights-suite',
  },
  requiredPacks: [
    { name: 'feature.insights-suite.nodes', version: '1.0.0' },
    { name: 'feature.insights-suite.agents', version: '1.0.0' },
  ],
};
