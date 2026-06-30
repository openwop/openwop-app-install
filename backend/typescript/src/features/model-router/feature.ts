/**
 * Rule-based per-turn model router (ADR 0130, backlog). Chooses a {provider,model}
 * per turn from a tenant rule set in front of dispatch (ADR 0067). Phase 1 = the
 * pure selector; Phase 2 = this config CRUD; Phase 3 = the dispatch call-site +
 * replay stamp. A `model-router` toggle, off by default, per tenant.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import type { BackendFeature } from '../types.js';
import { registerModelRouterRoutes } from './routes.js';

export const modelRouterFeature: BackendFeature = {
  id: 'model-router',
  registerRoutes: (deps) => { registerModelRouterRoutes(deps); },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
