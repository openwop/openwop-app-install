/**
 * Standing-goals feature (RFC 0097) — ADR 0039 §Phase 2.
 *
 * Self-contained feature-package (ADR 0001): appended to BACKEND_FEATURES. Serves
 * the `/v1/host/openwop-app/goals` seam unconditionally; the `agents.goals` capability
 * is advertised separately in `discovery.ts` gated on `OPENWOP_GOALS_ENABLED`.
 */

import type { BackendFeature } from '../types.js';
import { registerGoalsAgentTools } from './agentTools.js';
import { registerGoalsRoutes } from './routes.js';
import { buildGoalsSurface } from './surface.js';

export const goalsFeature: BackendFeature = {
  id: 'goals',
  registerRoutes: (deps) => {
    registerGoalsRoutes(deps);
    registerGoalsAgentTools(); // XCH-HOLE-1 (Wave 4) — openwop:goals.list (ADR 0308 seam)
  },
  // ADR 0412 P1 — the `ctx.features.goals` consumption seam (create/get/
  // bindRun/evaluate); ADR 0414's enrollment saga is the first consumer.
  surface: { id: 'goals', build: buildGoalsSurface },
};
