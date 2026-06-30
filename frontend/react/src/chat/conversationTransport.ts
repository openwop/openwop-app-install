/**
 * Conversation-run chat transport (RFC 0005) — the flag-gated cutover layer.
 *
 * Swaps the chat's per-turn `openwop-app.chat.turn` runs for ONE long-lived
 * conversation run: open on the first message, `exchange` per message (the gate
 * stays suspended), close on "New chat". The thread is rebuilt from the run's
 * `conversation.exchanged` events (wire-native attribution) — no client-side
 * persona labeling. Because `exchange` is synchronous (returns after the agent
 * reply is emitted), v1 needs no streaming: send → await exchange → refetch the
 * run's events → reconstruct.
 *
 * This is the SOLE chat transport (ADR 0067 §Phase 6): the per-turn
 * `openwop-app.chat.turn` fallback + its `conversationChatEnabled()` opt-out were
 * retired once the exchange path had provider parity (managed/BYOK/mock), idempotent
 * exchanges, event tailing, and clean telemetry. The backend per-turn workflow is
 * kept only so historical per-turn runs still replay/fork (the wire contract).
 */

import { pollEvents, getRun } from '../client/runsClient.js';
import { listOpenInterrupts } from '../client/interruptsClient.js';
import {
  openConversation,
  exchange,
  closeConversation,
  reconstructConversation,
  type ConversationTurn,
  type RunEvent,
} from './conversationClient.js';

/** The synthesized host workflow holding a single `core.conversationGate`. */
export const CONVERSATION_WORKFLOW_ID = 'openwop-app.conversation';
/** The gate node id in that workflow (see host/index.ts synth). */
export const CONVERSATION_GATE_NODE_ID = 'gate';

/** A minimal chat bubble shape the hook adapts into its ChatMessage state. */
export interface ConversationBubble {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Producing agent persona/id for an assistant turn (wire-sourced). */
  agentPersona?: string;
}

function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** Map reconstructed turns → chat bubbles. System turns (open/close markers)
 *  are dropped; `agent` turns become assistant bubbles carrying the wire
 *  attribution (`agent.agentId` ?? `from`). Pure — unit-tested. */
export function turnsToBubbles(turns: readonly ConversationTurn[]): ConversationBubble[] {
  const out: ConversationBubble[] = [];
  for (const t of turns) {
    if (t.role === 'system') continue;
    if (t.role === 'user') {
      out.push({ id: t.messageId, role: 'user', content: asText(t.content) });
    } else {
      const persona = t.agent?.agentId ?? t.from;
      out.push({ id: t.messageId, role: 'assistant', content: asText(t.content), ...(persona && persona !== 'assistant' ? { agentPersona: persona } : {}) });
    }
  }
  return out;
}

/** Project a debug-bundle event row (loose `Record`) into the typed RunEvent
 *  shape the reconstructor reads — no `as any`/double-cast. */
function toRunEvent(e: Record<string, unknown>): RunEvent {
  const payload = e.payload && typeof e.payload === 'object' ? (e.payload as RunEvent['payload']) : undefined;
  return {
    ...(typeof e.type === 'string' ? { type: e.type } : {}),
    ...(payload ? { payload } : {}),
  };
}

/** Turns reconstructed from events newer than a cursor, plus the new cursor. */
export interface ConversationFetch {
  /** Turns parsed from events with `sequence > sinceSeq` (the open turn + every
   *  exchanged/closed turn in that window). On a from-0 fetch this is the whole
   *  thread; on a tail fetch it is just the newly-appended turns. */
  turns: ConversationTurn[];
  /** Highest event sequence observed (≥ sinceSeq) — pass back as the next cursor. */
  lastSeq: number;
}

/**
 * Fetch conversation turns from the run's event log, tailing from `sinceSeq`
 * (ADR 0067 §Phase 4). Uses the UNGATED core event-poll (`GET /v1/runs/{id}/events`),
 * NOT the capability-gated debug-bundle. Passing the last-seen sequence avoids
 * rescanning the whole log from seq 0 on every refresh; the caller folds the
 * returned turns into its accumulated thread.
 */
export async function fetchTurns(runId: string, sinceSeq = 0): Promise<ConversationFetch> {
  const polled = await pollEvents(runId, sinceSeq);
  let lastSeq = sinceSeq;
  const events = polled.events.map((e) => {
    if (typeof e.sequence === 'number' && e.sequence > lastSeq) lastSeq = e.sequence;
    return toRunEvent({ type: e.type, payload: e.payload });
  });
  return { turns: reconstructConversation(events), lastSeq };
}

/** Provider selection carried into the conversation run (mirrors the per-turn
 *  chat's createRun inputs) so the exchange handler dispatches replies with the
 *  same provider/model/credential. */
export interface ConversationProviderConfig {
  provider?: string;
  model?: string;
  credentialRef?: string;
  tenantId?: string;
  /** Enable the provider's NATIVE web search/grounding for this conversation,
   *  using the selected BYOK provider key (ADR 0101). Captured at open time. */
  webSearch?: boolean;
  /** The chat sessionId, carried into the run's metadata so the exchange handler
   *  can resolve the conversation's ConversationMeta (owner-subject knowledge +
   *  a board's injected strategy context are keyed by the chat sessionId). */
  chatSessionId?: string;
}

/** How long to wait for the conversation gate to suspend before giving up. */
const GATE_OPEN_TIMEOUT_MS = 10_000;

/**
 * Wait until the conversation gate has actually suspended (its interrupt is
 * open) before the caller sends the first turn.
 *
 * `POST /v1/runs` dispatches the run in the BACKGROUND and returns the runId
 * before the gate node executes (`host/runDispatch.ts` → `dispatchRunInBackground`),
 * so an `exchange` fired immediately after open races the suspend and the
 * resolve route 404s with `interrupt_not_found: no open interrupt for this node`.
 * Poll the run's open interrupts until the gate appears; fail fast (with a
 * readable message) if the run terminates before suspending. Only the FIRST
 * turn needs this — the gate stays suspended across exchanges, so later turns
 * never race.
 */
async function waitForGateOpen(runId: string, nodeId: string): Promise<void> {
  const deadline = Date.now() + GATE_OPEN_TIMEOUT_MS;
  let delay = 60;
  let polls = 0;
  for (;;) {
    const open = await listOpenInterrupts(runId).catch(() => []);
    if (open.some((i) => i.nodeId === nodeId)) return;
    // Every few polls, confirm the run didn't error/complete before suspending
    // (don't fetch the run every iteration — keep the read fan-out bounded).
    if (++polls % 4 === 0) {
      const run = await getRun(runId).catch(() => null);
      if (run && ['failed', 'completed', 'cancelled'].includes(run.status)) {
        throw new Error(`The conversation could not start (run ${run.status}).`);
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the conversation to start. Please try again.');
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 1.5), 400);
  }
}

/**
 * ADR 0079 §Phase 2 — extract a streamable token delta from a run event for the
 * conversation's optimistic bubble. The run SSE replays from sequence 0 on
 * connect, so a delta is only "live" for THIS exchange when its `sequence`
 * exceeds the cursor captured at subscribe time (`startSeq`); older
 * `ai.message.chunk` events belong to prior turns and must not re-type. Returns
 * the chunk text, or null for a non-chunk / replayed / malformed event. Pure +
 * unit-tested — the bug-prone replay-guard lives here, not inline.
 */
export function streamDeltaFromEvent(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): string | null {
  if (ev.type !== 'ai.message.chunk') return null;
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  const chunk = (ev.payload as { chunk?: unknown } | undefined)?.chunk;
  return typeof chunk === 'string' ? chunk : null;
}

/**
 * ADR 0079 §Phase 3 — classify a run event as the async-exchange SETTLE signal.
 * Under the async flag the `exchange` POST acks BEFORE the reply is emitted, so
 * the client streams `ai.message.chunk` deltas into its optimistic bubble and
 * waits for one of two terminal events (newer than the subscribe cursor) to
 * reconcile: the agent's authoritative `conversation.exchanged` turn (`'agent'`),
 * or a terminal `ai.message.error` (`'error'`). Returns null for anything else
 * (deltas, the user-turn echo, replayed/older events). Pure + unit-tested.
 */
export function exchangeSettleSignal(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): 'agent' | 'error' | null {
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  if (ev.type === 'ai.message.error') return 'error';
  if (ev.type === 'conversation.exchanged') {
    const role = (ev.payload as { turn?: { role?: unknown } } | undefined)?.turn?.role;
    if (role === 'agent') return 'agent';
  }
  return null;
}

/**
 * ADR 0151 — extract an auto-generated conversation title from a `conversation.titled`
 * host event. Emitted once, on the first exchange, by the chat-autotitle binding; the
 * rail/tab swaps the substring placeholder for this live. Replay-guarded on `startSeq`
 * like the delta mapper (an older title belongs to a prior fold). Pure + unit-tested.
 * Returns null for any non-title / replayed / malformed event.
 */
export function titledFromEvent(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): string | null {
  if (ev.type !== 'conversation.titled') return null;
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  const title = (ev.payload as { title?: unknown } | undefined)?.title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

/** The async-exchange error payload (best-effort fields off `ai.message.error`). */
export function exchangeErrorPayload(ev: { payload?: unknown }): { code?: string; message?: string } {
  const p = ev.payload as { code?: unknown; message?: unknown } | undefined;
  return {
    ...(typeof p?.code === 'string' ? { code: p.code } : {}),
    ...(typeof p?.message === 'string' ? { message: p.message } : {}),
  };
}

/** One step of a tool-bearing agent's live progress (ADR 0089 Phase 2). */
export interface ToolActivity {
  kind: 'reasoned' | 'tool-called' | 'tool-returned';
  /** Correlates a `tool-returned` to its `tool-called` card. */
  callId?: string;
  /** The tool id, for `tool-called` / `tool-returned`. */
  toolName?: string;
  /** `ok` | `error` | `forbidden` | `invalid_args`, for `tool-returned`. */
  status?: string;
  /** The agent that ran the tool (attribution on the card). */
  agentId?: string;
}

/**
 * Classify a run event as one step of the agent's tool loop (RFC 0064
 * `agent.reasoned` / `agent.toolCalled` / `agent.toolReturned`), so the chat can
 * render live progress ("🔍 used web search…") while a tool-bearing agent works,
 * instead of a silent wait. Replay-guarded on `startSeq` like the delta mapper
 * (older events belong to prior turns). Pure + unit-tested. Returns null for any
 * non-tool / replayed / malformed event.
 */
export function toolActivityFromEvent(
  ev: { type?: string; sequence?: number; payload?: unknown },
  startSeq: number,
): ToolActivity | null {
  if (typeof ev.sequence !== 'number' || ev.sequence <= startSeq) return null;
  const p = (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as { toolName?: unknown; status?: unknown; callId?: unknown; agentId?: unknown };
  const toolName = typeof p.toolName === 'string' ? p.toolName : undefined;
  const callId = typeof p.callId === 'string' ? p.callId : undefined;
  const agentId = typeof p.agentId === 'string' ? p.agentId : undefined;
  switch (ev.type) {
    case 'agent.reasoned':
      return { kind: 'reasoned', ...(agentId ? { agentId } : {}) };
    case 'agent.toolCalled':
      return { kind: 'tool-called', ...(callId ? { callId } : {}), ...(toolName ? { toolName } : {}), ...(agentId ? { agentId } : {}) };
    case 'agent.toolReturned':
      return { kind: 'tool-returned', ...(callId ? { callId } : {}), ...(toolName ? { toolName } : {}), ...(typeof p.status === 'string' ? { status: p.status } : {}), ...(agentId ? { agentId } : {}) };
    default:
      return null;
  }
}

/** Open a conversation run for a chat session, carrying the provider config.
 *  Resolves only once the gate is suspended, so the caller's first `exchange`
 *  can't race the background dispatch (see `waitForGateOpen`). */
export async function openConversationSession(cfg: ConversationProviderConfig = {}): Promise<{ runId: string; nodeId: string }> {
  const inputs: Record<string, unknown> = {};
  if (cfg.provider) inputs.provider = cfg.provider;
  if (cfg.model) inputs.model = cfg.model;
  if (cfg.credentialRef) inputs.credentialRef = cfg.credentialRef;
  if (cfg.webSearch) inputs.webSearch = true;
  const { runId } = await openConversation({
    workflowId: CONVERSATION_WORKFLOW_ID,
    inputs,
    ...(cfg.tenantId ? { tenantId: cfg.tenantId } : {}),
    ...(cfg.chatSessionId ? { metadata: { chatSessionId: cfg.chatSessionId } } : {}),
  });
  await waitForGateOpen(runId, CONVERSATION_GATE_NODE_ID);
  return { runId, nodeId: CONVERSATION_GATE_NODE_ID };
}

/** Result of one exchange: the turns appended since `sinceSeq` and the new cursor. */
export interface SendResult {
  turns: ConversationTurn[];
  lastSeq: number;
}

/** Send one user turn to `to` (the @mention agentId) and return the turns
 *  appended since `sinceSeq` plus the new cursor (ADR 0067 §Phase 2/4). The
 *  `exchangeKey` makes the POST idempotent: a retried send returns the existing
 *  turns instead of duplicating them. The caller folds the returned turns into
 *  its accumulated thread (tailing — no full re-poll). */
export async function sendConversationTurn(
  runId: string,
  nodeId: string,
  input: { content: string; to?: string; exchangeKey?: string; webSearch?: boolean; model?: string; provider?: string },
  sinceSeq = 0,
): Promise<SendResult> {
  await exchange(runId, nodeId, input);
  return fetchTurns(runId, sinceSeq);
}

/** Close the conversation (resumes + completes the run). Best-effort. */
export async function closeConversationSession(runId: string, nodeId: string): Promise<void> {
  try {
    await closeConversation(runId, nodeId);
  } catch {
    /* a stale/closed run is fine to ignore on session reset */
  }
}
