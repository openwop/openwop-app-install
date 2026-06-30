/**
 * Recurring / scheduled agent chats (ADR 0125, backlog B16). Binds an agent +
 * cadence + prompt to a conversation; the recurring tick enqueues a chat-turn
 * through the EXISTING scheduler daemon (ADR 0025 / RFC 0052). A
 * `scheduled-agent-chats` toggle, off by default, bucketed per TENANT (a B2B
 * automation surface).
 *
 * @see docs/adr/0125-recurring-scheduled-agent-chats.md
 */
import type { BackendFeature } from '../types.js';
import { registerScheduledChatRoutes } from './routes.js';
import { seedScheduledChatTurnWorkflow } from './scheduledChatTurnWorkflow.js';

export const scheduledAgentChatsFeature: BackendFeature = {
  id: 'scheduled-agent-chats',
  // ADR 0125 Phase 2b — register the built-in turn-workflow at boot (idempotent) so a
  // scheduled chat fires out-of-the-box; `createScheduledChat` defaults to it.
  registerRoutes: (deps) => { registerScheduledChatRoutes(deps); seedScheduledChatTurnWorkflow(); },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
