/**
 * Live voice mode client (ADR 0138 P3) — drives the host-extension product surface
 * `/v1/host/openwop-app/voice/session/*`. Voice mode is the audio ADAPTER on the ONE
 * chat: this opens a session, streams mic utterances, commits them to a transcript
 * (which the caller routes into the normal chat), and voices the chat's reply with
 * barge-in. No second chat.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { cachedRead } from '../../client/requestCache.js';

const base = `${config.baseUrl}/v1/host/openwop-app/voice/session`;
const jsonHeaders = (): HeadersInit => authedHeaders({ 'content-type': 'application/json' });

export interface VoiceSession {
  sessionId: string;
  streamRef: string;
  status: 'open' | 'closed';
  turns: number;
  agentId?: string;
  conversationId?: string;
}
export interface VoiceTransport { kind: 'http-chunked'; appendPath: string; commitPath: string }
export interface VoiceEvent { type: string; payload: Record<string, unknown> }
export interface CommitResult { finalText: string; atMs: number; events: VoiceEvent[]; nextStreamRef: string; turns: number }
export interface SpeakResult { turnId: string; cancelled?: boolean; audio?: { url: string; mimeType: string; voiceId: string }; events?: VoiceEvent[] }

async function ok<T>(res: Response, op: string): Promise<T> {
  if (!res.ok) throw new Error(`${op} failed (${res.status})`);
  return (await res.json()) as T;
}

/** Open a voice session (optionally scoped to an agent + conversation). */
export async function openVoiceSession(input: { agentId?: string; conversationId?: string; mimeType?: string }): Promise<{ session: VoiceSession; transport: VoiceTransport }> {
  const res = await fetch(base, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return ok(res, 'openVoiceSession');
}

/** Append one base64 audio chunk to the current utterance. */
export async function appendVoiceAudio(sessionId: string, audioChunk: string): Promise<{ bytes: number }> {
  const res = await fetch(`${base}/${encodeURIComponent(sessionId)}/audio`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ audioChunk }) }));
  return ok(res, 'appendVoiceAudio');
}

/** Commit the utterance (endpoint) → the transcribed turn + the next handle. */
export async function commitVoiceTurn(sessionId: string, languageCode?: string): Promise<CommitResult> {
  const res = await fetch(`${base}/${encodeURIComponent(sessionId)}/commit`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(languageCode ? { languageCode } : {}) }));
  return ok(res, 'commitVoiceTurn');
}

/** Voice the agent's reply text (the chat produced it). Returns the audio asset + chunks. */
export async function speakReply(sessionId: string, text: string): Promise<SpeakResult> {
  const res = await fetch(`${base}/${encodeURIComponent(sessionId)}/speak`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text }) }));
  return ok(res, 'speakReply');
}

/** Barge-in: cancel the in-flight reply (the user started speaking over playback). */
export async function bargeIn(sessionId: string, atMs?: number): Promise<{ events: VoiceEvent[]; cancelledTurn: string | null }> {
  const res = await fetch(`${base}/${encodeURIComponent(sessionId)}/barge-in`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(atMs != null ? { atMs } : {}) }));
  return ok(res, 'bargeIn');
}

/** End the session (GC). Best-effort. */
export async function endVoiceSession(sessionId: string): Promise<void> {
  await fetch(`${base}/${encodeURIComponent(sessionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })).catch(() => {});
}

// ── Real-time sessions (ADR 0141) ───────────────────────────────────────────
const rtBase = `${config.baseUrl}/v1/host/openwop-app/voice/realtime`;

export type RealtimeProviderId = 'openai-realtime' | 'gemini-live';
export interface RealtimeToolDecl { name: string; description: string; parameters: Record<string, unknown> }
export interface RealtimeSessionConfig {
  provider: RealtimeProviderId;
  model: string;
  voice?: string;
  token: string;
  expiresAt?: string;
  connect: { kind: 'webrtc' | 'websocket'; url: string };
  instructions: string;
  tools: RealtimeToolDecl[];
  /** Host-issued session id (RTV-2/RTV-3) — echoed on …/tool-call so the host binds the
   *  firewall seen-set key + the agent allowlist server-side. */
  hostSessionId?: string;
}
export interface RealtimeConfig { provider: RealtimeProviderId | 'off'; credentialRef?: string; model?: string }

/** Open a realtime session: mint a token + get the browser session config, or `null` when no
 *  realtime provider is configured (→ caller falls back to the walkie-talkie). */
export async function openRealtimeSession(input: { agentId?: string }): Promise<RealtimeSessionConfig | null> {
  const res = await fetch(`${rtBase}/session`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (!res.ok) throw new Error(`openRealtimeSession failed (${res.status})`);
  const data = await res.json() as { realtime: RealtimeSessionConfig | null; hostSessionId?: string };
  if (!data.realtime) return null;
  return { ...data.realtime, ...(data.hostSessionId ? { hostSessionId: data.hostSessionId } : {}) };
}

/** OpenAI sideband (ADR 0141 RT-4): the browser POSTs its WebRTC offer to the HOST, which
 *  mediates the SDP to OpenAI, owns the session (call_id), and runs the server-side sideband
 *  (tools + transcripts). Returns the answer SDP — the browser keeps only the audio, holds no
 *  session id, relays no tools, and never receives an OpenAI token. */
export async function connectOpenAiRealtime(input: { sdp: string; agentId?: string; conversationId?: string }): Promise<{ sessionId: string; sdp: string }> {
  const res = await fetch(`${rtBase}/openai/connect`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (!res.ok) throw new Error(`connectOpenAiRealtime failed (${res.status})`);
  return (await res.json()) as { sessionId: string; sdp: string };
}

/** Read the tenant realtime config (admin). Never returns the key. */
export async function getRealtimeConfig(): Promise<RealtimeConfig> {
  // Probed by every tab's LiveVoiceController on mount. Coalesce concurrent reads
  // (TTL 0 = in-flight-only) so a multi-tab load is one probe; setRealtimeConfig
  // changes still reflect on the next read.
  return cachedRead('voice.realtime-config', 0, async () => {
    const res = await fetch(`${rtBase}/config`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) throw new Error(`getRealtimeConfig failed (${res.status})`);
    return (await res.json()) as RealtimeConfig;
  });
}

/** Set the tenant realtime provider + BYOK credentialRef (admin). */
export async function setRealtimeConfig(input: RealtimeConfig): Promise<RealtimeConfig> {
  const res = await fetch(`${rtBase}/config`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (!res.ok) throw new Error(`setRealtimeConfig failed (${res.status})`);
  return (await res.json()) as RealtimeConfig;
}
