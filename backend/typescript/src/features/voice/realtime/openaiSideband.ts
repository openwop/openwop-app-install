/**
 * OpenAI Realtime sideband (ADR 0141 RT-4 — the architect deep-dive fix).
 *
 * OpenAI's own production guidance: tool use + business logic belong on YOUR server. The
 * "sideband" is a second connection to the SAME realtime session — the browser keeps the
 * WebRTC audio, and the host opens a server-side WebSocket (`?call_id=…`, server API key) that
 * (a) HANDLES function calls server-side and (b) RECEIVES all events including transcripts.
 *
 * This retires the two blocking findings for the OpenAI path:
 *  - #1 firewall bypass — tool execution runs on the HOST's session connection, keyed on the
 *    host-owned `call_id` (from the SDP `Location` header), not a client-asserted session id.
 *  - #2 no audit/chat record — the host receives every transcript and persists it to the
 *    conversation (the ONE chat) for the chat feed + audit.
 *
 * The live WebSocket is VERIFY-WITH-KEY (no key/network here); `handleSidebandEvent` is a pure
 * function unit-tested with synthetic events.
 */
import { randomUUID } from 'node:crypto';
import { hostExtStorage } from '../../../host/hostExtPersistence.js';
import { executeRealtimeToolCall, clearRealtimeSessionTools } from './toolBridge.js';

export interface SidebandSession {
  /** Host-owned session id (OpenAI `call_id` from the SDP `Location` header). */
  callId: string;
  tenantId: string;
  agentId?: string;
  conversationId?: string;
}

/** Persist a committed transcript turn to the conversation — the audit record + the chat feed
 *  (rides the ONE chat; `meta.source` marks it voice-originated). */
async function persistTranscript(s: SidebandSession, role: 'user' | 'assistant', text: string): Promise<void> {
  const t = text.trim();
  if (!s.conversationId || !t) return;
  // Only persist into an EXISTING conversation — don't crash on a missing id and don't create a
  // phantom session (createChatSession is a plain INSERT, not an upsert).
  const session = await hostExtStorage().getChatSession(s.tenantId, s.conversationId);
  if (!session) return;
  await hostExtStorage().appendChatMessage({
    messageId: randomUUID(), sessionId: s.conversationId, role, content: t.slice(0, 100_000),
    meta: JSON.stringify({ source: 'voice-realtime' }), authorSubject: null, createdAt: new Date().toISOString(),
  });
  await hostExtStorage().updateChatSession(s.tenantId, s.conversationId, { messageCount: session.messageCount + 1, updatedAt: new Date().toISOString() });
}

export interface SidebandDeps { persist: (s: SidebandSession, role: 'user' | 'assistant', text: string) => Promise<void> }
const DEFAULT_DEPS: SidebandDeps = { persist: persistTranscript };

interface SidebandEvent { type?: string; name?: string; arguments?: string; call_id?: string; transcript?: string }

/**
 * Handle one parsed OpenAI sideband event → the events to send back to the model (tool output),
 * or none. Tool calls run through the EXISTING allowlist + composition firewall + executor,
 * keyed on the host-owned `callId`; transcripts are persisted. Pure (deps-injected) — unit-tested.
 */
export async function handleSidebandEvent(s: SidebandSession, evt: SidebandEvent, deps: SidebandDeps = DEFAULT_DEPS): Promise<Array<Record<string, unknown>>> {
  if (evt.type === 'response.function_call_arguments.done' && evt.name && evt.call_id) {
    const args = ((): Record<string, unknown> => { try { return JSON.parse(evt.arguments ?? '{}'); } catch { return {}; } })();
    const outcome = await executeRealtimeToolCall({ tenantId: s.tenantId, agentId: s.agentId, sessionId: s.callId, name: evt.name, args });
    const output = outcome.status === 'ok' ? outcome.result : `[${outcome.status}] ${outcome.reason}`;
    return [
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output } },
      { type: 'response.create' },
    ];
  }
  if (evt.type === 'conversation.item.input_audio_transcription.completed' && evt.transcript) { await deps.persist(s, 'user', evt.transcript); return []; }
  if (evt.type === 'response.audio_transcript.done' && evt.transcript) { await deps.persist(s, 'assistant', evt.transcript); return []; }
  return [];
}

// ── Live sideband (verify-with-key) ─────────────────────────────────────────
type WSCtor = new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket;
const sessions = new Map<string, WebSocket>();

/** The `session.update` that locks the agent's persona + tools + voice + transcription on the
 *  HOST side (the browser never sets these). */
function sessionUpdate(session: { instructions: string; tools: ReadonlyArray<Record<string, unknown>>; voice?: string }): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      instructions: session.instructions,
      tools: session.tools,
      ...(session.voice ? { audio: { output: { voice: session.voice } } } : {}),
      // Enable input transcription so the user's speech is captured for persistence/audit.
      input_audio_transcription: { model: 'whisper-1' },
    },
  };
}

/** Open the server-side sideband to OpenAI for a live call. Sends the session config, then
 *  handles tools + transcripts for the session's lifetime. (Live network — verify-with-key.) */
export function openSideband(
  s: SidebandSession,
  apiKey: string,
  config: { instructions: string; tools: ReadonlyArray<Record<string, unknown>>; voice?: string },
): void {
  const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(s.callId)}`;
  const ws = new (WebSocket as unknown as WSCtor)(url, { headers: { authorization: `Bearer ${apiKey}`, 'openai-beta': 'realtime=v1' } });
  const teardown = (): void => { sessions.delete(s.callId); clearRealtimeSessionTools(s.callId); };
  ws.addEventListener('open', () => ws.send(JSON.stringify(sessionUpdate(config))));
  ws.addEventListener('message', (e: MessageEvent) => { void (async () => {
    // A throw here (e.g. tool exec or transcript persistence) must NOT become an unhandled
    // rejection — log and continue the session.
    try {
      let evt: SidebandEvent; try { evt = JSON.parse(String((e as MessageEvent).data)); } catch { return; }
      const out = await handleSidebandEvent(s, evt);
      for (const o of out) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
    } catch (err) {
      console.error(`[voice.realtime] sideband ${s.callId} event handling failed:`, err instanceof Error ? err.message : err);
    }
  })(); });
  ws.addEventListener('close', teardown);
  ws.addEventListener('error', teardown);
  sessions.set(s.callId, ws);
}

export function closeSideband(callId: string): void {
  const ws = sessions.get(callId);
  if (ws) { try { ws.close(); } catch { /* ignore */ } }
  sessions.delete(callId);
  clearRealtimeSessionTools(callId); // release the firewall seen-set (it has no other reaper)
}
