/**
 * Standing-goals feature (RFC 0097) — ADR 0039 §Phase 2.
 *
 * Self-contained feature-package (ADR 0001): appended to BACKEND_FEATURES. Serves
 * the `/v1/host/openwop-app/goals` seam unconditionally; the `agents.goals` capability
 * is advertised separately in `discovery.ts` gated on `OPENWOP_GOALS_ENABLED`.
 */

import type { BackendFeature } from '../types.js';
import { registerGoalsRoutes } from './routes.js';

export const goalsFeature: BackendFeature = {
  id: 'goals',
  registerRoutes: (deps) => {
    registerGoalsRoutes(deps);
  },
};
