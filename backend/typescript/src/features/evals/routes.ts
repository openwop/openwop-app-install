/**
 * Eval leaderboard routes (ADR 0123 Phase 2, ADR 0986) — host-extension, org-scoped + RBAC.
 *
 * - `GET  …/leaderboard` → `{leaderboard, arena, coverage}`: chat ratings ranked by
 *   the model that ANSWERED (server-attributed, ADR 0986 D2/D3), arena standings
 *   (a Bradley–Terry fit over bound verdicts, D5), and how many ratings could not
 *   be attributed.
 * - `POST …/arena/match` `{runIdA, runIdB, winner}` — a verdict on two of the
 *   caller's own conversation runs (D4). Model names in the body are ignored.
 * - `GET  …/arena/rating?model=` — one model's arena rating, from the same fit.
 *
 * ADMIN-tier reads (EVC-1): the leaderboard + arena/rating gate on
 * `host:members:manage`; `arena/match` stays `workspace:write`. ADR 0820 §8.2 —
 * every route gates on the `evals` toggle + plan first (`authorizeOrgScope`).
 *
 * @see docs/adr/0986-evals-attributed-leaderboard-and-bound-arena.md
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { OpenwopError } from '../../types.js';
import { fromWireRunId } from '../../host/v2Ids.js';
import { createLogger } from '../../observability/logger.js';
import { buildTenantLeaderboard } from './leaderboardService.js';
import { recordArenaMatch, getArenaRating, arenaStandings } from './arena.js';

const FEATURE = { toggleId: 'evals', label: 'Model evals' } as const;
const log = createLogger('evals.routes');
/** Run ids are opaque (a shared workspace's are `w-<tenant>/<uuid>`); bound only in size. */
const isRunId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

export function registerEvalsRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;
  app.get('/host/openwop-app/evals/orgs/:orgId/leaderboard', async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'host:members:manage'); // EVC-1: admin-tier read
      const { leaderboard, coverage } = await buildTenantLeaderboard(tenantId);
      // How much of the signal the board could not rank — the number that went
      // invisible for months before ADR 0986.
      log.info('evals_leaderboard_read', { attributed: coverage.attributed, unattributed: coverage.unattributed, models: leaderboard.length });
      res.json({ leaderboard, arena: await arenaStandings(tenantId), coverage });
    } catch (err) { next(err); }
  });

  // ADR 0986 D4 — a verdict on two REAL runs. The rater is the SESSION subject,
  // the models come from the host's attribution rows, and a pair counts once.
  app.post('/host/openwop-app/evals/orgs/:orgId/arena/match', async (req, res, next) => {
    try {
      const { user, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = (req.body ?? {}) as { runIdA?: unknown; runIdB?: unknown; winner?: unknown; modelA?: unknown; modelB?: unknown };
      if (!isRunId(b.runIdA) || !isRunId(b.runIdB)) {
        // A pre-0986 client (`openwop evals match` ≤ CLI 1.8.0) still posts model
        // names: say exactly what changed, machine-readably, not a bare 400.
        const legacy = b.modelA !== undefined || b.modelB !== undefined;
        throw new OpenwopError('validation_error', legacy
          ? 'Arena verdicts no longer accept model names (ADR 0986): post `{runIdA, runIdB, winner}` — two of your own conversation runs that answered the same prompt.'
          : '`runIdA` and `runIdB` are required: a verdict is cast on two runs, not two model names.', 400, {
          reason: legacy ? 'arena_contract_changed' : 'arena_runs_required',
          required: ['runIdA', 'runIdB', 'winner'],
        });
      }
      const winner = b.winner === 'A' || b.winner === 'B' || b.winner === 'tie' ? b.winner : undefined;
      if (!winner) throw new OpenwopError('validation_error', '`winner` MUST be A | B | tie.', 400, { field: 'winner' });
      // The run stamp is `req.userId ?? principal.principalId` (routes/runs.ts). For
      // a cookie caller that is the canonical user id; for a bearer caller it is the
      // principal. Accept exactly what the stamp would have been, plus the canonical id.
      const stamp = req.userId ?? req.principal?.principalId;
      const callerKeys = [user.userId, ...(stamp ? [stamp] : [])];
      // A run id may arrive in its v2 tenant-bound wire spelling (`w-<tenant>/<id>`);
      // a foreign tenant segment reads as absent, like any other run not the caller's.
      const stored = (raw: string): string => {
        const r = fromWireRunId(raw, tenantId);
        if (!r.ok) throw new OpenwopError('run_not_found', 'run not found', 404, {});
        return r.runId;
      };
      const result = await recordArenaMatch(storage, tenantId, {
        runIdA: stored(b.runIdA), runIdB: stored(b.runIdB), winner,
        // The canonical id is already `user:`-shaped; prefixing it again wrote a
        // `user:user:…` subject no erasure key form matches (found by EV2-9).
        raterSubject: user.userId.startsWith('user:') ? user.userId : `user:${user.userId}`, callerKeys, createdAt: new Date().toISOString(),
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      if (err instanceof OpenwopError && err.httpStatus !== 500) {
        // Ids and reasons only — never the prompts.
        log.info('arena_verdict_refused', { code: err.code, status: err.httpStatus, reason: (err.details as { reason?: unknown } | undefined)?.reason });
      }
      next(err);
    }
  });

  app.get('/host/openwop-app/evals/orgs/:orgId/arena/rating', async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'host:members:manage'); // EVC-1: admin-tier read
      const model = typeof req.query.model === 'string' ? req.query.model : '';
      if (!model) throw new OpenwopError('validation_error', '`model` query param is required.', 400, { field: 'model' });
      res.json({ model, elo: await getArenaRating(tenantId, model) });
    } catch (err) { next(err); }
  });
}
