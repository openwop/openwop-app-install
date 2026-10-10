/**
 * Rule-based per-turn model router (ADR 0130, backlog). Chooses a {provider,model}
 * per turn from a tenant rule set in front of dispatch (ADR 0067). Phase 1 = the
 * pure selector; Phase 2 = this config CRUD; Phase 3 = the dispatch call-site +
 * replay stamp.
 *
 * Toggle: `model-router`, default ON, per tenant (ADR 0820 §8.2 — restored so it
 * can be sold in the Governance bundle). Its config routes require it. The chat
 * hot path DEGRADES rather than refuses: with the feature refused, no new route is
 * resolved and the turn keeps the run's own model (`resolveRoute.ts`). A route
 * already stamped on a run is read verbatim (replay-safe), whatever the plan.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import type { BackendFeature } from '../types.js';
import { registerModelRouterRoutes } from './routes.js';

export const modelRouterFeature: BackendFeature = {
  id: 'model-router',
  registerRoutes: (deps) => { registerModelRouterRoutes(deps); },
  toggleDefault: {
    id: 'model-router',
    label: 'Model router',
    description:
      'Rule-based model choice per chat turn (by size, attachments, difficulty or conversation kind). Turn OFF and every turn uses its default model; rules you saved are kept.',
    category: 'Governance',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'model-router',
  },
};
