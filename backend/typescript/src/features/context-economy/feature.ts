/**
 * Context economy (ADR 0148) — a HOST-INTERNAL token-efficiency feature.
 *
 * The Tier-A levers (provider prompt caching, tool-surface diet, transcript
 * budget, memory budget, transport economy) change only what bytes the host
 * feeds its own provider each iteration — no route, surface, pack, or wire.
 * They are governed by `OPENWOP_CONTEXT_ECONOMY*` env config, read at each
 * decision site via `host/contextEconomy.ts`.
 *
 * § Correction (ADR 0434) — the `context-economy` toggle was RETIRED, not
 * graduated. It existed "only to register the toggle so the feature is
 * visible/governable in the admin toggle console", while explicitly NOT gating
 * dispatch (the dispatch layer is tenant-agnostic by design and must stay so).
 * The result was a LYING SWITCH: a superadmin could flip it and observe exactly
 * zero effect, in either direction. That is worse than absent — a control that
 * appears authoritative but is inert misinforms the operator about what governs
 * their bytes and their spend.
 *
 * The visibility need was real, so it moved to a control that cannot lie:
 * `GET /v1/host/openwop-app/feature-toggles/admin/env-governed` reports the
 * RESOLVED env state (master + each lever, with the env var that owns it) as a
 * read-only row in the same admin console. Same discoverability, honest
 * authority — the operator lever is the deploy env, and the console now says so
 * instead of pretending to own it. Keep the split: wiring a per-tenant toggle
 * into provider dispatch would couple the tenant model into a layer that has
 * (by design) none.
 *
 * @see docs/adr/0148-context-economy-token-budgeted-host-assembly.md
 * @see docs/adr/0434-graduate-substrate-toggles.md
 */
import type { BackendFeature } from '../types.js';

export const contextEconomyFeature: BackendFeature = {
  id: 'context-economy',
  // Host-internal: no HTTP surface. Behavior is governed by env config, not routes;
  // the read-only admin projection lives on the feature-toggles admin surface.
  registerRoutes: () => {},
  // No toggleDefault — retired as an inert switch (§ Correction above).
};
