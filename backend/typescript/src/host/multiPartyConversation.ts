/**
 * Multi-party group conversation — speaker roster + attribution (RFC 0101).
 *
 * RFC 0101 (multi-party group conversation) upstreams a NORMATIVE shape for the
 * "advisory council / panel / round-table" pattern (openwop-app ADR 0040 Phase 6):
 *
 *   1. a participant roster (`participants: AgentRef[]`) on `conversation.opened`;
 *   2. a REQUIRED per-turn `speakerId` on `role:'agent'` turns (the agent INSTANCE
 *      id — the roster member's agentId);
 *   3. a `multiPartyConversation` capability the host advertises ONLY because it
 *      honors (1)+(2) (advertising true without honoring is a dishonest claim;
 *      `OPENWOP_REQUIRE_BEHAVIOR=true` fails it).
 *
 * The host expresses the boardroom on the EXISTING RFC 0005 conversation wire
 * (`conversation.opened`/`conversation.exchanged`, NOT a parallel runtime — ADR
 * 0040 § Correction 2026-06-15). A board's cohort is the `agent:<agentId>`
 * participants on the conversation's `ConversationMeta` (stamped by
 * `markAsBoardGroup` at `@@`-summon). This module derives the AgentRef roster from
 * that meta and enforces the RFC 0101 speaker rule — defense-in-depth: the chat
 * only ever seats cohort members, so a non-participant speaker is an invariant
 * violation, rejected fail-closed.
 *
 * @see docs/adr/0040-board-of-advisors.md (Phase 6)
 * @see ../openwop/RFCS/0101-multi-party-group-conversation.md
 */

import type { ConversationMeta } from './conversationStore.js';

/** Cap on a multi-party participant roster — the advisory-board cohort cap
 *  (ADR 0040 § Open questions: fan-out caps). Advertised as
 *  `multiPartyConversation.maxParticipants` and enforced here. */
export const MAX_MULTI_PARTY_PARTICIPANTS = 8;

/** RFC 0002 §A1 AgentRef projection carried in the `participants` roster. */
export interface ParticipantAgentRef {
  agentId: string;
}

/**
 * The participant agent roster (RFC 0101 `participants`) of a conversation, derived
 * from its `ConversationMeta` — the `agent:<agentId>` members of a board group.
 * Returns `null` for a conversation that declares NO multi-party roster (a 1:1 or
 * ungrouped chat) so the speaker rule applies ONLY to multi-party conversations
 * (additive — legacy chats are untouched). A board group with no agent members
 * still returns `[]` (a declared-but-empty roster), which the speaker rule treats
 * as "no agent may speak" — fail-closed.
 */
export function participantRosterOf(meta: ConversationMeta | null | undefined): ParticipantAgentRef[] | null {
  // Only a board-seeded group conversation declares a speaker roster; everything
  // else is single-agent / ungrouped and keeps the optional-attribution behavior.
  if (!meta || meta.type !== 'group' || !meta.boardId) return null;
  const agents: ParticipantAgentRef[] = [];
  for (const p of meta.participants) {
    const m = /^agent:(.+)$/.exec(p.subjectRef);
    if (m && m[1]) agents.push({ agentId: m[1] });
  }
  return agents;
}

/** Is `agentId` a declared participant of `roster`? */
export function isParticipant(roster: readonly ParticipantAgentRef[], agentId: string | undefined): boolean {
  return agentId !== undefined && roster.some((p) => p.agentId === agentId);
}
