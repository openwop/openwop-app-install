/**
 * Run/task deck (ADR 0133) — a read-only projection over runs + delegated sub-runs,
 * bucketed pending/running/blocked/delegated/completed/failed. No new store, no
 * tasks table ([[no-parallel-architecture]]); a task is a view of an existing run.
 * A `task-deck` toggle, off by default, per tenant.
 *
 * @see docs/adr/0133-run-task-deck.md
 */
import type { BackendFeature } from '../types.js';
import { registerTaskDeckRoutes } from './routes.js';

export const taskDeckFeature: BackendFeature = {
  id: 'task-deck',
  registerRoutes: (deps) => { registerTaskDeckRoutes(deps); },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
