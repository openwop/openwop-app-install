/**
 * Channel membership domain events (ADR 0202 OQ-3) — a thin, typed wrapper over the
 * host-ext pub/sub (`publishHostExtEvent` / `subscribeHostExtEvent`, Postgres
 * LISTEN/NOTIFY cross-instance, in-process on sqlite/memory).
 *
 * This lets `channels` SIGNAL a membership change and `scheduled-agent-chats` REACT to
 * it WITHOUT either feature importing the other — both touch only `host/`. That keeps
 * the one-way `scheduled-agent-chats → channels` edge intact (no import cycle) while
 * still letting agent-removal clean up that agent's scheduled channel posts.
 *
 * Delivery is best-effort at-most-once (a listener disconnected at publish time misses
 * the event, no redelivery); subscribers MUST make their handler idempotent, since the
 * NOTIFY is broadcast to every instance.
 */
import { publishHostExtEvent, subscribeHostExtEvent } from './hostExtPersistence.js';

const CHANNEL_AGENT_REMOVED = 'hostext:channel:agent-removed';

/** An agent was removed as a member of a channel (explicit remove; the owner's
 *  action). Carries only ids — no PII, safe on the NOTIFY wire. */
export interface ChannelAgentRemoved { tenantId: string; channelId: string; agentId: string }

/** Fire-and-forget: publish that an agent left a channel's membership. */
export function publishChannelAgentRemoved(evt: ChannelAgentRemoved): void {
  void publishHostExtEvent(CHANNEL_AGENT_REMOVED, JSON.stringify(evt));
}

/** Subscribe to agent-removed events. Malformed payloads are skipped, not thrown.
 *  Returns the unsubscribe handle. */
export function subscribeChannelAgentRemoved(handler: (evt: ChannelAgentRemoved) => void): Promise<() => Promise<void>> {
  return subscribeHostExtEvent(CHANNEL_AGENT_REMOVED, (payload) => {
    try {
      const e = JSON.parse(payload) as Partial<ChannelAgentRemoved>;
      if (typeof e.tenantId === 'string' && typeof e.channelId === 'string' && typeof e.agentId === 'string') {
        handler({ tenantId: e.tenantId, channelId: e.channelId, agentId: e.agentId });
      }
    } catch { /* skip malformed */ }
  });
}
