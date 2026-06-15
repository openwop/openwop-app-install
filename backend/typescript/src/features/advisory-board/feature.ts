/**
 * Board of Advisors (ADR 0040). A feature-package that COMPOSES existing owners
 * into multi-persona advisory councils:
 *   - advisors = roster agents + their `agentProfile` persona (ADR 0031/0032);
 *   - per-advisor RAG = the `agent-knowledge` feature (ADR 0038), retrieved per
 *     advisor in the host convene layer — unchanged;
 *   - the `@@` summon = a broadcast fan-out over the host multi-agent conversation
 *     scaffold (`agentPromptScaffold`), then a moderator synthesis.
 *
 * Adds a NEW `AdvisoryBoard` grouping entity under /v1/host/openwop-app/advisors/*
 * (explicitly NOT host.kanban's board). No persona store, no RAG store, no parallel
 * conversation runtime. Toggle `advisory-board`, OFF by default, tenant-bucketed
 * (boards + roster are workspace-scoped, ADR 0015).
 *
 * RFC gate (ADR 0040): host work, NO blocking RFC — the MVP rides Accepted RFC
 * 0005 + RFC 0002 §A8 under the non-normative host-ext namespace. The normative
 * cross-host multi-party shape is the non-blocking companion RFC 0101 (Phase 6).
 *
 * Deferred (logged, not silent): the signed `feature.advisory-board.nodes` pack +
 * the `advisory-board.convene` chat envelope (need the pack-build/sign pipeline)
 * and the `tmpl.advisors.*` celebrity-persona seed — the feature is fully
 * functional against the workspace's existing roster agents without them.
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
