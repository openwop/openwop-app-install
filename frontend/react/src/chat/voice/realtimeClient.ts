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
import { resamplePcm } from './audioLevels.js';

const TOOLCALL_PATH = `${config.baseUrl}/host/openwop-app/voice/realtime/tool-call`;

export interface RealtimeHandle {
  stop: () => void;
}
/** Live analyser taps for the voice waveform (RT-8): `input` = the caller's mic,
 *  `output` = the model's speech. Either may be null until its side of the audio
 *  graph exists (e.g. Gemini's playback context is created on the first model
 *  audio). Analysis-only — nothing here is in the audible path. */
export interface VoiceAudioGraph {
  input: AnalyserNode | null;
  output: AnalyserNode | null;
}
export interface RealtimeCallbacks {
  onStatus?: (s: 'connecting' | 'live' | 'ended' | 'error') => void;
  /** RT-9c — live transcript updates. `turnId` is stable across a turn's
   *  interim (`final=false`) + settled (`final=true`) emissions so the consumer
   *  UPSERTS one streaming bubble. */
  onTranscript?: (text: string, role: 'user' | 'assistant', turnId: string, final: boolean) => void;
  onError?: (message: string) => void;
  /** Fired when an analyser becomes available (may fire again as the graph grows). */
  onAudioGraph?: (graph: VoiceAudioGraph) => void;
  /** ADR 0277 OQ-1 — context blocks that failed to compose at mint/connect
   *  (names only). Fired once, when known (OpenAI: from the connect response). */
  onDegraded?: (blocks: readonly string[]) => void;
  /** A7 (ADR 0467 follow-on) — a SENSITIVE tool call hit the firewall's
   *  require-approval verdict on the browser-relay transport. Implementations
   *  show the in-voice approval card and resolve with the text to hand the
   *  model: `approve()` re-invokes the call with the human's one-shot approval
   *  (the backend honors it only for a session with a bound user); `deny()`
   *  returns the honest refusal. No handler ⇒ the refusal text (old behavior). */
  onApprovalRequired?: (req: VoiceApprovalRequest) => Promise<string>;
}
/** The in-voice approval request handed to `onApprovalRequired`. */
export interface VoiceApprovalRequest {
  /** The wire tool name the model asked for. */
  name: string;
  /** Human-readable reason parsed from the bridge's typed refusal. */
  reason?: string;
  approve: () => Promise<string>;
  deny: () => string;
}
export interface RealtimeCtx { agentId?: string; sessionId: string; conversationId?: string }

interface BridgeOutcome { status?: string; result?: string; reason?: string }

/** Execute a model-requested tool call via the host bridge (allowlist + firewall + executor). */
async function bridgeToolCallRaw(agentId: string | undefined, sessionId: string, name: string, args: Record<string, unknown>, callId: string, userApproved?: boolean): Promise<BridgeOutcome> {
  try {
    const res = await fetch(TOOLCALL_PATH, {
      method: 'POST',
      headers: { ...authedHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...(agentId ? { agentId } : {}), sessionId, name, arguments: args, callId, ...(userApproved ? { userApproved: true } : {}) }),
    });
    return await res.json() as BridgeOutcome;
  } catch (err) {
    return { status: 'denied', reason: `Tool call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The text a bridge outcome hands the model (the pre-A7 mapping, unchanged). */
function bridgeOutcomeText(j: BridgeOutcome): string {
  if (j.status === 'ok') return j.result ?? '';
  if (j.status === 'requires_approval') return `This action needs approval: ${j.reason ?? ''}`;
  return `Not permitted: ${j.reason ?? j.status ?? 'denied'}`;
}

/** The bridge's `requires_approval` reason is a typed JSON refusal — surface its
 *  human-readable half for the card; fall back to the raw string. */
function approvalReasonOf(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  try {
    const j = JSON.parse(reason) as { message?: string; detail?: string };
    return j.detail ?? j.message ?? reason;
  } catch { return reason; }
}

/** A7 — one tool call end-to-end: execute; on require-approval let the UI show
 *  the in-voice card (approve re-invokes with the one-shot flag); otherwise the
 *  plain text mapping. */
async function bridgeToolCall(cb: RealtimeCallbacks, agentId: string | undefined, sessionId: string, name: string, args: Record<string, unknown>, callId: string): Promise<string> {
  const outcome = await bridgeToolCallRaw(agentId, sessionId, name, args, callId);
  if (outcome.status === 'requires_approval' && cb.onApprovalRequired) {
    const reason = approvalReasonOf(outcome.reason);
    return cb.onApprovalRequired({
      name,
      ...(reason ? { reason } : {}),
      approve: async () => bridgeOutcomeText(await bridgeToolCallRaw(agentId, sessionId, name, args, callId, true)),
      deny: () => bridgeOutcomeText(outcome),
    });
  }
  return bridgeOutcomeText(outcome);
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

  // RT-8: analysis-only taps for the waveform. Playback stays on the <audio> element;
  // this context only OBSERVES the mic + the remote track (never routed to speakers).
  const analysisCtx = new AudioContext();
  const graph: VoiceAudioGraph = { input: null, output: null };
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? null;
    audioEl.srcObject = stream;
    if (stream && !graph.output) {
      const out = analysisCtx.createAnalyser();
      out.fftSize = 1024;
      analysisCtx.createMediaStreamSource(stream).connect(out);
      graph.output = out;
      cb.onAudioGraph?.({ ...graph });
    }
  };

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  {
    const inA = analysisCtx.createAnalyser();
    inA.fftSize = 1024;
    analysisCtx.createMediaStreamSource(mic).connect(inA);
    graph.input = inA;
    cb.onAudioGraph?.({ ...graph });
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  let answer: { sessionId: string; sdp: string; degraded?: string[] };
  try {
    answer = await connectOpenAiRealtime({ sdp: offer.sdp ?? '', ...(ctx.agentId ? { agentId: ctx.agentId } : {}), ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) });
    if (answer.degraded && answer.degraded.length > 0) cb.onDegraded?.(answer.degraded);
  } catch (err) {
    cb.onStatus?.('error'); cb.onError?.(err instanceof Error ? err.message : 'OpenAI realtime connect failed');
    pc.close(); void analysisCtx.close(); mic.getTracks().forEach((t) => t.stop());
    throw err;
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  cb.onStatus?.('live');
  return { stop: () => { try { pc.close(); void analysisCtx.close(); } catch { /* ignore */ } mic.getTracks().forEach((t) => t.stop()); cb.onStatus?.('ended'); } };
}

/** Accumulates Gemini Live's INCREMENTAL transcription fragments into whole turns
 *  (RT-9). Fragments arrive one message at a time for both sides; a bubble per
 *  fragment would spam the thread, so we flush: the user's turn when the model
 *  starts answering (reads user → assistant in order), the assistant's turn on
 *  `turnComplete` (or barge-in / close, so partials aren't lost). Pure — unit-tested. */
export class TranscriptAccumulator {
  private user = '';
  private assistant = '';
  private userTurn = 0;
  private asstTurn = 0;
  /** `emit(text, role, turnId, final)`: interim (`final=false`) updates fire as
   *  fragments arrive so the transcript streams LIVE; the matching `final=true`
   *  fires on flush. `turnId` is stable across a turn's interim+final emissions so
   *  the consumer upserts ONE bubble instead of spamming new ones (RT-9c). */
  constructor(private readonly emit: (text: string, role: 'user' | 'assistant', turnId: string, final: boolean) => void) {}

  addUser(fragment: string): void {
    this.user += fragment;
    const t = this.user.trim();
    if (t) this.emit(t, 'user', `u${this.userTurn}`, false);
  }
  addAssistant(fragment: string): void {
    this.assistant += fragment;
    const t = this.assistant.trim();
    if (t) this.emit(t, 'assistant', `a${this.asstTurn}`, false);
  }

  /** The model started answering — commit the user's utterance first. */
  flushUser(): void {
    const t = this.user.trim();
    this.user = '';
    if (t) this.emit(t, 'user', `u${this.userTurn}`, true);
    this.userTurn += 1;
  }
  /** The model's turn completed (or was barged-in / the session closed). */
  flushAssistant(): void {
    const t = this.assistant.trim();
    this.assistant = '';
    if (t) this.emit(t, 'assistant', `a${this.asstTurn}`, true);
    this.asstTurn += 1;
  }
  /** Session teardown — nothing accumulated may be silently dropped. */
  flushAll(): void { this.flushUser(); this.flushAssistant(); }
}

/** Gemini Live's REQUIRED input rate. The API expects 16 kHz PCM16 mono — sending the
 *  device rate with an honest tag was the "listens but never answers" failure (RT-9). */
const GEMINI_INPUT_RATE = 16000;

// ── Gemini Live (WebSocket; ephemeral token from /session — no host sideband yet) ────────────
export async function startGeminiRealtime(session: RealtimeSessionConfig, ctx: RealtimeCtx, cb: RealtimeCallbacks): Promise<RealtimeHandle> {
  cb.onStatus?.('connecting');
  // RT-9d: acquire the mic BEFORE opening the socket. A WebSocket does NOT buffer its
  // `open` event — if the socket is created first and we then `await getUserMedia`, the
  // socket can connect and fire `open` during that await, before `ws.onopen` is attached
  // below. The lost `open` means the mandatory `setup` frame is never sent, Gemini never
  // replies `setupComplete`, capture never starts, and the pill hangs on "Connecting…"
  // with a live mic but nothing streamed. Everything from here to the handler wiring is
  // synchronous, so `onopen` is guaranteed attached before the socket can open. Do NOT
  // reintroduce an `await` between the `new WebSocket` and the handler assignments.
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ws = new WebSocket(`${session.connect.url}?access_token=${encodeURIComponent(session.token)}`);

  // Gemini Live wants raw PCM16 (little-endian) IN at 16 kHz, and emits raw PCM16 OUT —
  // NOT a container format. RT-9a: the capture context runs at the mic's NATIVE rate
  // (forcing a 16 kHz AudioContext trips Chrome's MediaStreamSource rate limitation —
  // the "stops as soon as I start talking" failure) and the WORKLET downsamples to
  // 16 kHz; playback schedules the model's PCM on its own context.
  const inCtx = new AudioContext();
  void inCtx.resume(); // created after awaits → browsers may start it suspended; resume under the click's activation
  const source = inCtx.createMediaStreamSource(mic);
  // RT-8: analysis-only taps for the waveform (parallel branches; not in the audible path).
  const graph: VoiceAudioGraph = { input: null, output: null };
  {
    const inA = inCtx.createAnalyser();
    inA.fftSize = 1024;
    source.connect(inA);
    graph.input = inA;
    cb.onAudioGraph?.({ ...graph });
  }
  const player = new GeminiPcmPlayer((out) => { graph.output = out; cb.onAudioGraph?.({ ...graph }); });
  let stopCapture: (() => void) | null = null;

  // Both capture paths deliver 16 kHz samples (the worklet resamples internally; the
  // fallback resamples here) — the tag is always the TRUE rate of the payload.
  const sendPcm = (samples: Float32Array): void => {
    if (ws.readyState !== ws.OPEN) return;
    const data = floatToPcm16Base64(samples);
    ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } } }));
  };

  // RT-8: capture via an AudioWorklet (off the main thread; ScriptProcessorNode is
  // deprecated). The worklet module ships as a same-origin Vite asset, so CSP
  // `script-src 'self'` covers `addModule`. ScriptProcessor remains ONLY as the
  // fallback where audioWorklet is unavailable (older Safari).
  const startCapture = async (): Promise<void> => {
    if (inCtx.audioWorklet) {
      await inCtx.audioWorklet.addModule(new URL('./pcmCaptureWorklet.js', import.meta.url));
      // 0 outputs → nothing to route to the destination, so no muted-gain sink (and no
      // feedback path at all); the worklet downsamples to 16 kHz and posts 2048-sample
      // chunks (128 ms).
      const node = new AudioWorkletNode(inCtx, 'openwop-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = (e: MessageEvent) => sendPcm(e.data as Float32Array);
      source.connect(node);
      stopCapture = () => { node.port.onmessage = null; node.disconnect(); };
      return;
    }
    const processor = inCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => sendPcm(resamplePcm(e.inputBuffer.getChannelData(0), inCtx.sampleRate, GEMINI_INPUT_RATE));
    source.connect(processor);
    // A ScriptProcessor only runs when routed to the destination — mute the path so the
    // mic isn't fed back to the speakers.
    const sink = inCtx.createGain(); sink.gain.value = 0; processor.connect(sink); sink.connect(inCtx.destination);
    stopCapture = () => { processor.onaudioprocess = null; processor.disconnect(); sink.disconnect(); };
  };

  // RT-9: transcripts accumulate per side and flush as whole turns into the chat.
  // Prefix turn ids with this session's id so a stop→start (new accumulator, counters
  // reset) never collides bubble ids with the prior session's transcripts.
  const transcripts = new TranscriptAccumulator((text, role, turnId, final) => cb.onTranscript?.(text, role, `${ctx.sessionId}:${turnId}`, final));
  let wentLive = false;

  // The first client message MUST be `setup`. With the RT-7 token-locked setup the
  // server takes the effective config entirely from the token and IGNORES this
  // message's content — but sending it still drives the handshake to `setupComplete`.
  let setupSent = false;
  const sendSetup = (): void => {
    if (setupSent || ws.readyState !== ws.OPEN) return;
    setupSent = true;
    ws.send(JSON.stringify({ setup: {
      model: `models/${session.model}`,
      systemInstruction: { parts: [{ text: session.instructions }] },
      tools: session.tools.length ? [{ functionDeclarations: session.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] : [],
      generationConfig: { responseModalities: ['AUDIO'] },
      // Ask Gemini to transcribe both sides so the spoken turns are available (display/audit).
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    } }));
  };
  ws.onopen = sendSetup;
  // RT-9: capture starts on the server's `setupComplete` — not on socket open — so we
  // never stream audio into a session the server hasn't accepted, and "live" means the
  // server actually said so.
  const onSetupComplete = (): void => {
    if (wentLive) return;
    wentLive = true;
    startCapture()
      .then(() => cb.onStatus?.('live'))
      .catch((err) => { cb.onStatus?.('error'); cb.onError?.(err instanceof Error ? err.message : 'Audio capture failed.'); });
  };
  ws.onerror = () => { cb.onStatus?.('error'); cb.onError?.('Gemini Live connection error.'); };
  ws.onmessage = (e) => { void onGeminiMessage(e.data, ws, ctx, cb, player, transcripts, onSetupComplete); };
  ws.onclose = (e) => {
    transcripts.flushAll();
    // RT-9: a session the server refused/dropped previously died SILENTLY (the pill just
    // kept "listening"). Abnormal close — or never reaching setupComplete — is an error
    // the user must see, with the server's code/reason (e.g. an invalid model).
    if (!wentLive || (e.code !== 1000 && e.code !== 1005)) {
      cb.onStatus?.('error');
      cb.onError?.(`Gemini Live closed (${e.code}${e.reason ? `: ${e.reason}` : ''})${wentLive ? '' : ' before setup completed'}.`);
      return;
    }
    cb.onStatus?.('ended');
  };
  // Insurance against the lost-`open` race (RT-9d): if the socket already reached OPEN
  // before we finished wiring handlers, `onopen` never fires — send `setup` now.
  if (ws.readyState === ws.OPEN) sendSetup();

  return { stop: () => {
    transcripts.flushAll();
    try { stopCapture?.(); source.disconnect(); void inCtx.close(); player.stop(); ws.close(); } catch { /* ignore */ }
    mic.getTracks().forEach((t) => t.stop());
  } };
}

interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>;
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    outputTranscription?: { text?: string };
    inputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  error?: { message?: string; code?: number };
}

async function onGeminiMessage(data: unknown, ws: WebSocket, ctx: RealtimeCtx, cb: RealtimeCallbacks, player: GeminiPcmPlayer, transcripts: TranscriptAccumulator, onSetupComplete: () => void): Promise<void> {
  const text = data instanceof Blob ? await data.text() : String(data);
  let msg: GeminiServerMessage;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.setupComplete) { onSetupComplete(); return; }
  if (msg.error) { cb.onError?.(`Gemini Live error${msg.error.code ? ` (${msg.error.code})` : ''}: ${msg.error.message ?? 'unknown'}`); return; }

  if (msg.toolCall?.functionCalls?.length) {
    const responses = await Promise.all(msg.toolCall.functionCalls.map(async (fc) => ({
      id: fc.id, name: fc.name,
      response: { result: await bridgeToolCall(cb, ctx.agentId, ctx.sessionId, fc.name ?? '', fc.args ?? {}, fc.id ?? '') },
    })));
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    return;
  }
  const sc = msg.serverContent;
  if (!sc) return;
  if (sc.interrupted) {
    player.stop(); // user barged in → drop queued model audio
    transcripts.flushAssistant(); // …but keep what it SAID so far as the bubble
  }
  const modelSpoke = (sc.modelTurn?.parts ?? []).length > 0 || !!sc.outputTranscription?.text;
  // The model started answering → the user's utterance is complete; commit it first
  // so the thread reads user → assistant in order.
  if (modelSpoke) transcripts.flushUser();
  for (const part of sc.modelTurn?.parts ?? []) {
    const inline = part.inlineData;
    if (inline?.data && (inline.mimeType ?? '').startsWith('audio/pcm')) {
      const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || 24000; // Gemini output ≈ 24kHz
      player.enqueue(inline.data, rate);
    }
  }
  // RT-9: transcription fragments are INCREMENTAL — accumulate, don't emit per-message.
  if (sc.inputTranscription?.text) transcripts.addUser(sc.inputTranscription.text);
  if (sc.outputTranscription?.text) transcripts.addAssistant(sc.outputTranscription.text);
  if (sc.turnComplete) transcripts.flushAssistant();
}

/** Schedules sequential PCM16 chunks gaplessly on a Web Audio context (Gemini emits ~24kHz). */
class GeminiPcmPlayer {
  private ctx: AudioContext | null = null;
  private playHead = 0;
  private readonly active = new Set<AudioBufferSourceNode>();
  private analyser: AnalyserNode | null = null;

  /** `onAnalyser` (RT-8) fires once, when the lazily-created playback context exists —
   *  the waveform's output tap. Sources route THROUGH the analyser to the destination,
   *  so it observes exactly what is audible. */
  constructor(private readonly onAnalyser?: (a: AnalyserNode) => void) {}

  enqueue(base64: string, rate: number): void {
    let ctx = this.ctx;
    if (!ctx) {
      ctx = this.ctx = new AudioContext();
      void ctx.resume(); // first model audio arrives off-gesture → resume
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(ctx.destination);
      this.onAnalyser?.(this.analyser);
    }
    const bytes = bytesFromBase64(base64);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const buf = ctx.createBuffer(1, samples.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) ch[i] = (samples[i] ?? 0) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(this.analyser ?? ctx.destination);
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
    this.analyser = null;
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
