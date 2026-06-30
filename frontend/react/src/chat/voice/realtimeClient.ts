/**
 * Real-time voice client (ADR 0141) — opens the live speech-to-speech session.
 *
 *  - openai-realtime (RT-4) → WebRTC for AUDIO only; the offer is POSTed to the HOST, which
 *    mediates the SDP and runs a server-side sideband that handles tools + transcripts. The
 *    browser holds no token, no session id, and relays no tools (governed path).
 *  - gemini-live (RT-5, lower assurance) → WebSocket (BidiGenerateContent): `setup` first, then
 *    raw PCM16 mic audio via `realtimeInput.audio`; the model's PCM16 arrives in
 *    `serverContent.modelTurn.parts[].inlineData` and is scheduled for playback; tool calls
 *    relay to the host `…/voice/realtime/tool-call` bridge (no Gemini sideband exists).
 *
 * ⚠ Live WebRTC/WebSocket + audio cannot run headless; this is written to the providers'
 * current docs and is VERIFY-IN-BROWSER. The host session-bootstrap + tool bridge are tested.
 */
import { config } from '../../client/config.js';
import { authedHeaders } from '../../client/config.js';
import { connectOpenAiRealtime } from './voiceClient.js';
import type { RealtimeSessionConfig } from './voiceClient.js';

const TOOLCALL_PATH = `${config.baseUrl}/v1/host/openwop-app/voice/realtime/tool-call`;

export interface RealtimeHandle {
  stop: () => void;
}
export interface RealtimeCallbacks {
  onStatus?: (s: 'connecting' | 'live' | 'ended' | 'error') => void;
  onTranscript?: (text: string, role: 'user' | 'assistant', final: boolean) => void;
  onError?: (message: string) => void;
}
export interface RealtimeCtx { agentId?: string; sessionId: string; conversationId?: string }

/** Execute a model-requested tool call via the host bridge (allowlist + firewall + executor). */
async function bridgeToolCall(agentId: string | undefined, sessionId: string, name: string, args: Record<string, unknown>, callId: string): Promise<string> {
  try {
    const res = await fetch(TOOLCALL_PATH, {
      method: 'POST',
      headers: { ...authedHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...(agentId ? { agentId } : {}), sessionId, name, arguments: args, callId }),
    });
    const j = await res.json() as { status?: string; result?: string; reason?: string };
    if (j.status === 'ok') return j.result ?? '';
    if (j.status === 'requires_approval') return `This action needs approval: ${j.reason ?? ''}`;
    return `Not permitted: ${j.reason ?? j.status ?? 'denied'}`;
  } catch (err) {
    return `Tool call failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── OpenAI Realtime (WebRTC, host-mediated sideband — ADR 0141 RT-4) ─────────
// The browser does audio only: it makes the WebRTC offer, POSTs it to the HOST (not OpenAI),
// and applies the answer. The host owns the session (call_id), runs the server-side sideband
// that handles tool calls + captures transcripts. No OpenAI token is minted or sent to the
// browser (it never calls /session), no data channel, no client tool relay — closing the
// firewall-bypass + no-audit findings for OpenAI.
export async function startOpenAiRealtime(ctx: RealtimeCtx, cb: RealtimeCallbacks): Promise<RealtimeHandle> {
  cb.onStatus?.('connecting');
  const pc = new RTCPeerConnection();
  const audioEl = new Audio();
  audioEl.autoplay = true;
  pc.ontrack = (e) => { audioEl.srcObject = e.streams[0] ?? null; };

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  let answer: { sessionId: string; sdp: string };
  try {
    answer = await connectOpenAiRealtime({ sdp: offer.sdp ?? '', ...(ctx.agentId ? { agentId: ctx.agentId } : {}), ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) });
  } catch (err) {
    cb.onStatus?.('error'); cb.onError?.(err instanceof Error ? err.message : 'OpenAI realtime connect failed');
    pc.close(); mic.getTracks().forEach((t) => t.stop());
    throw err;
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  cb.onStatus?.('live');
  return { stop: () => { try { pc.close(); } catch { /* ignore */ } mic.getTracks().forEach((t) => t.stop()); cb.onStatus?.('ended'); } };
}

// ── Gemini Live (WebSocket; ephemeral token from /session — no host sideband yet) ────────────
export async function startGeminiRealtime(session: RealtimeSessionConfig, ctx: RealtimeCtx, cb: RealtimeCallbacks): Promise<RealtimeHandle> {
  cb.onStatus?.('connecting');
  const ws = new WebSocket(`${session.connect.url}?access_token=${encodeURIComponent(session.token)}`);
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });

  // Gemini Live wants raw PCM16 (little-endian) IN, and emits raw PCM16 OUT — NOT a container
  // format. We capture mic PCM via Web Audio (ScriptProcessor) and tag the actual context rate
  // (Gemini resamples), and play the model's PCM by scheduling buffers on a playback context.
  const inCtx = new AudioContext();
  void inCtx.resume(); // created after awaits → browsers may start it suspended; resume under the click's activation
  const source = inCtx.createMediaStreamSource(mic);
  const processor = inCtx.createScriptProcessor(4096, 1, 1);
  const player = new GeminiPcmPlayer();

  ws.onopen = () => {
    ws.send(JSON.stringify({ setup: {
      model: `models/${session.model}`,
      systemInstruction: { parts: [{ text: session.instructions }] },
      tools: session.tools.length ? [{ functionDeclarations: session.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] : [],
      generationConfig: { responseModalities: ['AUDIO'] },
      // Ask Gemini to transcribe both sides so the spoken turns are available (display/audit).
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    } }));
    processor.onaudioprocess = (e) => {
      if (ws.readyState !== ws.OPEN) return;
      const data = floatToPcm16Base64(e.inputBuffer.getChannelData(0));
      ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${Math.round(inCtx.sampleRate)}` } } }));
    };
    source.connect(processor);
    // Route through a muted gain so the processor runs without feeding the mic back to speakers.
    const sink = inCtx.createGain(); sink.gain.value = 0; processor.connect(sink); sink.connect(inCtx.destination);
    cb.onStatus?.('live');
  };
  ws.onerror = () => { cb.onStatus?.('error'); cb.onError?.('Gemini Live connection error.'); };
  ws.onmessage = (e) => { void onGeminiMessage(e.data, ws, ctx, cb, player); };
  ws.onclose = () => cb.onStatus?.('ended');

  return { stop: () => {
    try { processor.disconnect(); source.disconnect(); void inCtx.close(); player.stop(); ws.close(); } catch { /* ignore */ }
    mic.getTracks().forEach((t) => t.stop());
  } };
}

interface GeminiServerMessage {
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    outputTranscription?: { text?: string };
    inputTranscription?: { text?: string };
    interrupted?: boolean;
  };
}

async function onGeminiMessage(data: unknown, ws: WebSocket, ctx: RealtimeCtx, cb: RealtimeCallbacks, player: GeminiPcmPlayer): Promise<void> {
  const text = data instanceof Blob ? await data.text() : String(data);
  let msg: GeminiServerMessage;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.toolCall?.functionCalls?.length) {
    const responses = await Promise.all(msg.toolCall.functionCalls.map(async (fc) => ({
      id: fc.id, name: fc.name,
      response: { result: await bridgeToolCall(ctx.agentId, ctx.sessionId, fc.name ?? '', fc.args ?? {}, fc.id ?? '') },
    })));
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    return;
  }
  const sc = msg.serverContent;
  if (!sc) return;
  if (sc.interrupted) player.stop(); // user barged in → drop queued model audio
  for (const part of sc.modelTurn?.parts ?? []) {
    const inline = part.inlineData;
    if (inline?.data && (inline.mimeType ?? '').startsWith('audio/pcm')) {
      const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || 24000; // Gemini output ≈ 24kHz
      player.enqueue(inline.data, rate);
    }
  }
  if (sc.outputTranscription?.text) cb.onTranscript?.(sc.outputTranscription.text, 'assistant', true);
  if (sc.inputTranscription?.text) cb.onTranscript?.(sc.inputTranscription.text, 'user', true);
}

/** Schedules sequential PCM16 chunks gaplessly on a Web Audio context (Gemini emits ~24kHz). */
class GeminiPcmPlayer {
  private ctx: AudioContext | null = null;
  private playHead = 0;
  private readonly active = new Set<AudioBufferSourceNode>();

  enqueue(base64: string, rate: number): void {
    let ctx = this.ctx;
    if (!ctx) { ctx = this.ctx = new AudioContext(); void ctx.resume(); } // first model audio arrives off-gesture → resume
    const bytes = bytesFromBase64(base64);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const buf = ctx.createBuffer(1, samples.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) ch[i] = (samples[i] ?? 0) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    this.playHead = Math.max(this.playHead, ctx.currentTime);
    src.start(this.playHead);
    this.playHead += buf.duration;
    this.active.add(src);
    src.onended = () => this.active.delete(src);
  }

  stop(): void {
    for (const s of this.active) { try { s.stop(); } catch { /* already stopped */ } }
    this.active.clear();
    this.playHead = 0;
    if (this.ctx) { void this.ctx.close(); this.ctx = null; }
  }
}

/** Float32 [-1,1] mic samples → base64 of little-endian PCM16. */
function floatToPcm16Base64(input: Float32Array): string {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
