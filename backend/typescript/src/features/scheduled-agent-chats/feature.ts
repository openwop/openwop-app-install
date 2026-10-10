/**
 * Recurring / scheduled agent chats (ADR 0125, backlog B16). Binds an agent +
 * cadence + prompt to a conversation; the recurring tick enqueues a chat-turn
 * through the EXISTING scheduler daemon (ADR 0025 / RFC 0052).
 *
 * Toggle: `scheduled-agent-chats`, default ON, per TENANT. ADR 0820 §8.2
 * restored it (it had graduated to always-on) so the feature can be sold in the
 * Agents bundle. It gates the routes and both agent tools, and every scheduler
 * job this feature registers carries `featureId`, so the daemon skips its fires
 * while the feature is refused (ADR 0599 §6; non-destructive — re-enabling resumes).
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
import { SCHEDULED_AGENT_CHATS_TOGGLE } from './scheduledChatService.js';
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
  toggleDefault: {
    id: SCHEDULED_AGENT_CHATS_TOGGLE,
    label: 'Scheduled agent chats',
    description:
      'Recurring and one-off agent chats on a schedule — an agent posts into a conversation or channel on its cadence, and agents can schedule follow-ups from chat. Turn OFF to pause every schedule (they resume when turned back ON).',
    category: 'Agents',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'scheduled-agent-chats',
  },
};
