/**
 * RFC 0239 council turns (ADR 0858 P3) — the `core.conversationGate` roster as
 * an INPUT, and a turn resumed against it.
 *
 * RFC 0239 §B.1: "The turn is the resume value of the conversation's
 * `conversation.exchange` interrupt. A turn with `role: "agent"` names its
 * speaker in `speakerId`." That bare-turn resume value (`{ role, speakerId,
 * content }`) is a different shape from the chat transport's
 * `ConversationResolve` (`{ operation, turn: { content, to } }`), whose agent
 * reply the HOST dispatches. Before this module the bare turn fell into the
 * chat path, which found no `turn.content` and answered `422 validation_error`
 * for EVERY council turn — a member's as well as an intruder's — so the roster
 * was carried on `conversation.opened` and never enforced.
 *
 * Scope is deliberately narrow: the branch engages only when the resume value
 * is a bare turn AND the gate opened with a configured roster
 * (`conversation.opened.participants`, written from `config.participants` by
 * `core.conversationGate`). The chat transport gate configures no roster, so
 * no product conversation reaches this code.
 *
 * Ordering is the invariant (RFC 0239 §B.3): every refusal is decided from
 * the resume value and the already-durable `conversation.opened` event, BEFORE
 * anything is appended, so a refused turn leaves the interrupt open and emits
 * no `conversation.exchanged`. The exchange path never resolves the interrupt
 * either way — only `close` resumes the node.
 *
 * @see ../openwop/RFCS/0239-council-roster-input.md §A–§C
 * @see docs/adr/0858-v2-discovery-projects-every-family.md §P3
 */

import { OpenwopError } from '../../types.js';
import type { Storage } from '../../storage/storage.js';
import { makeTurn, type ConversationTurn } from '../conversation.js';
import { sanitizeFreeText, sanitizeFreeTextDeep } from '../../byok/textRedaction.js';
import { asText, isContentParts } from './contentParts.js';
import { validateExchangeContent } from './validateTurn.js';
import { persistExchangedPair, mirrorTurnToChannel } from './persistExchange.js';
import type { ContentPart } from '../../providers/dispatch.js';
import { MAX_MULTI_PARTY_PARTICIPANTS } from '../multiPartyConversation.js';

/** A bare RFC 0239 turn resume value. */
export interface CouncilTurn {
  role: string;
  speakerId?: unknown;
  content?: unknown;
}

/** The resume value as a bare turn, or null when it is a `ConversationResolve`
 *  (it carries `operation` or a nested `turn`) or not a turn at all. */
export function councilTurnOf(resumeValue: unknown): CouncilTurn | null {
  if (resumeValue === null || typeof resumeValue !== 'object' || Array.isArray(resumeValue)) return null;
  const v = resumeValue as Record<string, unknown>;
  if ('operation' in v || 'turn' in v) return null;
  return typeof v['role'] === 'string' ? (v as unknown as CouncilTurn) : null;
}

const EVENT_PAGE = 200;

/** The roster the gate OPENED with (`conversation.opened.participants` agent
 *  ids), or null when the conversation has none (RFC 0239 §A.3). Read from the
 *  durable event, not the definition: it is what this conversation was
 *  actually opened with, and a definition can move under a running run. */
export async function gateRosterOf(storage: Storage, runId: string, conversationId: string): Promise<string[] | null> {
  let fromSeq = -1;
  for (;;) {
    const events = await storage.listEvents(runId, { fromSeq, limit: EVENT_PAGE });
    for (const e of events) {
      if (e.sequence > fromSeq) fromSeq = e.sequence;
      if (e.type !== 'conversation.opened') continue;
      const p = (e.payload ?? {}) as { conversationId?: unknown; participants?: unknown };
      if (p.conversationId !== conversationId) continue;
      if (!Array.isArray(p.participants) || p.participants.length === 0) return null;
      return p.participants
        .map((x) => (x && typeof x === 'object' ? (x as { agentId?: unknown }).agentId : undefined))
        .filter((id): id is string => typeof id === 'string');
    }
    if (events.length < EVENT_PAGE) return null;
  }
}

/**
 * Apply one bare agent turn to a council (RFC 0239 §B). Refusals first, then a
 * single durable `conversation.exchanged` carrying the member's turn. The host
 * dispatches no reply: the turn IS the agent's turn, attributed by `speakerId`.
 */
export async function applyCouncilTurn(input: {
  runId: string;
  nodeId: string;
  conversationId: string;
  roster: readonly string[];
  turn: CouncilTurn;
  existing: readonly ConversationTurn[];
  nextIndex: number;
}): Promise<ConversationTurn[]> {
  const { runId, nodeId, conversationId, roster, turn, existing, nextIndex } = input;
  if (turn.role !== 'agent') {
    throw new OpenwopError('validation_error', "A council turn MUST be a role:'agent' turn naming its speaker.", 422, { conversationId, field: 'role' });
  }
  const speakerId = typeof turn.speakerId === 'string' && turn.speakerId.length > 0 ? turn.speakerId : undefined;
  if (speakerId === undefined) {
    throw new OpenwopError('validation_error', "A role:'agent' turn MUST carry a `speakerId`.", 422, { conversationId, field: 'speakerId' });
  }
  // §B.2 — membership, decided before anything is written (§B.3).
  if (!roster.includes(speakerId)) {
    throw new OpenwopError(
      'conversation_speaker_not_participant',
      `Agent ${speakerId} is not a participant of this multi-party conversation.`,
      422,
      { conversationId, speakerId },
    );
  }
  validateExchangeContent(turn.content, conversationId);
  const content: string | ContentPart[] = isContentParts(turn.content)
    ? (sanitizeFreeTextDeep(turn.content) as ContentPart[])
    : sanitizeFreeText(asText(turn.content));
  const agentTurn = makeTurn({
    conversationId, turnIndex: nextIndex, role: 'agent', from: speakerId, content,
    ts: Date.now(), groupId: conversationId, agent: { agentId: speakerId }, speakerId,
  });
  await persistExchangedPair({ runId, nodeId, conversationId, entries: [[nextIndex, agentTurn]] });
  mirrorTurnToChannel(runId, {
    messageId: agentTurn.messageId, role: 'assistant', content: asText(content),
    timestamp: new Date(agentTurn.ts).toISOString(), agentId: speakerId,
  });
  return [...existing, agentTurn];
}

/** A `core.conversationGate` whose configured roster exceeds the advertised
 *  `multiPartyConversation.maxParticipants` (RFC 0239 §C) — the refusal, or
 *  null. Never truncates. Pure over the definition's nodes, so every
 *  run-admission lane that already calls `capabilityGatedTypeIdRefusal` applies
 *  it through that one choke. */
export function councilRosterExceededRefusal(
  nodes: ReadonlyArray<{ nodeId: string; typeId: string; config?: Record<string, unknown> }>,
): OpenwopError | null {
  for (const n of nodes) {
    if (n.typeId !== 'core.conversationGate') continue;
    const participants = n.config?.['participants'];
    if (!Array.isArray(participants) || participants.length <= MAX_MULTI_PARTY_PARTICIPANTS) continue;
    return new OpenwopError(
      'conversation_roster_exceeded',
      `core.conversationGate '${n.nodeId}' seats ${participants.length} participants; this host's multiPartyConversation.maxParticipants is ${MAX_MULTI_PARTY_PARTICIPANTS}.`,
      422,
      { maxParticipants: MAX_MULTI_PARTY_PARTICIPANTS, nodeId: n.nodeId, participants: participants.length },
    );
  }
  return null;
}
