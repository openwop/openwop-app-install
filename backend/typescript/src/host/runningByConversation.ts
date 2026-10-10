/**
 * ADR 0776 P2 — which of the caller's conversations have a run in flight, for
 * the Conversations rail's "Running" status on conversations the client does
 * not hold open.
 *
 * ONE bounded read over the existing tenant run index (`listRuns` by tenant +
 * status), not a new run→conversation store: every chat-originated run already
 * carries `metadata.chatSessionId` (the SPA's `/workflow` dispatch and the agent
 * tools both stamp it). The conversation run itself carries it too and is always
 * open, so `CONVERSATION_WORKFLOW_ID` is excluded — otherwise every open chat
 * would read "Running".
 *
 * A conversation is reported only if the caller may READ it (the rail's own
 * `isVisibleToAsync`), so another member's conversation ids never leave the
 * server. `chatSessionId` is client-supplied at run create, so a forged stamp
 * can at most mark one of the caller's OWN visible conversations as running —
 * cosmetic, never a disclosure.
 */
import type { Storage } from '../storage/storage.js';
import { CONVERSATION_WORKFLOW_ID } from './conversation.js';
import { getConversationMeta } from './conversationStore.js';
import { isVisibleToAsync } from './conversationVisibility.js';

/** In-flight statuses. Waiting-on-approval is NOT here: the review inbox owns it
 *  (ADR 0776 P1) and outranks "running" on the rail. */
const IN_FLIGHT = ['pending', 'running'] as const;
/** Per status. Beyond it the answer is a floor, and says so. */
export const RUNNING_SCAN_LIMIT = 200;

export interface RunningConversation { conversationId: string; runs: number }

export async function listRunningConversations(
  storage: Pick<Storage, 'listRuns'>,
  tenantId: string,
  userId: string | undefined,
): Promise<{ conversations: RunningConversation[]; truncated: boolean }> {
  // No acting user ⇒ no conversations are "theirs" — fail empty, never tenant-wide.
  if (!userId) return { conversations: [], truncated: false };
  let truncated = false;
  const counts = new Map<string, number>();
  for (const status of IN_FLIGHT) {
    const rows = await storage.listRuns({ tenantId, status, limit: RUNNING_SCAN_LIMIT });
    if (rows.length === RUNNING_SCAN_LIMIT) truncated = true;
    for (const r of rows) {
      if (r.workflowId === CONVERSATION_WORKFLOW_ID) continue;
      const id = (r.metadata as { chatSessionId?: unknown } | undefined)?.chatSessionId;
      if (typeof id !== 'string' || id === '') continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const conversations: RunningConversation[] = [];
  for (const [conversationId, runs] of counts) {
    const meta = await getConversationMeta(tenantId, conversationId);
    if (await isVisibleToAsync(meta, tenantId, userId)) conversations.push({ conversationId, runs });
  }
  return { conversations, truncated };
}
