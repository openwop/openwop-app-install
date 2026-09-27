/**
 * ADR 0534 P5 — the work-selection read route (host-extension).
 *
 *   GET /v1/host/openwop-app/work-selection/boards/:boardId/ranking
 *     → { ranked: [{ cardId, title, rank, score, why: [...] }] }
 *
 * Read-only, like the surface and the agent tool it shares a predicate with.
 * There is no write route: selection is host policy, and weights are edited
 * through Priority Matrix's existing criteria-set editor rather than a second
 * editor here (ADR 0534 matrix row 10).
 *
 * Non-normative host-extension namespace — never touches the OpenWOP wire, so
 * no RFC.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled } from '../featureRoute.js';
import { readBoardRanking } from './agentTools.js';
import { WORK_SELECTION_TOGGLE } from './service.js';

const BASE = '/v1/host/openwop-app/work-selection';

export function registerWorkSelectionRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/boards/:boardId/ranking`, async (req, res, next) => {
    try {
      // Toggle gate first: with the feature off the loop uses insertion order,
      // so a ranking would describe a decision the host is not making.
      await requireFeatureEnabled(req, WORK_SELECTION_TOGGLE, 'Ranked work selection');

      // The SAME predicate the surface and the agent tool use (ADR 0308), so the
      // three cannot drift about who may see a board. Tenant comes from the
      // request principal, never from a parameter.
      const ranked = await readBoardRanking(req.tenantId, req.params.boardId ?? '', Date.now(), req.userId);
      res.json({ ranked });
    } catch (err) {
      next(err);
    }
  });
}
