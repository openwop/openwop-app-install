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
 * `advisory-board`, OFF by default, tenant-bucketed (ADR 0015).
 *
 * RFC gate (ADR 0040): host work, NO blocking RFC — every council turn is an
 * ordinary non-normative `chat.turn` run. The normative cross-host multi-party
 * shape is the Parked companion RFC 0101 (Phase 6).
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import type { BackendFeature } from '../types.js';
import { registerAdvisoryBoardRoutes } from './routes.js';
import { buildAdvisoryBoardSurface } from './surface.js';

export const advisoryBoardFeature: BackendFeature = {
  id: 'advisory-board',
  registerRoutes: (deps) => registerAdvisoryBoardRoutes(deps),
  surface: { id: 'advisory-board', build: buildAdvisoryBoardSurface },
  requiredPacks: [{ name: 'feature.advisory-board.nodes', version: '1.0.0' }],
  toggleDefault: {
    id: 'advisory-board',
    label: 'Board of Advisors',
    description:
      'Assemble councils of named advisor agents (digital-clone personas) and convene them together in one shared chat via `@@`. Each advisor draws from its own bound knowledge (ADR 0038) and the council sees each other\'s turns; a moderator synthesizes. Advisors are roster agents (ADR 0031/0032); the board is a new grouping under /advisors/*, not a Kanban board. Boards are private or workspace-shared. Simulated personas of real people carry a disclaimer; living individuals require an explicit acknowledgement. OFF by default.',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'advisory-board',
  },
};
