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
 * GATING: off by default. Enable per-deploy with `VITE_OPENWOP_CHAT_CONVERSATION=true`
 * (or `localStorage.openwop:chat-conversation = "1"` for a single browser) ONLY
 * after manual QA — the per-turn path stays the production default until then.
 */

import { pollEvents } from '../client/runsClient.js';
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

/** Is the conversation transport enabled for this client? Off by default. */
export function conversationChatEnabled(): boolean {
  if ((import.meta.env.VITE_OPENWOP_CHAT_CONVERSATION as string | undefined) === 'true') return true;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('openwop:chat-conversation') === '1';
  } catch {
    return false;
  }
}

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

async function fetchTurns(runId: string): Promise<ConversationTurn[]> {
  // Use the UNGATED core event-poll (`GET /v1/runs/{id}/events`), NOT the
  // debug-bundle: debug-bundle is capability-gated (`capabilities.debugBundle`)
  // and the demo host doesn't advertise it, so getDebugBundle() throws. pollEvents
  // returns the same {type, payload} run-event envelopes reconstructConversation
  // reads. (Single fetch from seq 0 — fine at chat-conversation length; a very
  // long conversation would page, like RunDetailPage's single poll.)
  const polled = await pollEvents(runId, 0);
  const events = polled.events.map((e) => toRunEvent({ type: e.type, payload: e.payload }));
  return reconstructConversation(events);
}

/** Provider selection carried into the conversation run (mirrors the per-turn
 *  chat's createRun inputs) so the exchange handler dispatches replies with the
 *  same provider/model/credential. */
export interface ConversationProviderConfig {
  provider?: string;
  model?: string;
  credentialRef?: string;
  tenantId?: string;
}

/** Open a conversation run for a chat session, carrying the provider config. */
export async function openConversationSession(cfg: ConversationProviderConfig = {}): Promise<{ runId: string; nodeId: string }> {
  const inputs: Record<string, unknown> = {};
  if (cfg.provider) inputs.provider = cfg.provider;
  if (cfg.model) inputs.model = cfg.model;
  if (cfg.credentialRef) inputs.credentialRef = cfg.credentialRef;
  const { runId } = await openConversation({
    workflowId: CONVERSATION_WORKFLOW_ID,
    inputs,
    ...(cfg.tenantId ? { tenantId: cfg.tenantId } : {}),
  });
  return { runId, nodeId: CONVERSATION_GATE_NODE_ID };
}

/** Send one user turn to `to` (the @mention agentId) and return the full thread
 *  rebuilt from the run's events after the agent reply lands. */
export async function sendConversationTurn(
  runId: string,
  nodeId: string,
  input: { content: string; to?: string },
): Promise<ConversationBubble[]> {
  await exchange(runId, nodeId, input);
  return turnsToBubbles(await fetchTurns(runId));
}

/** Close the conversation (resumes + completes the run). Best-effort. */
export async function closeConversationSession(runId: string, nodeId: string): Promise<void> {
  try {
    await closeConversation(runId, nodeId);
  } catch {
    /* a stale/closed run is fine to ignore on session reset */
  }
}
