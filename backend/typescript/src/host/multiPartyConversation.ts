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
 * 0040 § Correction 2026-06-15). A multi-party cohort is the `agent:<agentId>`
 * participants on the conversation's `ConversationMeta` — seated by
 * `markAsBoardGroup` at `@@`-summon for a board, by `POST /projects/:id/chat` for
 * a project, and by `POST /chat/sessions/:id/participants` generically. This
 * module derives the AgentRef roster from that meta and enforces the RFC 0101
 * speaker rule — defense-in-depth: the chat only ever seats cohort members, so a
 * non-participant speaker is an invariant violation, rejected fail-closed.
 *
 * The roster is derived from the SHAPE (a group conversation that seats agents),
 * never from which feature created it — see `participantRosterOf`.
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
 * from its `ConversationMeta`.
 *
 * ADR 0608 D6 (`CPWF-1`) — CORRECTED 2026-08-24. This used to require
 * `meta.boardId`, and the comment that stood here asserted that "everything else
 * is single-agent / ungrouped". **That was false**, and the falseness is what let
 * the defect survive a full grade loop: a PROJECT group chat is `type:'group'`
 * with `ownerSubject: project:<id>` and NO `boardId` (`features/projects/routes.ts:436-441`),
 * seating every `agent:` member of the project. So the roster came back `null`, the
 * fail-closed speaker rule at `conversationExchange.ts:333-341` never fired, and
 * the `multiPartyConversation` capability the host ADVERTISES
 * (`routes/discovery.ts:841`) was unenforced for that producer. `boardId` is a
 * PROVENANCE SPELLING; the invariant is "a group conversation that seats agents".
 *
 * The rule now:
 *   - not a group meta                    ⇒ `null` (1:1 / ungrouped — untouched).
 *   - a BOARD group                       ⇒ the derived roster, EVEN IF EMPTY. A
 *     board declares a cohort explicitly, so an empty cohort means "no agent may
 *     speak" and stays fail-closed (unchanged behaviour).
 *   - any other group WITH `agent:` seats ⇒ the derived roster. This is the arm
 *     that was missing; projects and the generic
 *     `POST /chat/sessions/:id/participants` route both land here.
 *   - any other group with ZERO agent seats ⇒ `null`, deliberately. A group that
 *     seats no agents has declared no roster, and returning `[]` for it would make
 *     every agent turn a 422 — e.g. a kicktodo accountability circle
 *     (`kicktodo-accountability/circleService.ts:106`) seats no agents at create.
 *     Turning a missing guard into a wedge is not an improvement, so the empty
 *     case keeps legacy behaviour for non-board groups.
 *
 * This is the SPEAKER arm only. The participant CAP is deliberately not enforced
 * here — see ADR 0608 D6 for why it must land separately and behind an audit.
 */
export function participantRosterOf(meta: ConversationMeta | null | undefined): ParticipantAgentRef[] | null {
  if (!meta || meta.type !== 'group') return null;
  const agents: ParticipantAgentRef[] = [];
  for (const p of meta.participants) {
    const m = /^agent:(.+)$/.exec(p.subjectRef);
    if (m && m[1]) agents.push({ agentId: m[1] });
  }
  if (meta.boardId) return agents;
  return agents.length > 0 ? agents : null;
}

/** Is `agentId` a declared participant of `roster`? */
export function isParticipant(roster: readonly ParticipantAgentRef[], agentId: string | undefined): boolean {
  return agentId !== undefined && roster.some((p) => p.agentId === agentId);
}
