/**
 * Priority Matrix (ADR 0058). A toggle-gated feature-package that captures
 * ideas/requests into named priority lists, scores them against a configurable
 * weighted criteria set (Weighted-Scoring engine + WSJF/RICE/ICE/Value-Effort
 * presets), ranks them, and turns a selection into a planning-session agenda.
 *
 * No parallel architecture: an idea IS a `host.kanban` card (statuses = columns,
 * terminal lanes + assignment via ADR 0049); the feature owns only the criteria
 * sets, per-idea score overlays, and planning sessions. The agenda composes the
 * `documents` feature's `board-agenda` kind (ADR 0053), degrading to inline
 * markdown when documents is OFF.
 *
 * RFC gate (ADR 0058): host-extension under /v1/host/openwop-app/priority-matrix/*,
 * composing core (host.kanban) + accepted feature surfaces. NO new RFC.
 *
 * All three FeatureModule faces ship (ADR 0014): the REST routes, the
 * `ctx.features.priority-matrix` workflow surface, and the `feature.priority-matrix
 * .{nodes,agents}` packs. The agent pack (Prioritization Analyst) tool-calls the
 * node pack over the surface — that IS the "AI-chat envelope" path in this host
 * (there is no separate envelope-acceptor seam; chat-drivability = agent + nodes).
 *
 * @see docs/adr/0058-priority-matrix.md
 */

import type { BackendFeature } from '../types.js';
import { registerTenantPurgeHook } from '../../host/hostExtPersistence.js';
import { registerPriorityMatrixRoutes } from './routes.js';
import { registerPriorityMatrixErasure } from './erasure.js';
import { buildPriorityMatrixSurface } from './surface.js';
import { purgeTenantPriorityMatrix, registerPriorityMatrixKanbanHooks } from './priorityMatrixService.js';
import { registerPriorityMatrixAgentTools } from './agentTools.js';

export const priorityMatrixFeature: BackendFeature = {
  id: 'priority-matrix',
  registerRoutes: (deps) => {
    // CFP-1 / ADR 0058 §chat-drivability — the Prioritization Analyst's REAL
    // conversational tools (three surface-backed reads + three proposal-safe
    // surface writes), the ADR 0308 D2 feature-registered-builtin seam.
    // Registration is process-wide + inert until the agent allowlists the ids;
    // per-tenant toggle honesty lives inside each tool's run().
    registerPriorityMatrixAgentTools();
    registerPriorityMatrixRoutes(deps);
    // R2 PM2-M5 — GDPR subject erasure over six subject-keyed collections, none of which
    // either ratchet can see. Registered unconditionally: an erasure must not depend on a
    // feature toggle being on today.
    registerPriorityMatrixErasure();
    // PMXWF-1 (ADR 0590) — tenant-TEARDOWN purge pre-hook: five overlay
    // collections are tenant-resolvable only through the list rows the generic
    // `purgeTenantHostExt` walk deletes, so the hook sweeps them FIRST.
    // Registered unconditionally, same reasoning as the eraser above.
    registerTenantPurgeHook('priority-matrix', purgeTenantPriorityMatrix);
    // PMXWF-10 (ADR 0667 D5) — an idea IS a kanban card, so kanban's OWN delete doors
    // are co-owners of PM state. These register the overlay cascade (card delete) and
    // the board claim the delete ROUTE consults before emptying a priority list.
    // Registered unconditionally, same reasoning as the two hooks above.
    registerPriorityMatrixKanbanHooks();
  },
  surface: { id: 'priority-matrix', build: buildPriorityMatrixSurface },
  toggleDefault: {
    id: 'priority-matrix',
    label: 'Priority Matrix',
    description:
      'Capture ideas and project requests into named priority lists, score them against a configurable weighted criteria set (1–10 slider weights; a Weighted-Scoring engine with WSJF / RICE / ICE / Value-Effort presets), and rank them. A planning session turns a selection into a meeting agenda. Statuses render as a Kanban board (it reuses host.kanban — an idea is a card; no parallel board). Workspace-scoped by default; a project id scopes a list to a project. ON by default (ADR 0229).',
    category: 'Leadership',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'priority-matrix',
  },
  requiredPacks: [
    { name: 'feature.priority-matrix.nodes', version: '1.5.0' },
    { name: 'feature.priority-matrix.agents', version: '1.0.1' },
  ],
  // ADR 0194 Phase 5 — a SOFT dependency (advisory, never a lock): the planning
  // agenda composes the Documents `board-agenda` kind (ADR 0053) when `documents`
  // is enabled, degrading to inline markdown otherwise (types.ts: "no hard
  // dependency"). The console suggests enabling `documents`; nothing breaks without it.
  recommends: ['documents'],
};
