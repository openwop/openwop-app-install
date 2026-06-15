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
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listBoards, convene } from './service.js';

export function buildAdvisoryBoardSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** List the workspace's SHARED advisory boards (id, name, handle, advisor count). */
    listBoards: async () => {
      const boards = await listBoards(tenantId, undefined);
      return { boards: boards.map((b) => ({ boardId: b.boardId, name: b.name, handle: b.handle, advisors: b.advisors.length })) };
    },
    /** Convene a SHARED board for a prompt and return the attributed transcript.
     *  Node-driven: actor is the run (no user identity). `role:action` (recorded →
     *  replay reads the persisted session). */
    convene: async (args) => {
      const session = await convene(tenantId, undefined, null, str(args.boardId), { prompt: str(args.prompt) });
      return {
        sessionId: session.sessionId,
        turns: session.turns.map((t) => ({ speakerId: t.speakerId, speakerName: t.speakerName, role: t.role, content: t.content })),
      };
    },
  };
}
