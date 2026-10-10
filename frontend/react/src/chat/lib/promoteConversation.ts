/**
 * ADR 0768 P4 — "Continue in full chat": promote an EPHEMERAL embedded
 * conversation (persist:false, ADR 0073) to a real rail conversation, on the
 * user's explicit request only.
 *
 * Why promote-on-click rather than persist every embed: embeds deliberately
 * never write a rail row (pinned by useChatSession.integration.test —
 * "persist:false writes NO backend session/messages"), so a builder session
 * does not clutter the user's conversations. The live RFC 0005 conversation
 * run DOES exist server-side and was opened with `chatSessionId: session.id`,
 * so promoting means creating the row that points at THAT run — the agent's
 * context and any pending interrupt carry over. Replaying the transcript into
 * a new session would mint a new run and lose both.
 *
 * STRICT where the write-through path is best-effort: a partially-copied
 * transcript opening in the full chat would misrepresent the conversation. Any
 * failure throws; the caller stays put and says so. Every step is idempotent
 * (409s count as done), so a retry finishes what a failed attempt started.
 */

import {
  appendChatMessage,
  createChatSession,
  setConversationRun,
  updateChatMessage,
} from '../../client/chatSessionsClient.js';
import type { ChatMessage } from '../types.js';

/** The store encoding of a message — the ONE definition, shared with the
 *  write-through persistence path so a promoted conversation reopens exactly
 *  like one that was persisted turn by turn. */
export function encodeMessageForStore(msg: ChatMessage): { messageId: string; role: string; content: string; meta?: string } {
  const { id: _id, meta, ...rest } = msg;
  return {
    messageId: msg.id,
    role: msg.role,
    content: JSON.stringify(rest),
    ...(meta ? { meta: JSON.stringify(meta) } : {}),
  };
}

const isConflict = (err: unknown): boolean =>
  err instanceof Error && /idempotency_key_conflict|already exists|\b409\b/.test(err.message);

export interface PromotableSession {
  id: string;
  title: string;
  messages: readonly ChatMessage[];
  conversationRunId?: string | undefined;
}

/** Create the rail row, bind it to the existing run, copy the settled
 *  transcript, and name the scoped agent as a participant. Returns the id to
 *  deep-link (`/?conversation=<id>`). Throws on any non-idempotent failure. */
export async function promoteConversation(session: PromotableSession, agentId?: string): Promise<string> {
  try {
    await createChatSession({
      sessionId: session.id,
      title: session.title,
      ...(agentId ? { participants: [`agent:${agentId}`] } : {}),
    });
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
  if (session.conversationRunId) await setConversationRun(session.id, session.conversationRunId);
  // A streaming bubble is not settled content; the run's next reconcile in the
  // full chat brings it in. Everything else — errors, run cards, interrupts —
  // is part of the transcript the user saw.
  for (const msg of session.messages) {
    if (msg.isStreaming) continue;
    const enc = encodeMessageForStore(msg);
    try {
      await appendChatMessage(session.id, enc);
    } catch (err) {
      if (!isConflict(err)) throw err;
      await updateChatMessage(session.id, msg.id, { content: enc.content, ...(enc.meta ? { meta: enc.meta } : {}) });
    }
  }
  return session.id;
}
