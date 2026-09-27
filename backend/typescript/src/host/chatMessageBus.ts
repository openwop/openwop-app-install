/**
 * ADR 0154 FU-6 / ADR 0192 D6 — live chat-message delivery bus + the
 * multi-party append post-processing choke-point.
 *
 * The ADR 0192 architect pass falsified the old header's "ONE chokepoint"
 * claim: seven append paths existed, five bypassing this bus. The corrected
 * contract: every append that can land in a MULTI-PARTY conversation
 * (`channel`/`group`) flows through here — the channel post
 * (`channelService.postChannelMessage`), the agent reply
 * (`host/agentRunnerNode`), the generic route's group appends
 * (`routes/chatSessions.ts`, channels are DENIED there), and workflow
 * `ctx.chat.sendMessage` (`host/chatSurface.ts`, via
 * `publishChatMessageAppended` after its own idempotent append). The
 * remaining direct-storage paths (voice sideband, chat-import, branch-seed)
 * are 1:1 / fresh-session and documented in ADR 0192's append-path table.
 *
 * Post-append work here:
 *  1. publish a SMALL live-delivery event (`{messageId}` — within Postgres
 *     NOTIFY's 8 KB limit) on a per-conversation channel;
 *  2. ADR 0192 D6 — stamp mention counters for multi-party conversations
 *     (`@channel` → every human participant except the author, CAS-guarded).
 * Both are fire-and-forget: they never fail the append.
 */
import type { ChatMessageRecord } from '../types.js';
import { hostExtStorage, publishHostExtEvent, subscribeHostExtEvent } from './hostExtPersistence.js';
import { extractMessageText } from './chatMessageText.js';
import { notifyChannelActivity } from './channelActivityNotify.js';
import { getConversationMeta } from './conversationStore.js';
import { bumpMentionCounts } from './conversationReadState.js';
import { createLogger } from '../observability/logger.js';

const CHAT_MESSAGE_PREFIX = 'hostext:chat:message:';
const log = createLogger('host.chatMessageBus');

/** The broadcast token — `@channel` addresses every human member (ADR 0192 D6;
 *  per-user mention tokens are deliberately out of scope, OQ-2). */
const BROADCAST_MENTION = /(^|\W)@channel(\W|$)/i;

// ADR 0192 D5 — THE canonical message-text extractor now lives in its own module
// (`chatMessageText`, imported at the top) so the channel-activity notifier can use
// it without an import cycle back here; re-exported so existing importers
// (`channelService`, tests) are unchanged.
export { extractMessageText };

/** ADR 0192 D6 — post-append mention stamping for multi-party conversations.
 *  Best-effort; a failure is logged and never fails the append. Applies to
 *  EVERY bus append — an AGENT reply containing `@channel` also bumps the
 *  human members' mention tier (deliberate: an agent flagging the room is a
 *  signal too). */
async function stampMentions(tenantId: string | undefined, record: ChatMessageRecord): Promise<void> {
  try {
    if (!tenantId) return;
    // Cheap regex FIRST — the overwhelmingly common no-@channel append (every
    // workflow ctx.chat.sendMessage) must not pay a kv meta read.
    if (!BROADCAST_MENTION.test(extractMessageText(record.content))) return;
    const meta = await getConversationMeta(tenantId, record.sessionId);
    if (!meta || (meta.type !== 'channel' && meta.type !== 'group')) return;
    const targets = (meta.participants ?? [])
      .filter((p) => p.subjectRef.startsWith('user:') && p.subjectRef !== record.authorSubject)
      .map((p) => p.subjectRef);
    // The channel owner is not stored as a participant (channelService §owner);
    // include them so their mention badge works too.
    if (meta.ownerUserId) {
      const ownerRef = `user:${meta.ownerUserId}`;
      if (ownerRef !== record.authorSubject && !targets.includes(ownerRef)) targets.push(ownerRef);
    }
    if (targets.length) await bumpMentionCounts(tenantId, record.sessionId, targets);
  } catch (err) {
    log.warn('mention_stamp_failed', { sessionId: record.sessionId, error: String(err) });
  }
}

/** Publish the live-delivery event + run post-append processing for an
 *  ALREADY-PERSISTED message. Exported so append paths with their own persist
 *  semantics (chatSurface's idempotent append, the generic route's transaction)
 *  converge on ONE post-processing implementation instead of bypassing it. */
export function publishChatMessageAppended(record: ChatMessageRecord, tenantId?: string): void {
  void publishHostExtEvent(
    `${CHAT_MESSAGE_PREFIX}${record.sessionId}`,
    JSON.stringify({ messageId: record.messageId }),
  ).catch(() => undefined);
  void stampMentions(tenantId, record);
  // ADR 0214 — an AGENT post to a channel notifies its members (mute-filtered,
  // batched web-push). Internally guarded + best-effort; a no-op for the common
  // human/workflow append.
  notifyChannelActivity(tenantId, record);
}

/** ADR 0195 — PUBLISH-ONLY frame for non-append lifecycle events (edit /
 *  tombstone / reaction). Deliberately does NOT run `stampMentions`: an edit
 *  re-running the `@channel` scan would re-bump every member's mention counter
 *  on each touch-up save (edits never re-notify — the gate-corrected Slack
 *  posture). `kind` is forward-compat metadata: today's subscribers reload on
 *  any frame and re-fetch the durable state, so nothing consumes it yet. */
export function publishConversationFrame(kind: 'updated' | 'deleted' | 'reaction', sessionId: string, messageId: string): void {
  void publishHostExtEvent(
    `${CHAT_MESSAGE_PREFIX}${sessionId}`,
    JSON.stringify({ messageId, kind }),
  ).catch(() => undefined);
}

/** Persist a chat message AND run the post-append processing (live-delivery
 *  publish + mention stamping). `tenantId` enables the multi-party lookups;
 *  callers that can supply it should. */
export async function appendChatMessageLive(record: ChatMessageRecord, tenantId?: string): Promise<void> {
  await hostExtStorage().appendChatMessage(record);
  publishChatMessageAppended(record, tenantId);
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
