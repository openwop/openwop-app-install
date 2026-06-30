/**
 * Eval / feedback leaderboard (ADR 0123, backlog B14). Turns the already-captured
 * MessageFeedback (ADR 0071) into a per-model win-rate + Elo quality ranking — an
 * admin surface, no new chat. An `evals` toggle, off by default, per tenant.
 *
 * @see docs/adr/0123-eval-feedback-leaderboard.md
 */
import type { BackendFeature } from '../types.js';
import { registerEvalsRoutes } from './routes.js';

export const evalsFeature: BackendFeature = {
  id: 'evals',
  registerRoutes: (deps) => { registerEvalsRoutes(deps); },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
