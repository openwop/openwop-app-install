/**
 * Standing-goals feature (RFC 0097) — ADR 0039 §Phase 2.
 *
 * Self-contained feature-package (ADR 0001): appended to BACKEND_FEATURES. Serves
 * the `/v1/host/openwop-app/goals` seam unconditionally; the `agents.goals` capability
 * is advertised separately in `discovery.ts` gated on `OPENWOP_GOALS_ENABLED`.
 */

import type { BackendFeature } from '../types.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerScheduledJobFireGate } from '../../host/scheduledJobFireGates.js';
import { GOALS_SURFACE_SCOPES } from './access.js';
import { registerGoalsAgentTools } from './agentTools.js';
import { GOAL_CONTINUATION_JOB_PREFIX, eraseGoalsForSubject, goalContinuationFireGate, ownsGoalContinuationJob } from './goalsService.js';
import { registerGoalsRoutes } from './routes.js';
import { buildGoalsSurface } from './surface.js';

export const goalsFeature: BackendFeature = {
  id: 'goals',
  registerRoutes: (deps) => {
    registerGoalsRoutes(deps);
    registerGoalsAgentTools(); // XCH-HOLE-1 (Wave 4) — openwop:goals.list (ADR 0308 seam)
    // ADR 0908 D7 — a person's goals are erased with them.
    registerSubjectEraser(eraseGoalsForSubject);
    // ADR 0908 D8 — bounds stop the continuation, not only the judge.
    registerScheduledJobFireGate('goals', { owns: ownsGoalContinuationJob, gate: goalContinuationFireGate, refusal: 'dispatch-error', reservedJobIdPrefix: GOAL_CONTINUATION_JOB_PREFIX,
      managedBy: { id: 'goal', message: 'This schedule belongs to a standing goal. Pause, resume or re-arm it through the goal.' } });
  },
  // ADR 0412 P1 — the `ctx.features.goals` consumption seam (create/get/
  // bindRun/evaluate); ADR 0414's enrollment saga is the first consumer.
  // ADR 0908 D1 — each method asks the run's person the scope its HTTP door asks.
  surface: { id: 'goals', build: buildGoalsSurface, orgPolicy: { tenantMethodScopes: GOALS_SURFACE_SCOPES } },
};
