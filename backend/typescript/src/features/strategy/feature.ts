/**
 * Strategy (ADR 0079). A toggle-gated feature-package: an executive **strategy
 * portfolio** (narrative rationale + OKR-compatible objectives/key-results +
 * initiatives + horizon + owner + status/confidence/risk) that becomes the
 * connective tissue across Priority Matrix, Projects, and Board of Advisors.
 *
 * No parallel architecture: alignment links are CANONICAL on the strategy and
 * read BACK into the surfaces they connect — no denormalized `strategyIds[]` on
 * those stores, no overload of `Project.charter`, and NOT a reuse of `goals`
 * (judge-owned / execution-bounded, RFC 0097).
 *
 * RFC gate (ADR 0079): host-extension under /v1/host/openwop-app/strategy/*,
 * linking existing host entities. NO new RFC.
 *
 * Ships REST + RBAC + the read-only `ctx.features.strategy` workflow surface
 * (list/get/context/health — tenant-trusted, shared strategies only; user-scoped
 * private drafts excluded) + the `feature.strategy.nodes` pack (ADR 0080): read
 * nodes over the surface + a create-board-memo write node that persists to
 * Documents (the strategy surface stays read-only) + the `feature.strategy.agents`
 * Strategy Analyst pack (chat-drivable per ADR 0080 §Phase C / ADR 0058).
 *
 * @see docs/adr/0079-strategic-planning.md
 */

import type { BackendFeature } from '../types.js';
import { STRATEGY_TOGGLE_ID } from './types.js';
import { registerStrategyRoutes } from './routes.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { eraseSubjectStrategy } from './strategyService.js';
import { buildStrategySurface } from './surface.js';
import { registerStrategyAgentTools } from './agentTools.js';

export const strategyFeature: BackendFeature = {
  id: 'strategy',
  registerRoutes: (deps) => {
    // CFP-1 / ADR 0080 §Phase C — the Strategy Analyst's REAL conversational
    // tools (four surface-backed reads + a board-memo Document write), the ADR
    // 0308 D2 feature-registered-builtin seam. Registration is process-wide +
    // inert until the agent allowlists the ids; per-tenant toggle honesty lives
    // inside each tool's run().
    registerStrategyAgentTools();
    registerStrategyRoutes(deps);
    // R2 STR2-M7 — GDPR subject erasure. Registered unconditionally: an erasure must not
    // depend on a feature toggle being on today.
    registerSubjectEraser(eraseSubjectStrategy);
  },
  surface: { id: 'strategy', build: buildStrategySurface },
  toggleDefault: {
    id: STRATEGY_TOGGLE_ID,
    label: 'Strategy',
    description:
      'Define, manage, and communicate company strategy as an executive portfolio: narrative rationale + OKR-compatible objectives and key results + initiatives, with a planning horizon (quarter / half-year / annual / multi-year / custom), owner / accountable executive, and status / confidence / risk. Strategies link to projects, Priority Matrix lists and ideas, and advisory boards, and project a compact strategy context packet into those surfaces. Scopeable to a user (private draft), the workspace, or one organization. ON by default (ADR 0229).',
    category: 'Leadership',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'strategy',
  },
  requiredPacks: [
    // ADR 0080 — read nodes over ctx.features.strategy + a create-board-memo
    // write node (persists to Documents) + the Strategy Analyst agent that
    // tool-calls them through the existing chat (ADR 0058 chat-drivability).
    { name: 'feature.strategy.nodes', version: '1.3.0' },
    { name: 'feature.strategy.agents', version: '1.0.1' },
  ],
  // ADR 0194 Phase 5 — a SOFT dependency (advisory, never a lock): the Strategy
  // Analyst drafts board memos as Documents `board-update` docs (ADR 0080) when
  // `documents` is enabled; strategy is fail-soft on unresolvable Document links
  // (strategyHealth.ts), so nothing breaks without it. The console suggests it.
  recommends: ['documents'],
};
