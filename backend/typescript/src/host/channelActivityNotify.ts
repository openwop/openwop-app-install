/**
 * Channel-activity notifier (ADR 0214 D1) — turns an AGENT post to a channel into
 * addressed notifications for the channel's human members, so they learn about agent
 * activity they didn't trigger (a scheduled digest, an `'all'`-policy reply).
 *
 * Invoked from `chatMessageBus.publishChatMessageAppended`, the one post-append choke
 * both the agent-runner conversation projection and the channel post path converge on.
 * Best-effort: a failure is logged and never affects the append.
 *
 * Scope: AGENT-authored CHANNEL messages only (human messages don't notify — that's a
 * separate, larger feature). Recipients are filtered through the mute policy
 * (`isNotificationMuted` — globalMute / per-conversation / per-type, ADR 0214 D2) BEFORE
 * insert, and delivered via the BATCHED emit (one subscription-table scan, ADR 0214 D3).
 */
import type { ChatMessageRecord } from '../types.js';
import { getConversationMeta } from './conversationStore.js';
import { getNotificationEmitter } from '../notifications/emitter.js';
import { isNotificationMuted } from './notificationPolicy.js';
import { resolveSubjectDisplays } from './subjectDisplay.js';
import { extractMessageText } from './chatMessageText.js'; // NOT chatMessageBus — that would re-form the cycle
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.channelActivityNotify');

/** Open `NotificationType` value (no union edit); mirrored nowhere else — the prefs
 *  UI mutes it via per-conversation mute, not a per-type toggle (ADR 0214). */
export const CHANNEL_POST_NOTIFICATION_TYPE = 'chat.channel_post';
const SNIPPET_MAX = 140;

export function notifyChannelActivity(tenantId: string | undefined, record: ChatMessageRecord): void {
  // Cheap guards first — only an AGENT-authored post notifies; the overwhelmingly
  // common human/workflow append pays nothing beyond this check.
  if (!tenantId || !record.authorSubject || !record.authorSubject.startsWith('agent:')) return;
  const authorSubject = record.authorSubject;
  void (async () => {
    const meta = await getConversationMeta(tenantId, record.sessionId);
    if (!meta || meta.type !== 'channel') return;

    // Human members + the owner (not stored as a participant), minus the author
    // (an agent, so every human is a candidate recipient).
    const userIds = new Set<string>();
    for (const p of meta.participants ?? []) {
      if (p.subjectRef.startsWith('user:')) userIds.add(p.subjectRef.slice('user:'.length));
    }
    if (meta.ownerUserId) userIds.add(meta.ownerUserId);
    if (userIds.size === 0) return;

    // Drop muted recipients BEFORE building/inserting — a fully-muted channel costs
    // nothing. NOTIF-4 — the per-recipient mute lookups run concurrently.
    const candidates = [...userIds];
    const muteFlags = await Promise.all(candidates.map((uid) =>
      isNotificationMuted(tenantId, uid, { conversationId: record.sessionId, type: CHANNEL_POST_NOTIFICATION_TYPE, priority: 'normal' })));
    const recipients = candidates.filter((_, i) => !muteFlags[i]);
    const suppressed = candidates.length - recipients.length;
    if (recipients.length === 0) {
      // NOTIF-5 — observe fan-out even when everyone's muted (a mute rate of 100%).
      if (suppressed > 0) log.info('channel_activity_notify', { conversationId: record.sessionId, notified: 0, suppressed });
      return;
    }

    const display = await resolveSubjectDisplays(tenantId, [authorSubject]);
    const agentName = display.get(authorSubject)?.displayName ?? 'An agent';
    const channelName = meta.channel?.name ? `#${meta.channel.name}` : 'a channel';
    const snippet = extractMessageText(record.content).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);

    await getNotificationEmitter().emitMany(recipients.map((uid) => ({
      tenantId,
      recipientUserId: uid,
      type: CHANNEL_POST_NOTIFICATION_TYPE,
      priority: 'normal' as const,
      title: channelName,
      message: snippet ? `${agentName}: ${snippet}` : `${agentName} posted`,
      actionUrl: `/chat?conversation=${encodeURIComponent(record.sessionId)}`, // '/' is the Dashboard now (2026-07-16); legacy '/?conversation=' urls still redirect
      metadata: { conversationId: record.sessionId, authorSubject },
    })));
    // NOTIF-5 — fan-out + suppression counts for prod observability.
    log.info('channel_activity_notify', { conversationId: record.sessionId, notified: recipients.length, suppressed });
  })().catch((err) => log.warn('channel_activity_notify_failed', { sessionId: record.sessionId, error: String(err) }));
}
