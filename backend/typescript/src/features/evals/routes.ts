/**
 * Eval leaderboard routes (ADR 0123 Phase 2) — host-extension, org-scoped + RBAC.
 * `GET /v1/host/openwop-app/evals/orgs/:orgId/leaderboard` — per-model win-rate +
 * Elo over the tenant's MessageFeedback. Toggle-gated, workspace:read.
 *
 * @see docs/adr/0123-eval-feedback-leaderboard.md
 */
import { randomUUID } from 'node:crypto';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope } from '../featureRoute.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { buildTenantLeaderboard } from './leaderboardService.js';
import { recordArenaMatch, getArenaRating } from './arena.js';


/** Resolve a rated message's producing model from its persisted meta (the chat
 *  bubble stores `{provider, model, …}`). Best-effort: unparseable/absent → null
 *  (the rating is dropped from the ranking). N+1 over the tenant's conversations
 *  is acceptable for an admin surface. */
function metaModelResolver(): (conversationId: string, messageId: string) => Promise<string | null> {
  const cache = new Map<string, Map<string, string | null>>();
  return async (conversationId, messageId) => {
    let byMsg = cache.get(conversationId);
    if (!byMsg) {
      byMsg = new Map();
      for (const m of await hostExtStorage().listChatSessionMessages(conversationId)) {
        let model: string | null = null;
        if (m.meta) { try { const meta = JSON.parse(m.meta) as { model?: unknown }; if (typeof meta.model === 'string') model = meta.model; } catch { /* ignore */ } }
        byMsg.set(m.messageId, model);
      }
      cache.set(conversationId, byMsg);
    }
    return byMsg.get(messageId) ?? null;
  };
}

export function registerEvalsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  app.get('/v1/host/openwop-app/evals/orgs/:orgId/leaderboard', async (req, res, next) => {
    try {
      const { user } = await requireOrgScope(req, 'workspace:read');
      const leaderboard = await buildTenantLeaderboard(user.tenantId, metaModelResolver());
      res.json({ leaderboard });
    } catch (err) { next(err); }
  });

  // ADR 0123 Phase 3b — capture an arena head-to-head winner. The rater is bound to
  // the SESSION subject (not client-supplied) — a winner can't be attributed to
  // someone else. The two live model dispatches are normal runs (the FE arena drives
  // them); this records the verdict + updates both models' head-to-head Elo.
  app.post('/v1/host/openwop-app/evals/orgs/:orgId/arena/match', async (req, res, next) => {
    try {
      const { user } = await requireOrgScope(req, 'workspace:write');
      const b = (req.body ?? {}) as { modelA?: unknown; modelB?: unknown; winner?: unknown };
      if (typeof b.modelA !== 'string' || typeof b.modelB !== 'string') {
        throw new OpenwopError('validation_error', '`modelA` and `modelB` are required.', 400, {});
      }
      const winner = b.winner === 'A' || b.winner === 'B' || b.winner === 'tie' ? b.winner : undefined;
      if (!winner) throw new OpenwopError('validation_error', '`winner` MUST be A | B | tie.', 400, { field: 'winner' });
      const result = await recordArenaMatch(user.tenantId, {
        matchId: randomUUID(), modelA: b.modelA, modelB: b.modelB, winner,
        raterSubject: `user:${user.userId}`, createdAt: new Date().toISOString(),
      });
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  app.get('/v1/host/openwop-app/evals/orgs/:orgId/arena/rating', async (req, res, next) => {
    try {
      const { user } = await requireOrgScope(req, 'workspace:read');
      const model = typeof req.query.model === 'string' ? req.query.model : '';
      if (!model) throw new OpenwopError('validation_error', '`model` query param is required.', 400, { field: 'model' });
      res.json({ model, elo: await getArenaRating(user.tenantId, model) });
    } catch (err) { next(err); }
  });
}
