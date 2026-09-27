/**
 * Board of Advisors (ADR 0040). A feature-package that defines advisory-board
 * COHORTS and lets them be convened in the existing AI chat:
 *   - advisors = roster agents + their `agentProfile` persona (ADR 0031/0032);
 *   - per-advisor RAG = the `agent-knowledge` feature (ADR 0038), composed into
 *     the existing `chat.turn` agent dispatch — unchanged;
 *   - the `@@<handle>` summon (ADR 0040 § Correction 2026-06-15) expands the board's
 *     cohort into the AI chat's active-agents lineup; the boardroom conversation
 *     runs on the EXISTING multi-agent chat infra (one advisor at a time), NOT a
 *     parallel convene runtime (that parallel stack was retired).
 *
 * This package owns ONLY the board entity (CRUD + `@@`-handle resolution) under
 * /v1/host/openwop-app/advisors/* (explicitly NOT host.kanban's board). No persona
 * store, no RAG store, no transcript store, no second chat runtime. Toggle
 * `advisory-board`, ON by default (ADR 0229), tenant-bucketed (ADR 0015).
 *
 * RFC gate (ADR 0040): host work, NO blocking RFC — every council turn is an
 * ordinary non-normative `chat.turn` run. The normative cross-host multi-party
 * shape is the Parked companion RFC 0101 (Phase 6).
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import type { BackendFeature } from '../types.js';
import { registerSubjectAccessResolver } from '../../host/subjectAccess.js';
import { registerShareableKbReconciler } from '../../host/shareableKb.js';
import { registerAdvisoryBoardRoutes } from './routes.js';
import { resolveBoardAccess, pruneAdvisorFromBoards, reconcileSharedKbForSourceChange } from './service.js';
import { onRosterMemberDeleted } from '../../host/rosterLifecycle.js';
import { buildAdvisoryBoardSurface } from './surface.js';

export const advisoryBoardFeature: BackendFeature = {
  id: 'advisory-board',
  registerRoutes: (deps) => {
    registerAdvisoryBoardRoutes(deps);
    // ADR 0288 — prune a deleted roster member from every board's live
    // membership (advisors[] + moderator); the board itself survives visibly.
    onRosterMemberDeleted('advisory-board', async ({ tenantId, rosterId }) => {
      await pruneAdvisorFromBoards(tenantId, rosterId);
    });
    // ADR 0278 — the board Subject's access resolver (per-kind seam, ADR 0054 D5):
    // WRITE ⟺ org workspace:write; READ ⟺ shared+workspace:read or the private
    // board's creator. This is what makes the canonical board conversation
    // "joinable": any org member with resolved read opens the SAME chat.
    registerSubjectAccessResolver('board', async (tenantId, subject, caller) =>
      resolveBoardAccess(tenantId, subject.id, caller),
    );
    // ADR 0608 D5 (`CPC-3`) — the CONSUMER side of the shareable-KB reconcile
    // seam. A source feature (projects) announces "my shareable set changed for
    // this org+kind"; the board re-applies the carve-out to its advisors'
    // bindings. Before this, the carve-out ran at share time only, so flipping a
    // shared project to `private` left every advisor retrieving the private
    // corpus on every turn while the panel reported nothing was shared.
    registerShareableKbReconciler(reconcileSharedKbForSourceChange);
  },
  surface: { id: 'advisory-board', build: buildAdvisoryBoardSurface },
  requiredPacks: [{ name: 'feature.advisory-board.nodes', version: '1.0.0' }],
  toggleDefault: {
    id: 'advisory-board',
    label: 'Board of Advisors',
    description:
      'Assemble councils of named advisor agents (digital-clone personas) and convene them together in one shared chat via `@@`. Each advisor draws from its own bound knowledge (ADR 0038) and the council sees each other\'s turns; a moderator synthesizes. Advisors are roster agents (ADR 0031/0032); the board is a new grouping under /advisors/*, not a Kanban board. Boards are private or workspace-shared. Simulated personas of real people carry a disclaimer; living individuals require an explicit acknowledgement. ON by default (ADR 0229).',
    category: 'Agents',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'advisory-board',
  },
};
