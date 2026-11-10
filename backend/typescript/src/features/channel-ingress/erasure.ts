/**
 * ADR 1042 D8 — subject erasure (ADR 0464) for the channel core's stores.
 *
 * Two kinds of subject live here, and one eraser handles both, because a
 * `SubjectEraser` is handed one key and does not know which kind it is:
 *
 *  • An APP USER who owns channel threads (`ownerUserId` on approved senders,
 *    threads and owed replies). Matched through `subjectKeyForms`, the same
 *    spellings every other eraser uses (`user:<id>`, the bare id, …).
 *  • An EXTERNAL PERSON writing in from a channel (a WhatsApp E.164 number, a
 *    Telegram/Slack/Discord user id, a relay peer). Matched EXACTLY on
 *    `senderId` or `chatId`: no normalisation, no prefix or substring match, so a
 *    key cannot reach a different person's rows.
 *
 * Per store:
 *  • `channel-ingress:sender`  — DELETED. The row is an approval about one
 *    person; erasing either side ends it (the owner can no longer be the paired
 *    owner; the external sender is no longer approved).
 *  • `channel-ingress:pending` — DELETED. It is only "this person wrote in".
 *  • `channel-ingress:thread`  — for the OWNER, or for the one external person of
 *    a one-to-one chat (matched on the chat id OR on the senders seen there, since a
 *    Slack DM's chat id is not the person's id): DELETED, together with the main-chat
 *    conversation it created (the chat session and every message in it, and the
 *    conversation meta). For one writer in a GROUP: only their messages are redacted
 *    in place (security review M5), and the group conversation stays. The transcript is the external person's words and the owner's
 *    agent's replies, nothing else; the generic chat-post eraser would NOT reach
 *    it, because those rows carry no `authorSubject` (they were written by the
 *    host, not by a signed-in author).
 *  • `channel-ingress:reply`   — DELETED. An owed reply to an erased person must
 *    never be sent.
 *  • `channel-ingress:settings` — no subject (agent id, bot handle, model).
 *
 * Runs (round 3): a deleted DM or owner thread also deletes every conversation run
 * it opened (`runIds`), which deletes their event logs. Residual, GROUPS only: an
 * erased group writer's turns stay in the group run's `conversation.exchanged`
 * events (fenced text + `sender="…"`), since this host has no per-event redaction
 * path; they live until the run is deleted or retained out.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { deleteConversationMeta } from '../../host/conversationStore.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { channelIngressStores, deleteChannelConversationMarker } from './stores.js';

/** The placeholder a redacted group message keeps (the row stays: other people's thread order). */
export const ERASED_CHANNEL_MESSAGE = '[message removed: the sender\'s data was erased]';

/** Did `senderId` write this stored transcript message? (The ingress stamps `meta.channelSender`.) */
function writtenBy(meta: string | null, senderId: string): boolean {
  if (!meta) return false;
  try {
    const m = JSON.parse(meta) as { channelSender?: { senderId?: unknown } };
    return m.channelSender?.senderId === senderId;
  } catch { return false; }
}

export async function eraseChannelIngressSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const owner = subjectKeyForms(subjectKey).forms;
  const external = (id: string | undefined): boolean => id !== undefined && id === subjectKey;
  const s = channelIngressStores;
  const storage = hostExtStorage();
  let rowsTouched = 0;

  for (const row of await s.senders.listForTenantIndexed(tenantId)) {
    if (owner.has(row.ownerUserId) || external(row.senderId)) { await s.senders.delete(row.key); rowsTouched += 1; }
  }
  for (const row of await s.pending.listForTenantIndexed(tenantId)) {
    if (external(row.senderId) || external(row.chatId)) { await s.pending.delete(row.key); rowsTouched += 1; }
  }
  for (const row of await s.replies.listForTenantIndexed(tenantId)) {
    if (owner.has(row.ownerUserId) || external(row.chatId) || external(row.senderId)) { await s.replies.delete(row.exchangeKey); rowsTouched += 1; }
  }
  // Review M5 — the uncapped who-wrote-where index: every thread this person ever
  // wrote in, however early (the old capped list kept only the latest 50).
  const wroteIn = new Set<string>();
  // CHAN-F5 — the OTHER writers' index rows, by thread, so a thread this erasure
  // deletes takes its whole index with it. Without this, erasing an owner left
  // every outsider's (lane, sender, thread) row pointing at a deleted thread: the
  // only part of the index that grew without bound, and outsider ids kept for
  // nothing. Deliberately NOT a sweep of rows whose thread is missing: ingress
  // writes the index row BEFORE the thread (`ensureThread`), so such a sweep
  // would race a first message and lose its writer from the index.
  const othersByThread = new Map<string, string[]>();
  for (const r of await s.senderThreads.listForTenantIndexed(tenantId)) {
    if (!external(r.senderId)) {
      const keys = othersByThread.get(r.threadKey);
      if (keys) keys.push(r.key); else othersByThread.set(r.threadKey, [r.key]);
      continue;
    }
    wroteIn.add(r.threadKey);
    await s.senderThreads.delete(r.key);
    rowsTouched += 1;
  }
  for (const row of await s.threads.listForTenantIndexed(tenantId)) {
    const wroteHere = wroteIn.has(row.threadKey);
    const ownersThread = owner.has(row.ownerUserId);
    // A one-person chat IS that person's conversation (a DM's chat id is often not
    // their id — a Slack `D…` channel — so the senders seen there count too).
    const theirDm = !row.isGroup && (external(row.chatId) || wroteHere);
    if (ownersThread || theirDm) {
      // The conversation it created goes with it: messages, header, meta, and every
      // conversation run it opened (deleting a run deletes its event log too).
      await storage.deleteChatSession(tenantId, row.conversationId);
      await deleteConversationMeta(tenantId, row.conversationId);
      for (const runId of new Set([...(row.runIds ?? []), ...(row.runId ? [row.runId] : [])])) {
        const run = await storage.getRun(runId);
        if (run && run.tenantId === tenantId) await storage.deleteRun(runId);
      }
      await deleteChannelConversationMarker(tenantId, row.conversationId);
      await s.threads.delete(row.threadKey);
      rowsTouched += 1;
      // Housekeeping, not this subject's rows, so not counted in rowsTouched.
      for (const key of othersByThread.get(row.threadKey) ?? []) await s.senderThreads.delete(key);
      continue;
    }
    if (!row.isGroup || !wroteHere) continue;
    // A group: only THEIR messages go (redacted in place, so the others' thread
    // keeps its order); the group conversation stays.
    for (const m of await storage.listChatSessionMessages(row.conversationId)) {
      if (m.role !== 'user' || !writtenBy(m.meta, subjectKey)) continue;
      await storage.updateChatMessageContent(row.conversationId, m.messageId, JSON.stringify({ role: 'user', content: ERASED_CHANNEL_MESSAGE }), null);
      rowsTouched += 1;
    }
  }
  return { rowsTouched };
}

/** Called from the feature's `registerRoutes` (idempotent: the seam dedupes by reference). */
export function registerChannelIngressErasure(): void {
  registerSubjectEraser(eraseChannelIngressSubject);
  // Entity-scoped only: `chatId`, `senderId` and `label` are generic names other
  // entities use for non-personal values, so they must not mask globally.
  const local = { maskGloballyByFieldName: false } as const;
  declarePiiFields('channel-ingress:sender', ['senderId', 'ownerUserId', 'label'], local);
  declarePiiFields('channel-ingress:pending', ['senderId', 'chatId'], local);
  declarePiiFields('channel-ingress:thread', ['ownerUserId', 'chatId'], local);
  declarePiiFields('channel-ingress:sender-thread', ['senderId'], local);
  declarePiiFields('channel-ingress:reply', ['ownerUserId', 'chatId', 'senderId'], local);
}
