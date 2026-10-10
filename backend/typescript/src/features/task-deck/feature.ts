/**
 * Run/task deck (ADR 0133) — a read-only projection over runs + delegated sub-runs,
 * bucketed pending/running/blocked/delegated/completed/failed. No new store, no
 * tasks table ([[no-parallel-architecture]]); a task is a view of an existing run.
 *
 * ALWAYS-ON (ADR 0820 §8.6 / core-audit M8 correction): the `task-deck` toggle this header
 * used to describe was removed when the feature graduated (ADR 0134 / 2026-06-24);
 * there is no per-tenant switch. Gating is RBAC and visibility only.
 *
 * @see docs/adr/0133-run-task-deck.md
 */
import type { BackendFeature } from '../types.js';
import { registerTaskDeckAgentTools } from './agentTools.js';
import { registerTaskDeckRoutes } from './routes.js';

export const taskDeckFeature: BackendFeature = {
  id: 'task-deck',
  registerRoutes: (deps) => {
    registerTaskDeckRoutes(deps);
    registerTaskDeckAgentTools(deps.storage); // XCH-HOLE-4 (Wave 4) — openwop:tasks.deck (ADR 0308 seam)
  },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
