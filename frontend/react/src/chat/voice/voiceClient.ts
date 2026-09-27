/**
 * Live voice mode client (ADR 0138 P3) — drives the host-extension product surface
 * `/host/openwop-app/voice/session/*`. Voice mode is the audio ADAPTER on the ONE
 * chat: this opens a session, streams mic utterances, commits them to a transcript
 * (which the caller routes into the normal chat), and voices the chat's reply with
 * barge-in. No second chat.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { cachedRead } from '../../client/requestCache.js';
import { readSseFrames } from '../../client/sseFrames.js';
import { readErrorCode, readErrorMessage } from '../../client/errorEnvelope.js';

const base = `${config.baseUrl}/host/openwop-app/voice/session`;
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

/** A voice API failure that preserves the backend `error.code` (e.g.
 *  `transcription_unsupported`, `speech_synthesis_unsupported`) so the walkie /
 *  boardroom loop can tell "not configured" apart from a transient failure and
 *  surface an honest, actionable message instead of dead-ending silently. */
export class VoiceApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'VoiceApiError';
  }
}

async function ok<T>(res: Response, op: string): Promise<T> {
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `${op} failed (${res.status})`;
    try {
      // The canonical envelope (rest-endpoints.md §"Error response shape") is
      // FLAT — `{ error: "<code>", message, details? }` — so `error` is the code
      // STRING, not a nested object. This read used to be `body.error.code` /
      // `body.error.message`, which is `undefined` against a string: every backend
      // code and message was silently dropped and callers only ever saw the
      // `http_<status>` fallback. That killed the whole point of this class —
      // `useVoiceMode`'s `transcription_unsupported` / `speech_synthesis_unsupported`
      // branches could never match, so "STT unavailable" degraded to a bare status.
      //
      // H27 — the flat-vs-nested tolerance used to be hand-rolled HERE, and two
      // other clients hand-rolled their own (differently, and wrongly). It now
      // lives in the one `client/errorEnvelope` reader.
      const body: unknown = await res.json();
      code = readErrorCode(body) ?? code;
      message = readErrorMessage(body) ?? message;
    } catch { /* non-JSON error body — keep the status fallback */ }
    throw new VoiceApiError(code, message, res.status);
  }
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

/** Voice the agent's reply text (the chat produced it). Returns the audio asset + chunks.
 *  ADR 0304 P1 — the optional `agentId` names THIS turn's speaker (a board voice session
 *  speaks turns from different advisors); the host resolves that agent's configured voice. */
export async function speakReply(sessionId: string, text: string, agentId?: string): Promise<SpeakResult> {
  const res = await fetch(`${base}/${encodeURIComponent(sessionId)}/speak`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text, ...(agentId ? { agentId } : {}) }) }));
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
const rtBase = `${config.baseUrl}/host/openwop-app/voice/realtime`;

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
  /** ADR 0277 OQ-1 — context blocks that failed to compose at mint (names only). */
  degraded?: string[];
}
export interface RealtimeConfig { provider: RealtimeProviderId | 'off'; credentialRef?: string; model?: string }

/** Open a realtime session: mint a token + get the browser session config, or `null` when no
 *  realtime provider is configured (→ caller falls back to the walkie-talkie). */
export async function openRealtimeSession(input: { agentId?: string; conversationId?: string }): Promise<RealtimeSessionConfig | null> {
  const res = await fetch(`${rtBase}/session`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  // Through `ok()` so the mint failure the host actually reports — `credential_required`
  // / `credential_unavailable` ("the realtime voice provider key could not be resolved",
  // i.e. the tenant's config points at a deleted BYOK ref) — reaches `useRealtimeVoice`'s
  // `setError` instead of collapsing to an unactionable "failed (400)".
  const data = await ok<{ realtime: RealtimeSessionConfig | null; hostSessionId?: string; degraded?: string[] }>(res, 'openRealtimeSession');
  if (!data.realtime) return null;
  return { ...data.realtime, ...(data.hostSessionId ? { hostSessionId: data.hostSessionId } : {}), ...(data.degraded ? { degraded: data.degraded } : {}) };
}

/** OpenAI sideband (ADR 0141 RT-4): the browser POSTs its WebRTC offer to the HOST, which
 *  mediates the SDP to OpenAI, owns the session (call_id), and runs the server-side sideband
 *  (tools + transcripts). Returns the answer SDP — the browser keeps only the audio, holds no
 *  session id, relays no tools, and never receives an OpenAI token. */
export async function connectOpenAiRealtime(input: { sdp: string; agentId?: string; conversationId?: string }): Promise<{ sessionId: string; sdp: string; degraded?: string[] }> {
  const res = await fetch(`${rtBase}/openai/connect`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  // Same reason as openRealtimeSession — this is the OpenAI twin and raises the
  // identical credential_required / credential_unavailable 400s.
  return ok<{ sessionId: string; sdp: string; degraded?: string[] }>(res, 'connectOpenAiRealtime');
}

/** Subscribe to a conversation's live transcript frames (the OpenAI path: the sideband
 *  persists each turn server-side + publishes a per-conversation frame; the browser holds
 *  audio-only WebRTC and never sees a transcript, so this SSE is the sole live signal). Fires
 *  `onMessage` per frame; the caller reloads the thread from the durable store. Auto-reconnects
 *  with backoff (via `sseBaseUrl` to bypass the CDN's SSE buffering). Returns an unsubscribe. */
export function subscribeVoiceTranscripts(conversationId: string, onMessage: () => void): () => void {
  const sub = new AbortController();
  const url = `${config.sseBaseUrl}/host/openwop-app/voice/realtime/messages/stream?conversationId=${encodeURIComponent(conversationId)}`;
  let attempt = 0;
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    sub.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  void (async () => {
    while (!sub.signal.aborted) {
      try {
        // CS-CH-1 — declare the stream intent so the per-IP limiter's SSE
        // exemption matches (path ∧ Accept) instead of burning request budget.
        const res = await fetch(url, { method: 'GET', headers: { ...authedHeaders(), accept: 'text/event-stream' }, credentials: 'include', signal: sub.signal });
        // Terminal: not visible / unavailable (404/405) AND auth loss (401/403) —
        // retrying an expired session forever would just hammer the backend with
        // backoff traffic for the rest of the voice call.
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 405) return;
        if (res.ok && res.body) {
          attempt = 0; // a successful connect resets the backoff
          for await (const frame of readSseFrames(res.body, sub.signal)) {
            if (frame.event === 'chat.message') onMessage();
          }
        }
      } catch { /* aborted / network — fall through to backoff */ }
      if (sub.signal.aborted) break;
      attempt += 1;
      const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
      await sleep(cap / 2 + Math.random() * (cap / 2));
    }
  })();
  return () => sub.abort();
}

/** GRADE-4 — the NON-PRIVILEGED capability probe (provider id only). Every voice
 *  surface probe (LiveVoiceController, useRealtimeVoice, useVoiceTranscriptStream)
 *  rides this; the superadmin GET /config below is for the ADMIN panel only —
 *  probing it from member sessions 403'd and silently degraded realtime voice to
 *  the walkie fallback for every non-superadmin user. */
export async function getRealtimeCapability(): Promise<{ provider: RealtimeProviderId | 'off' }> {
  return cachedRead('voice.realtime-capability', 0, async () => {
    const res = await fetch(`${rtBase}/capability`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) throw new Error(`getRealtimeCapability failed (${res.status})`);
    return (await res.json()) as { provider: RealtimeProviderId | 'off' };
  });
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
  // The admin card renders this message in a <Notice>, so the host's reason
  // (validation_error / forbidden) must survive the throw.
  return ok<RealtimeConfig>(res, 'setRealtimeConfig');
}

/** A7 (ADR 0467 follow-on) — resolve a HELD sideband tool call from the chat
 *  card. `gone` = already resolved or the call ended (404). */
export async function resolveHeldVoiceApproval(callId: string, fcId: string, approve: boolean): Promise<'executed' | 'denied' | 'gone'> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/voice/realtime/held-approvals/resolve`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ callId, fcId, approve }),
  }));
  if (res.status === 404 || res.status === 403) return 'gone';
  if (!res.ok) throw new Error(`resolve held approval: HTTP ${res.status}`);
  const j = await res.json() as { status?: string };
  return j.status === 'executed' ? 'executed' : 'denied';
}
