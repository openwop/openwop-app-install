/**
 * Per-conversation capability scope + per-tool-call approval (ADR 0132). A NARROWING
 * filter over the agent's permitted tools for a single conversation (never widens;
 * ANDed into the ADR 0102 per-tool gate) + a per-tool require-approval flag that
 * suspends the live tool loop with the existing HITL interrupt card (ADR 0089). The
 * resolved effective scope is stamped in `run.metadata.capabilityScope` and read
 * verbatim on `:fork`. A `conversation-tools` toggle, off by default, per tenant.
 *
 * Phase 1 = the pure resolver + the stamp (this package's scopeResolver.ts +
 * capabilityScopeStamp.ts). Phase 2 = the loop hook. Phase 3 = the approval
 * interrupt. Phase 4 = REST (registerRoutes is a no-op until then). Phase 5 = FE.
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 */
import type { BackendFeature } from '../types.js';
import { registerConversationToolsRoutes } from './routes.js';

export const conversationToolsFeature: BackendFeature = {
  id: 'conversation-tools',
  // ADR 0132 Phase 4 — capability-scope + approval routes under the FEATURE
  // namespace (/v1/host/openwop-app/conversation-tools/sessions/:sessionId/*).
  registerRoutes: (deps) => { registerConversationToolsRoutes(deps); },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
