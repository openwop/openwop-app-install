/**
 * Pure grouping logic for the persistent-conversations sidebar (ADR 0043
 * Phase 2). Partitions the tenant's conversations into the three sidebar
 * sections — People · Agents · Groups — mirroring how Slack/Teams/Discord
 * separate direct messages from channels.
 *
 * Kept pure (no React, no client) so the section assignment + filter is unit
 * testable in isolation; `ConversationsRail` is the only consumer.
 *
 * Type → section mapping (ADR 0043 §model):
 *   - `person`              → People  (1:1 with a human)
 *   - `agent` (+ undefined) → Agents  (1:1 with an AI agent; legacy sessions
 *                                       default to `agent`, matching the BE
 *                                       `toConversation` projection)
 *   - `group` / `workspace` → Groups  (multi-party; the Board of Advisors
 *                                       lives here)
 */

import type { ChatSessionHeader, ConversationParticipant, ConversationType } from '../../client/chatSessionsClient.js';

export type ConversationSection = 'Agents' | 'Channels' | 'Groups' | 'Workspace';

/** Render order of the sidebar sections (ADR 0043 Phase 6: People retired —
 *  human↔human DM is closed; Workspace added — the assistant's tenant-graph chat;
 *  ADR 0154: Channels folded in between Agents and Groups, the Slack-model rail). */
export const SECTION_ORDER: readonly ConversationSection[] = ['Agents', 'Channels', 'Groups', 'Workspace'];

/** The section a conversation type belongs to. A missing type reads as `agent`
 *  (legacy untyped sessions project that way on the backend). `person` is a
 *  RESERVED discriminator (no DM affordance ships); a stray one falls under
 *  Agents rather than silently vanishing. */
export function sectionOf(type?: ConversationType): ConversationSection {
  switch (type) {
    case 'channel':
      return 'Channels';
    case 'workspace':
      return 'Workspace';
    case 'group':
      return 'Groups';
    case 'person':
    case 'agent':
    default:
      return 'Agents';
  }
}

/**
 * The CALLER's participant row (ADR 0192). The backend stamps `isSelf: true`
 * on the row matching the authenticated caller; the pre-0192 `role === 'owner'`
 * heuristic remains ONLY as a legacy fallback (it reads the wrong marker for
 * every non-owner channel/group member).
 */
export function selfParticipant(c: ChatSessionHeader): ConversationParticipant | undefined {
  const participants = c.participants ?? [];
  return participants.find((p) => p.isSelf) ?? participants.find((p) => p.role === 'owner');
}

/**
 * Exact unread count by differencing (ADR 0192 D6):
 * `messageCount − readMessageCount` from the caller's OWN row. Null when the
 * marker predates counting (no `readMessageCount` yet) — callers fall back to
 * the boolean `isUnread` dot.
 */
export function unreadCountOf(c: ChatSessionHeader): number | null {
  const self = selfParticipant(c);
  if (!self || self.readMessageCount === undefined) return null;
  return Math.max(0, c.messageCount - self.readMessageCount);
}

/** Unseen mentions for the caller (`@channel` tier, ADR 0192 D6). */
export function mentionCountOf(c: ChatSessionHeader): number {
  return selfParticipant(c)?.mentionCount ?? 0;
}

/**
 * Whether a conversation has unread activity for the CALLER (ADR 0043 Phase 3,
 * re-based on the caller's own row per ADR 0192). Prefers the exact count
 * differencing; falls back to the `lastReadAt < updatedAt` comparison — the
 * same shape Slack/Discord drive their unread dot from.
 *
 * Conservative by design: an empty conversation is never unread (you just made
 * it), and a legacy session with no derivable self row reads as read (no false
 * dot). ISO-8601 timestamps compare lexicographically.
 */
export function isUnread(c: ChatSessionHeader): boolean {
  if (c.messageCount === 0) return false;
  const count = unreadCountOf(c);
  if (count !== null) return count > 0;
  const self = selfParticipant(c);
  if (!self) return false; // legacy / unknown caller — don't guess
  if (!self.lastReadAt) return true; // caller has activity but has never read it
  return self.lastReadAt < c.updatedAt;
}

/**
 * Partition + filter conversations into the three sidebar sections, preserving
 * the input order within each section (the caller pre-sorts by recency). A
 * non-empty `query` filters by title, case-insensitively.
 */
export function groupConversations(
  conversations: readonly ChatSessionHeader[],
  query = '',
): Record<ConversationSection, ChatSessionHeader[]> {
  const q = query.trim().toLowerCase();
  const buckets: Record<ConversationSection, ChatSessionHeader[]> = {
    Agents: [],
    Channels: [],
    Groups: [],
    Workspace: [],
  };
  for (const c of conversations) {
    if (q && !c.title.toLowerCase().includes(q)) continue;
    buckets[sectionOf(c.type)].push(c);
  }
  return buckets;
}
