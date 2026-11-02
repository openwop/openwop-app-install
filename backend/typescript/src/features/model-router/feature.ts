/**
 * Rule-based per-turn model router (ADR 0130, ADR 1016). Chooses a {provider,model}
 * for each chat exchange from the WORKSPACE's rule set in front of dispatch (ADR
 * 0067), among the models of the provider the conversation's key belongs to.
 * Decided per exchange and never stamped (ADR 1016 D3).
 *
 * Toggle: `model-router`, default ON, per tenant (ADR 0820 §8.2 — restored so it
 * can be sold in the Governance bundle). Its config routes require it. The chat
 * hot path DEGRADES rather than refuses: with the feature refused, no new route is
 * resolved and the turn keeps the run's own model (`resolveRoute.ts`). A legacy
 * route stamped on a run before ADR 1016 is still read when the conversation can
 * call it.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import type { BackendFeature } from '../types.js';
import { registerModelRouterRoutes } from './routes.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { eraseRouterConfigSubject } from './configService.js';

export const modelRouterFeature: BackendFeature = {
  id: 'model-router',
  registerRoutes: (deps) => {
    registerModelRouterRoutes(deps);
    // MR66CD-8 — `updatedBy` is tombstoned on a subject erasure (ADR 0464).
    registerSubjectEraser(eraseRouterConfigSubject);
  },
  toggleDefault: {
    id: 'model-router',
    label: 'Model router',
    description:
      'Rule-based model choice for each chat message in a workspace (by size, attachments, difficulty or conversation kind), among the models of the provider a conversation’s key belongs to. Turn OFF and every message uses its conversation’s own model; rules you saved are kept.',
    category: 'Governance',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'model-router',
  },
};
