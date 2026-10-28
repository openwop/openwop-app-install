/**
 * Experiments (ADR 0949) — one experiment model across surfaces, with Decide
 * mode: a pre-registered plan that locks at launch, always-valid sequential
 * inference (mSPRT + Benjamini–Hochberg), an SRM halt and a closed verdict enum.
 * The model, store, assignment and statistics are core (`host/experiments/`);
 * each surface (CMS pages, funnel steps) registers its own adapter. This package
 * owns the routes. Host-extension — no RFC.
 *
 * Default OFF. Legacy CMS page and funnel step A/B tests keep working with it off
 * (ADR 0949 D5).
 *
 * @see docs/adr/0949-unified-experimentation-engine.md
 */
import type { BackendFeature } from '../types.js';
import { registerExperimentsRoutes } from './routes.js';
import { buildExperimentsSurface } from './surface.js';
import { registerRunStartContributor } from '../../host/runStartContext.js';
import { experimentsRunStartContributor } from '../../host/experiments/runFreeze.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { eraseExperimentFirstExposures } from '../../host/experiments/sticky.js';
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { AUTO_PROMOTE_TOGGLE, PROMOTE_CHAIN_ID } from './promotionService.js';

let wired = false;

export const experimentsFeature: BackendFeature = {
  id: 'experiments',
  registerRoutes: (deps) => {
    registerExperimentsRoutes(deps);
    // ADR 0949 P3 — freeze each run's assignment instant (idempotent across boots).
    if (!wired) {
      wired = true;
      registerRunStartContributor(experimentsRunStartContributor);
      // ADR 0949 P4 — Optimize first exposures are keyed by a subject's unit key.
      registerSubjectEraser(eraseExperimentFirstExposures);
    }
    // ADR 0950 P2 — the promotion chain, same id, owned by the sub-toggle: every
    // launch resolves `experiments.auto-promote`, and the chain is internal.
    registerChainBackedWorkflow(PROMOTE_CHAIN_ID, { featureId: AUTO_PROMOTE_TOGGLE });
  },
  // ADR 0949 P2b — `ctx.features.experiments` (read, draft, lock, stop; no launch).
  surface: { id: 'experiments', build: buildExperimentsSurface },
  requiredPacks: ['feature.experiments.nodes'],
  toggleDefault: {
    id: 'experiments',
    label: 'Experiments',
    description: 'Pre-registered A/B tests on pages and funnel steps, with always-valid results.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'experiments',
  },
  // Page results are a projection over analytics events; the results route
  // checks `analytics` access per read (ADR 0820 §7) rather than locking it on:
  // funnel step experiments need no analytics, and this package imports none.
  recommends: ['analytics', 'cms', 'funnels'],
  // ADR 0950 P2 — governed promotion (the ADR 0941 D5 sub-toggle rule: no
  // dependsOn; the route AND-gates `experiments` in code). OFF ⇒ no promotion route.
  extraToggleDefaults: [{
    id: AUTO_PROMOTE_TOGGLE,
    label: 'Experiments — governed promotion',
    description: 'Promote a Decide experiment\'s winner in stages (50%, 90%, then all but a 1–5% holdout), each stage rechecked for sample-ratio mismatch and guardrails, then monitored against the holdout before it ships. Any breach rolls back to the previous content. The campaign autonomy policy decides who approves. A sub-capability of Experiments.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'experiments-auto-promote',
  }],
};
