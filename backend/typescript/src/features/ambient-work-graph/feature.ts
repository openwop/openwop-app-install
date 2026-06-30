/**
 * Ambient Work Graph (ADR 0137) — opt-in mining of completed runs into recurring work
 * patterns → "you've done this N times, make it a workflow?" suggestions; accepting hands
 * the candidate to the ADR 0072 workflow-author draft. A read-only projection over the
 * run store (no new run model; the sweep rides the existing scheduler daemon, no new
 * queue). Privacy-sensitive → an `ambient-work-graph` toggle, OFF by default, per tenant.
 *
 * Phase 1 = the pure signature + clustering. Phase 2 = the suggestion store + the
 * scheduler sweep. Phase 3 = REST (accept → workflow-author). Phase 4 = FE.
 *
 * @see docs/adr/0137-ambient-work-graph.md
 */
import type { BackendFeature } from '../types.js';
import { registerAmbientWorkGraphRoutes } from './routes.js';

// ALWAYS-ON (toggle removed — graduation 2026-06-24). The suggestions page + on-demand
// "Scan now" are always available (tenant-scoped; tool-shape only, no message content).
// The BACKGROUND sweep daemon stays separately env-gated (OPENWOP_WORKGRAPH_SWEEP_ENABLED)
// — graduating the toggle does not auto-start continuous mining.
export const ambientWorkGraphFeature: BackendFeature = {
  id: 'ambient-work-graph',
  registerRoutes: (deps) => { registerAmbientWorkGraphRoutes(deps); },
};
