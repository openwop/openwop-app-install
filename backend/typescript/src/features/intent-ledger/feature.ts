/**
 * Intent Ledger (ADR 0136) — a reviewable pre-flight mission contract (goal / allowed /
 * forbidden / approvals / success-criteria / expiry) drafted for complex requests; it
 * PROJECTS onto the ADR 0132 capability scope (enforcement reused) + adds success
 * criteria, a relative-TTL expiry, and an authored-vs-completed reckoning. An
 * `intent-ledger` toggle, off by default, per tenant.
 *
 * Phase 1 = the pure projection + stamp. Phase 2 = entity + extractor + complexity gate.
 * Phase 3 = REST + the out_of_mandate expiry term (registerRoutes a no-op until then).
 * Phase 4 = run-end reckoning. Phase 5 = FE.
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import type { BackendFeature } from '../types.js';
import { registerIntentLedgerRoutes } from './routes.js';

// ALWAYS-ON (toggle removed — graduation 2026-06-24). A no-op until a user drafts +
// approves a mission contract for a conversation; the chat-header "Mission" button +
// the on-demand "Draft from conversation" action are always available.
export const intentLedgerFeature: BackendFeature = {
  id: 'intent-ledger',
  registerRoutes: (deps) => { registerIntentLedgerRoutes(deps); },
};
