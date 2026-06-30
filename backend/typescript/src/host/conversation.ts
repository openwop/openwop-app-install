/**
 * Conversation primitive — host types + helpers (RFC 0005, best-effort).
 *
 * The wire shapes are normative (`schemas/conversation-turn.schema.json`,
 * `schemas/conversation-event.schema.json`); this module mirrors them as
 * TypeScript (the host has no @openwop SDK dep) and provides the
 * replay-deterministic id helpers the `core.conversationGate` lifecycle relies
 * on. `conversationId` and `messageId` MUST be deterministic so re-folding the
 * event stream on replay is idempotent (RFC 0005 §B/§C/§G).
 */

/** RFC 0002 §A1 AgentRef projection carried on `role: 'agent'` turns. */
export interface ConversationTurnAgent {
  agentId: string;
  agentSharing?: 'isolated' | 'shared' | string;
  memoryRef?: string;
  /** RFC 0109 (ADR 0124 Phase 2d) — OPTIONAL model provenance: which model produced this
   *  `role:'agent'` turn. NON-SECRET (provider + model identifiers only — the SR-1 guard);
   *  read verbatim on `:fork`. Stamped only when the host advertises
   *  `conversationTurnModelProvenance.supported`. */
  model?: { provider: string; model: string };
}

/** One turn in a multi-turn conversation (`conversation-turn.schema.json`). */
export interface ConversationTurn {
  /** Deterministic dedup key: `${conversationId}:${turnIndex}:${role}`. */
  messageId: string;
  /** Sender — an agent id or the literal `'user'`. */
  from: string;
  /** Optional addressee (the `@mention` target). Absent = broadcast to the group. */
  to?: string;
  /** Optional shared-agent group id → the `shared:<groupId>` context (RFC 0002 §A8). */
  groupId?: string;
  /** Opaque turn content. */
  content: unknown;
  /** Caller-clock timestamp (ms epoch). Carried through replay unchanged. */
  ts: number;
  role: 'user' | 'agent' | 'system';
  /** AgentRef for `role: 'agent'` turns. */
  agent?: ConversationTurnAgent;
  /** RFC 0101 — the stable speaker identity of this turn (the agent INSTANCE id,
   *  i.e. the roster member's agentId). REQUIRED on `role: 'agent'` turns of a
   *  multi-party conversation that declares a participant roster on
   *  `conversation.opened`; a turn whose `speakerId` is not a declared participant
   *  MUST be rejected. Additive: absent on legacy 1:1 turns. Mirrors `from` for an
   *  agent turn but is the explicit, attributed field (not the dual-use `from`). */
  speakerId?: string;
  /** 0-based monotonic index within the conversation. */
  turnIndex: number;
}

/** Deterministic conversation id for a gate node (RFC 0005 §B —
 *  `${runId}:${nodeId}:${attempt}`; attempt 0 for the demo's single gate). */
export function conversationIdFor(runId: string, nodeId: string, attempt = 0): string {
  return `${runId}:${nodeId}:${attempt}`;
}

/** Deterministic per-turn dedup key (RFC 0005 §C recommended encoding). */
export function turnMessageId(conversationId: string, turnIndex: number, role: ConversationTurn['role']): string {
  return `${conversationId}:${turnIndex}:${role}`;
}

/** Build a fully-formed, replay-stable ConversationTurn. `ts` is passed in (the
 *  caller reads the host clock at the boundary — the helper stays pure). */
export function makeTurn(input: {
  conversationId: string;
  turnIndex: number;
  role: ConversationTurn['role'];
  from: string;
  content: unknown;
  ts: number;
  to?: string | undefined;
  groupId?: string | undefined;
  agent?: ConversationTurnAgent | undefined;
  speakerId?: string | undefined;
}): ConversationTurn {
  return {
    messageId: turnMessageId(input.conversationId, input.turnIndex, input.role),
    from: input.from,
    content: input.content,
    ts: input.ts,
    role: input.role,
    turnIndex: input.turnIndex,
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.speakerId !== undefined ? { speakerId: input.speakerId } : {}),
  };
}
