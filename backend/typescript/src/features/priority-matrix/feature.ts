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
import { registerPriorityMatrixRoutes } from './routes.js';
import { buildPriorityMatrixSurface } from './surface.js';

export const priorityMatrixFeature: BackendFeature = {
  id: 'priority-matrix',
  registerRoutes: (deps) => registerPriorityMatrixRoutes(deps),
  surface: { id: 'priority-matrix', build: buildPriorityMatrixSurface },
  toggleDefault: {
    id: 'priority-matrix',
    label: 'Priority Matrix',
    description:
      'Capture ideas and project requests into named priority lists, score them against a configurable weighted criteria set (1–10 slider weights; a Weighted-Scoring engine with WSJF / RICE / ICE / Value-Effort presets), and rank them. A planning session turns a selection into a meeting agenda. Statuses render as a Kanban board (it reuses host.kanban — an idea is a card; no parallel board). Workspace-scoped by default; a project id scopes a list to a project. OFF by default.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'priority-matrix',
  },
  requiredPacks: [
    { name: 'feature.priority-matrix.nodes', version: '1.1.0' },
    { name: 'feature.priority-matrix.agents', version: '1.0.0' },
  ],
};
