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
  };
}
