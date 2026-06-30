/**
 * ADR 0154 FU-6 — live chat-message delivery bus.
 *
 * `appendChatMessageLive` is the ONE chokepoint both channel message-append paths
 * use — the human post (`channelService.postChannelMessage`) and the agent reply
 * (`host/agentRunnerNode`) — so live delivery covers both uniformly. It persists
 * the message (the durable store stays the source of truth) and then publishes a
 * SMALL event (`{messageId}` — within Postgres NOTIFY's 8 KB limit; content is
 * fetched on reload, never put on the bus) on a PER-CONVERSATION logical channel,
 * so only that conversation's open streams are woken (no firehose / no client-side
 * filter). Delivery rides the existing host-ext pub/sub (Postgres LISTEN/NOTIFY
 * across instances, an in-process emitter on sqlite), so it works on the
 * multi-instance demo — unlike presence, which is deliberately per-instance.
 * Fire-and-forget: a publish failure never fails the append.
 */
import type { ChatMessageRecord } from '../types.js';
import { hostExtStorage, publishHostExtEvent, subscribeHostExtEvent } from './hostExtPersistence.js';

const CHAT_MESSAGE_PREFIX = 'hostext:chat:message:';

/** Persist a chat message AND publish a per-conversation live-delivery event. */
export async function appendChatMessageLive(record: ChatMessageRecord): Promise<void> {
  await hostExtStorage().appendChatMessage(record);
  void publishHostExtEvent(
    `${CHAT_MESSAGE_PREFIX}${record.sessionId}`,
    JSON.stringify({ messageId: record.messageId }),
  ).catch(() => undefined);
}

/** Subscribe to ONE conversation's message-appended events (cross-instance).
 *  Returns an async unsubscribe. */
export function subscribeConversationMessages(
  conversationId: string,
  cb: (messageId: string) => void,
): Promise<() => Promise<void>> {
  return subscribeHostExtEvent(`${CHAT_MESSAGE_PREFIX}${conversationId}`, (payload) => {
    try { cb((JSON.parse(payload) as { messageId: string }).messageId); } catch { /* skip malformed */ }
  });
}
