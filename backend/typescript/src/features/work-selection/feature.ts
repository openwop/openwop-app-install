/**
 * ADR 0534 — Ranked work selection.
 *
 * Which To Do card the autonomous work loop takes next. Before this, selection
 * was strictly oldest-filed-first, and `card.priority` was read only to decide
 * whether to ask a human — never to order.
 *
 * The feature owns POLICY only. The ranking engine is `host/weightedScoring.ts`
 * (shared with Priority Matrix, CRM propensity and Recommendations), and the
 * seam into core is `registerWorkSelectionCompiler` — core never imports this
 * feature, the ADR 0318 `registerHeartbeatConfigProvider` pattern.
 *
 * Default OFF and bucketed per TENANT: a board is workspace-shared, so per-user
 * selection policy on one board would be incoherent (ADR 0015). Off ⇒ the
 * compiler declines and core uses the literal pre-0534 order.
 *
 * @see docs/adr/0534-agenda-compiler-ranked-work-selection.md
 */
import type { BackendFeature } from '../types.js';
import { registerWorkSelectionCompiler, setWorkSelectionPolicyId } from '../../host/heartbeatService.js';
import { workSelectionCompiler, WORK_SELECTION_TOGGLE, WORK_SELECTION_POLICY } from './service.js';
import { buildWorkSelectionSurface } from './surface.js';
import { registerWorkSelectionAgentTools } from './agentTools.js';
import { registerWorkSelectionRoutes } from './routes.js';

let wired = false;

/** Idempotent boot wiring — safe across repeated `registerBackendFeatures` (tests). */
function wireCompiler(): void {
  if (wired) return;
  wired = true;
  registerWorkSelectionCompiler(workSelectionCompiler);
  // ADR 0534 D3 — core carries no policy vocabulary of its own; the feature
  // declares which version is ranking so a replayed stamp is attributable.
  setWorkSelectionPolicyId(WORK_SELECTION_POLICY);
}

export const workSelectionFeature: BackendFeature = {
  id: WORK_SELECTION_TOGGLE,
  registerRoutes: (deps) => {
    wireCompiler();
    registerWorkSelectionAgentTools();
    registerWorkSelectionRoutes(deps);
  },
  // ADR 0014 — `ctx.features['work-selection']`: preview only. Selection is host
  // policy the model observes, never authors.
  surface: { id: WORK_SELECTION_TOGGLE, build: buildWorkSelectionSurface },
  requiredPacks: [{ name: 'feature.work-selection.nodes', version: '1.0.0' }],
  toggleDefault: {
    id: WORK_SELECTION_TOGGLE,
    label: 'Ranked work selection',
    description:
      'The autonomous work loop picks the most important To Do card (due-date urgency, ' +
      'stated priority, age, blocked) instead of the oldest-filed one. Off ⇒ insertion order.',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'work-selection',
  },
};
