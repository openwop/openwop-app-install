/**
 * Board of Advisors workflow surface (ADR 0040 / ADR 0014 Phase 1) — the typed,
 * read-mostly `ctx.features['advisory-board']` a workflow node calls. Tenant comes
 * from the run scope; node access is tenant-internal, so only `shared` boards are
 * visible (a `private` board is the creator's, not node-accessible). Toggle-gated
 * at the registry seam (featureSurfaces.gate).
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { listBoards } from './service.js';

export function buildAdvisoryBoardSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** List the workspace's SHARED advisory boards (id, name, handle, advisor
     *  rosterIds). A workflow can read the cohort; the boardroom CONVERSATION
     *  itself runs in the AI chat over the existing chat.turn infra (ADR 0040
     *  § Correction 2026-06-15), not a node-side convene. */
    listBoards: async () => {
      const boards = await listBoards(tenantId, undefined);
      return { boards: boards.map((b) => ({ boardId: b.boardId, name: b.name, handle: b.handle, advisors: b.advisors })) };
    },
  };
}
