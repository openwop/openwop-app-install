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
import { registerIntentLedgerAgentTools } from './agentTools.js';
import { onConversationDeleted } from '../../host/conversationLifecycle.js';
import { deleteLedgerForConversation, registerIntentLedgerErasure } from './ledgerStore.js';

// ALWAYS-ON (toggle removed — graduation 2026-06-24). A no-op until a user drafts +
// approves a mission contract for a conversation; the chat-header "Mission" button +
// the on-demand "Draft from conversation" action are always available.
export const intentLedgerFeature: BackendFeature = {
  id: 'intent-ledger',
  registerRoutes: (deps) => {
    registerIntentLedgerRoutes(deps);
    registerIntentLedgerAgentTools(); // XCH-HOLE-7 (round 3) — openwop:intent-ledger.get (ADR 0308 seam)
    // ADR 0288 P2 — a mission ledger for a deleted conversation is meaningless;
    // point-delete it (the run-stamped copy in run.metadata stays, replay-honest).
    onConversationDeleted('intent-ledger', async ({ tenantId, conversationId }) => {
      await deleteLedgerForConversation(tenantId, conversationId);
    });
    // CONS-16 — the DSAR eraser. `IntentLedger.approvedBy` is a `User.userId`,
    // so the row IS addressable by a principal-keyed DSAR; the old exemption
    // claimed otherwise. Registered unconditionally (this feature is always-on
    // anyway) — an erasure obligation is never toggle-gated.
    registerIntentLedgerErasure();
  },
};
