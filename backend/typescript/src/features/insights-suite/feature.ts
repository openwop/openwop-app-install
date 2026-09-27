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
import { registerInsightsMetaWorkflows } from './metaWorkflows.js';

export const insightsSuiteFeature: BackendFeature = {
  id: 'insights-suite',
  // ADR 0472 Phase 2 — the 3 meta-workflows MIGRATED off `builtinWorkflows` to
  // chain-backed registration (chainId === the original `openwop-app.insights.*` id,
  // so ignition + replay resolve unchanged) + the gallery-editable chain pack. Chain
  // packs are boot-loaded before features register (the app-builder precedent).
  registerRoutes: (deps) => {
    registerInsightsMetaWorkflows();
    registerInsightsSuiteRoutes(deps);
  },
  toggleDefault: {
    id: 'insights-suite',
    label: 'Insights & Drafting',
    description:
      'Three domain agents + built-in workflows driven through the existing chat / builder / scheduler / triggers: Financial (Actual-vs-Plan variance from the data lake), Talent (9-box readiness from Workday), Communication (in-voice recognition drafting from Workday milestones — always a draft for approval, never auto-send). Results surface as run outputs + notifications — no dashboard, no parallel store (ADR 0082). OFF by default.',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'insights-suite',
  },
  requiredPacks: [
    // 1.1.0 — ADR 0599 §3: both compute nodes now FAIL CLOSED on absent data
    // instead of returning a fabricated verdict under `status:'success'`.
    // 1.2.0 — ADR 0599 §Correction 1/4: 1.1.0's guards read absence through
    // `Number()`, which maps `null`/`''`/`false` to 0, so a warehouse of NULLs
    // still produced "on_plan" and a blank rating still produced box 1. Absence
    // is now rejected before coercion; a zero PLAN is uncomparable, not on-plan;
    // and a row-derived rating is neither picked arbitrarily nor scale-guessed.
    { name: 'feature.insights-suite.nodes', version: '1.2.0' },
    // agents 1.1.0 — ADR 0600 §8 (ISC-12): the Financial agent's prompt and pack
    // description instructed the model to cite SQL provenance and a "data as-of"
    // timestamp that `variance-compute` does not emit, and to expect figures from
    // a scheduled run that has no path into a conversation. A model told to cite a
    // structurally absent thing does not go silent; it narrates a traceability
    // story it cannot back. Pinned to the node's real outputs by `PROBE-IS-11`.
    { name: 'feature.insights-suite.agents', version: '1.1.1' },
  ],
};
