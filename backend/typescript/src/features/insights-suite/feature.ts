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
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerScheduledJobFireGate } from '../../host/scheduledJobFireGates.js';
import { eraseInsightsSuiteSubject, ownsInsightsWeeklyJob, WEEKLY_JOB_PREFIX } from './insightsSuiteService.js';

export const insightsSuiteFeature: BackendFeature = {
  id: 'insights-suite',
  // ADR 0472 Phase 2 — the 3 meta-workflows MIGRATED off `builtinWorkflows` to
  // chain-backed registration (chainId === the original `openwop-app.insights.*` id,
  // so ignition + replay resolve unchanged) + the gallery-editable chain pack. Chain
  // packs are boot-loaded before features register (the app-builder precedent).
  registerRoutes: (deps) => {
    registerInsightsMetaWorkflows();
    registerInsightsSuiteRoutes(deps);
    // ADR 1102 D8 — the suite is erased with the person it runs as. Registered
    // unconditionally: an erasure must not depend on a toggle being on today.
    registerSubjectEraser(eraseInsightsSuiteSubject);
    // ADR 1102 D4 (architect H5) — reserve the weekly job's id prefix, so the generic
    // scheduler route cannot mint, squat, retarget, re-enable or re-own it. The
    // fire-time feature check is already the job's `featureId`, so the gate itself
    // lets every fire through.
    registerScheduledJobFireGate('insights-suite', {
      owns: ownsInsightsWeeklyJob,
      gate: async () => null,
      refusal: 'dispatch-error',
      reservedJobIdPrefix: WEEKLY_JOB_PREFIX,
      managedBy: { id: 'insights-suite', message: 'This schedule belongs to Insights & Drafting. Change it in Settings → AI → Insights & Drafting.' },
    });
  },
  toggleDefault: {
    id: 'insights-suite',
    label: 'Insights & Drafting',
    description:
      'Three domain agents + built-in workflows driven through the existing chat / builder / scheduler: Financial (Actual-vs-Plan variance from the data lake, on a weekly schedule set in Settings → AI → Insights & Drafting), Talent (9-box readiness from ratings you supply or Workday), Communication (in-voice recognition drafting — the draft is approved before it is saved to your mailbox, never sent). Results surface as run outputs + notifications — no separate dashboard or store.',
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
    'feature.insights-suite.nodes',
    // agents 1.1.0 — ADR 0600 §8 (ISC-12): the Financial agent's prompt and pack
    // description instructed the model to cite SQL provenance and a "data as-of"
    // timestamp that `variance-compute` does not emit, and to expect figures from
    // a scheduled run that has no path into a conversation. A model told to cite a
    // structurally absent thing does not go silent; it narrates a traceability
    // story it cannot back. Pinned to the node's real outputs by `PROBE-IS-11`.
    'vendor.openwop-app.insights-suite.agents',
  ],
};
