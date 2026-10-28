/**
 * ADR 0996 — artifacts a CHAT TOOL produced are as private as the chat.
 *
 * The code tool (`chat-code:`) and the interactive render tool (`chat-viz:`)
 * persist their output as run-event artifacts under a synthetic runId. Every
 * run-event row is stored with `orgId = tenantId`, so the Library's org gate
 * listed an artifact made in a member's PRIVATE conversation to every member of
 * the workspace, and `GET /artifacts/:id` served its content.
 *
 * This module is the one place both halves agree on: the producers mint the
 * runId with {@link chatArtifactRunId}, and every reader asks
 * {@link canReadChatArtifact}, which answers with THE conversation read
 * question (`authorizeConversationRead`, ADR 0992 D8). No second visibility
 * rule lives here.
 *
 * The bucket after the tenant is the conversation id when the tool ran inside a
 * conversation. Without one it is `user:<actingUserId>` (only that user may read
 * it) or `adhoc` (nobody may: no one can be shown to own it). A legacy row minted
 * before the `user:` spelling carries a bare user id; it reads as a missing
 * conversation, so only the user it names may read it.
 */
import { authorizeConversationRead } from '../features/chat-export/access.js';
import { OpenwopError } from '../types.js';

export type ChatArtifactLane = 'chat-code' | 'chat-viz';
const LANES: readonly ChatArtifactLane[] = ['chat-code', 'chat-viz'];
const USER_BUCKET = 'user:';

/** The synthetic runId a chat tool persists its artifact under. */
export function chatArtifactRunId(
  lane: ChatArtifactLane,
  scope: { tenantId: string; conversationId?: string | undefined; actingUserId?: string | undefined },
): string {
  const bucket = scope.conversationId ?? (scope.actingUserId ? `${USER_BUCKET}${scope.actingUserId}` : 'adhoc');
  return `${lane}:${scope.tenantId}:${bucket}`;
}

/** The bucket of a chat-tool artifact row, or null when the row did not come
 *  from a chat tool (an ordinary run output, gated by its org alone). */
export function chatArtifactBucket(row: { tenantId: string; runId: string }): string | null {
  for (const lane of LANES) {
    const head = `${lane}:${row.tenantId}:`;
    if (row.runId.startsWith(head)) return row.runId.slice(head.length);
  }
  return null;
}

/** May `subject` (`req.userId ?? principalId`) read this chat-tool artifact?
 *  Exactly when they may read the conversation it came from. `memo` lets a list
 *  ask each conversation once. */
export async function canReadChatArtifact(
  row: { tenantId: string; runId: string },
  subject: string | undefined,
  memo?: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const bucket = chatArtifactBucket(row);
  if (bucket === null) return true;
  if (!subject || bucket === 'adhoc') return false;
  if (bucket.startsWith(USER_BUCKET)) return bucket.slice(USER_BUCKET.length) === subject;
  const cached = memo?.get(bucket);
  if (cached) return cached;
  const answer = conversationReadable(row.tenantId, bucket, subject);
  memo?.set(bucket, answer);
  return answer;
}

async function conversationReadable(tenantId: string, bucket: string, subject: string): Promise<boolean> {
  try {
    await authorizeConversationRead(tenantId, bucket, subject);
    return true;
  } catch (err) {
    if (err instanceof OpenwopError && err.httpStatus === 404) {
      // No such conversation: a legacy row whose bucket is a bare user id
      // belongs to that user; anything else (a deleted chat) is no one's.
      return bucket === subject;
    }
    throw err;
  }
}
