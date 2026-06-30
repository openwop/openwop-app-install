/**
 * Context economy (ADR 0148) — a HOST-INTERNAL token-efficiency feature.
 *
 * The Tier-A levers (provider prompt caching, tool-surface diet, transcript
 * budget, memory budget, transport economy) change only what bytes the host
 * feeds its own provider each iteration — no route, surface, pack, or wire.
 *
 * This BackendFeature exists ONLY to register the `context-economy` toggle so
 * the feature is visible/governable in the admin toggle console. It does NOT
 * gate dispatch-layer behavior: the dispatch layer is tenant-agnostic and reads
 * the env-config source-of-truth in `host/contextEconomy.ts`
 * (`OPENWOP_CONTEXT_ECONOMY*`). Keep that split — wiring the per-tenant toggle
 * into provider dispatch would couple the tenant model into a layer that has
 * (by design) none.
 *
 * @see docs/adr/0148-context-economy-token-budgeted-host-assembly.md
 */
import type { BackendFeature } from '../types.js';

export const contextEconomyFeature: BackendFeature = {
  id: 'context-economy',
  // Host-internal: no HTTP surface. Behavior is governed by env config, not routes.
  registerRoutes: () => {},
  toggleDefault: {
    id: 'context-economy',
    label: 'Context economy',
    description:
      'Token-efficiency for host-internal context assembly — provider prompt caching, tool-surface diet, transcript + memory budgets, transport economy (ADR 0148, Tier A). Governed by OPENWOP_CONTEXT_ECONOMY* env config; this toggle is for visibility.',
    category: 'Admin',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'context-economy',
  },
};
