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
import { subscribeChannelAgentRemoved } from '../../host/channelMembershipEvents.js';
import { deleteScheduledChatsForAgent, pauseScheduledChatsForDeletedAgent } from './scheduledChatService.js';
import { onRosterMemberDeleted } from '../../host/rosterLifecycle.js';
import { registerScheduledFollowupTool, registerScheduledRecurringTool } from './agentTools.js';
import { registerAgentTurnFallback } from '../../host/heartbeatService.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID, SCHEDULED_CHAT_CREDENTIAL_REF } from './scheduledChatTurnWorkflow.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.scheduled-agent-chats');

export const scheduledAgentChatsFeature: BackendFeature = {
  id: 'scheduled-agent-chats',
  // ADR 0125 Phase 2b — register the built-in turn-workflow at boot (idempotent) so a
  // scheduled chat fires out-of-the-box; `createScheduledChat` defaults to it.
  registerRoutes: (deps) => {
    registerScheduledChatRoutes(deps);
    seedScheduledChatTurnWorkflow();
    // ADR 0313 D2 — hand the heartbeat its bare-card fallback workflow (the
    // fill-a-seam registration; core never imports this feature).
    registerAgentTurnFallback({ workflowId: SCHEDULED_CHAT_TURN_WORKFLOW_ID, credentialRef: SCHEDULED_CHAT_CREDENTIAL_REF });
    // ADR 0309 — the `openwop:tasks.schedule-followup` agent tool (one-shot job
    // over this feature's turn-workflow; allowlist default-deny + firewall
    // unchanged via the ADR 0308 D2 seam).
    registerScheduledFollowupTool();
    // chat-first-port A3 — the `openwop:tasks.schedule-recurring` sibling: a
    // recurring cron chat created from chat (same turn-workflow, no parallel
    // scheduler), so scheduled chats are creatable where the user asks for them.
    registerScheduledRecurringTool();
    // ADR 0288 — pause (never delete) this feature's chats when their roster
    // member is deleted; the scheduler job disables with them.
    onRosterMemberDeleted('scheduled-agent-chats', async ({ tenantId, rosterId, agentId }) => {
      await pauseScheduledChatsForDeletedAgent(tenantId, { rosterId, ...(agentId ? { agentId } : {}) });
    });
    // ADR 0202 OQ-3 — when a channel owner removes an agent, delete that agent's
    // scheduled posts in the channel so they stop firing. Subscribed via the host-ext
    // bus (no import back into channels → the scheduled→channels edge stays one-way).
    subscribeChannelAgentRemoved((evt) => {
      void deleteScheduledChatsForAgent(evt.tenantId, evt.channelId, evt.agentId)
        .then((n) => { if (n > 0) log.info('scheduled_posts_cleaned_on_agent_removal', { channelId: evt.channelId, agentId: evt.agentId, count: n }); })
        .catch((err) => log.warn('scheduled_post_cleanup_failed', { channelId: evt.channelId, agentId: evt.agentId, error: String(err) }));
    }).catch((err) => log.warn('channel_membership_subscribe_failed', { error: String(err) }));
  },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
