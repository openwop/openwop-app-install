/**
 * Work-selection workflow surface (ADR 0534 P4 / ADR 0014) —
 * `ctx.features['work-selection']`.
 *
 * ONE op, deliberately read-only: `preview(boardId)` returns the ranking the
 * autonomous loop would apply to that board's To Do lane right now, with the
 * per-criterion inputs behind each score.
 *
 * There are no write ops. Selection is host policy the model may OBSERVE but
 * never author — a workflow that could reorder its own queue would be able to
 * promote itself past the agent-policy verdict and the run budget.
 *
 * Toggle gating is automatic: `host/featureSurfaces` wraps every op with a
 * per-run `work-selection` toggle check because the feature declares a
 * `toggleDefault`. Tenant comes from the run scope, never from an argument —
 * a caller-supplied tenant would be an IDOR.
 *
 * @see docs/adr/0534-agenda-compiler-ranked-work-selection.md
 */

import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { readBoardRanking } from './agentTools.js';

export function buildWorkSelectionSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /**
     * The ranking this board's To Do lane would get right now. Read-only.
     *
     * Delegates to `readBoardRanking` — the SAME predicate the agent tool uses
     * (ADR 0308): one helper, so the surface and the tool cannot drift into
     * disagreeing about who may see a board. Returns `{ ranked: [] }` for an
     * unknown OR cross-tenant board without distinguishing them.
     */
    preview: async (args) => ({
      ranked: await readBoardRanking(tenantId, str(args.boardId) ?? '', Date.now(), scope.actingUserId),
    }),
  };
}
