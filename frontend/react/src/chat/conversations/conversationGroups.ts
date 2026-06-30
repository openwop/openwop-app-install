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

import type { ChatSessionHeader, ConversationType } from '../../client/chatSessionsClient.js';

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
 * Whether a conversation has unread activity for its owner (ADR 0043 Phase 3).
 * Compares the conversation's `updatedAt` (bumped on every message append)
 * against the owner participant's `lastReadAt` read marker — the same shape
 * Slack/Discord drive their unread dot from.
 *
 * Conservative by design: an empty conversation is never unread (you just made
 * it), and a legacy session with no owner participant can't be computed so it
 * reads as read (no false dot). ISO-8601 timestamps compare lexicographically.
 */
export function isUnread(c: ChatSessionHeader): boolean {
  if (c.messageCount === 0) return false;
  const owner = (c.participants ?? []).find((p) => p.role === 'owner');
  if (!owner) return false; // legacy / unknown owner — don't guess
  if (!owner.lastReadAt) return true; // owner has activity but has never read it
  return owner.lastReadAt < c.updatedAt;
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
