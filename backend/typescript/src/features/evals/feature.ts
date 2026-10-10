/**
 * Eval / feedback leaderboard (ADR 0123, backlog B14). Turns the already-captured
 * MessageFeedback (ADR 0071) into a per-model win-rate + Elo quality ranking — an
 * admin surface, no new chat.
 *
 * Toggle: `evals`, default ON, per tenant. ADR 0820 §8.2 restored it (it had
 * graduated to always-on in ADR 0134) so the feature can be sold in the
 * Governance bundle. It gates the leaderboard/arena routes AND the LLM judge
 * of online workflow evals (`host/workflowEvalOnline.ts`), the part that spends.
 *
 * @see docs/adr/0123-eval-feedback-leaderboard.md
 */
import type { BackendFeature } from '../types.js';
import { registerEvalsRoutes } from './routes.js';

export const evalsFeature: BackendFeature = {
  id: 'evals',
  registerRoutes: (deps) => { registerEvalsRoutes(deps); },
  toggleDefault: {
    id: 'evals',
    label: 'Model evals',
    description:
      'The model leaderboard and arena (win-rate and Elo from chat feedback), plus the AI judge that scores production workflow runs against online eval sets. Turn OFF to hide the leaderboard and skip the AI judge; deterministic online assertions keep scoring.',
    category: 'Governance',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'evals',
  },
};
