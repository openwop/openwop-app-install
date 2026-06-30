/**
 * Speech-synthesis (text-to-speech) provider dispatch — RFC 0105.
 *
 * MiniMax T2A (text-to-audio) is the wired managed speech provider. The
 * endpoint returns the synthesized audio as a HEX-encoded string under
 * `data.audio`; this module converts hex → Buffer → base64 and hands the
 * adapter a base64 blob + MIME so it can store a tenant-scoped asset.
 *
 * Dependency-free: uses global `fetch` (mirrors `dispatchMiniMaxTools.ts`).
 * One call = one speaker turn, whole-file (no streaming), plain text.
 *
 * @see https://api.minimax.io/v1/t2a_v2
 */

const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
const DEFAULT_SPEECH_MODEL = 'speech-2.5-hd-preview';

/** A `voiceId` is OPAQUE host-resolved per RFC 0105 §A — a caller MAY pass any
 *  string (e.g. `host:narrator-test`), and the host maps it to a real provider
 *  voice. We pass a known MiniMax system voice through verbatim, and resolve any
 *  unknown/opaque id to a stable default so synthesis always succeeds (the
 *  response still ECHOES the caller's original `voiceId`, set in the adapter). */
const DEFAULT_MINIMAX_VOICE = 'male-qn-qingse';
const KNOWN_MINIMAX_VOICES: ReadonlySet<string> = new Set([
  // Chinese system voices
  'male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng',
  'female-shaonv', 'female-yujie', 'female-chengshu', 'female-tianmei',
  'presenter_male', 'presenter_female',
  'audiobook_male_1', 'audiobook_male_2', 'audiobook_female_1', 'audiobook_female_2',
  // English system voices
  'English_expressive_narrator', 'English_radiant_girl', 'English_magnetic_voiced_man',
  'English_compelling_lady1', 'Wise_Woman', 'Friendly_Person', 'Deep_Voice_Man',
  'Calm_Woman', 'Casual_Guy', 'Lively_Girl', 'Patient_Man', 'Elegant_Man',
]);

/** Map an opaque host `voiceId` to a real MiniMax `voice_id`. Known system
 *  voices pass through; anything else (opaque/`host:*`/unknown) falls back to
 *  the default. Exported for unit testing. */
export function resolveMiniMaxVoice(voiceId: string): string {
  return KNOWN_MINIMAX_VOICES.has(voiceId) ? voiceId : DEFAULT_MINIMAX_VOICE;
}

/** Convert a MiniMax hex-encoded audio payload to base64. Exported so the
 *  conversion can be unit-tested in isolation without a network call. */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

export interface DispatchSpeechArgs {
  apiKey: string;
  model?: string;
  text: string;
  voiceId: string;
  speed?: number;
  languageCode?: string;
  /** Abort signal from the host timeout wrapper — threaded into the provider
   *  `fetch` so a hung TTS call is actually cancelled (socket released) on
   *  timeout, not merely abandoned by the caller (RFC 0105; mirrors the callAI
   *  path). */
  signal?: AbortSignal;
}

export interface DispatchSpeechResult {
  contentBase64: string;
  mimeType: string;
  model: string;
  generationTimeMs: number;
}

interface MiniMaxT2AResponse {
  data?: { audio?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

/**
 * Synthesize one speaker turn via MiniMax T2A. Throws an `Error` (with
 * an HTTP status + body snippet) on non-2xx or a missing audio payload;
 * the adapter maps the throw to `speech_synthesis_failed`.
 */
export async function dispatchSpeechMiniMax(args: DispatchSpeechArgs): Promise<DispatchSpeechResult> {
  const baseUrl = (process.env.MINIMAX_BASE_URL ?? MINIMAX_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = args.model ?? DEFAULT_SPEECH_MODEL;
  const startedAt = Date.now();

  const res = await fetch(`${baseUrl}/t2a_v2`, {
    method: 'POST',
    ...(args.signal ? { signal: args.signal } : {}),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model,
      text: args.text,
      stream: false,
      voice_setting: {
        voice_id: resolveMiniMaxVoice(args.voiceId),
        speed: args.speed ?? 1.0,
      },
      audio_setting: {
        format: 'mp3',
        sample_rate: 32000,
      },
    }),
  });

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`minimax_t2a_${res.status}: ${snippet}`);
  }

  const body = (await res.json().catch(() => ({}))) as MiniMaxT2AResponse;
  const hex = body.data?.audio;
  if (typeof hex !== 'string' || hex.length === 0) {
    const status = body.base_resp?.status_code;
    const msg = body.base_resp?.status_msg ?? 'no audio in response';
    throw new Error(`minimax_t2a_no_audio: status_code=${status ?? 'unknown'} ${msg}`.slice(0, 300));
  }

  return {
    contentBase64: hexToBase64(hex),
    mimeType: 'audio/mpeg',
    model,
    generationTimeMs: Date.now() - startedAt,
  };
}

// ── OpenAI TTS (BYOK) ─────────────────────────────────────────────────────────
// https://platform.openai.com/docs/api-reference/audio/createSpeech — returns the
// synthesized audio as raw bytes (mp3 here). One call = one speaker turn.

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts';
const OPENAI_DEFAULT_VOICE = 'alloy';
const KNOWN_OPENAI_VOICES: ReadonlySet<string> = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
]);

/** Map an opaque host `voiceId` to a real OpenAI voice (known passes through; else
 *  the default). Exported for unit testing. */
export function resolveOpenAIVoice(voiceId: string): string {
  return KNOWN_OPENAI_VOICES.has(voiceId) ? voiceId : OPENAI_DEFAULT_VOICE;
}

export async function dispatchSpeechOpenAI(args: DispatchSpeechArgs): Promise<DispatchSpeechResult> {
  const baseUrl = (process.env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = args.model ?? OPENAI_DEFAULT_SPEECH_MODEL;
  const startedAt = Date.now();

  const res = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    ...(args.signal ? { signal: args.signal } : {}),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({
      model,
      input: args.text,
      voice: resolveOpenAIVoice(args.voiceId),
      response_format: 'mp3',
      ...(args.speed != null ? { speed: args.speed } : {}),
    }),
  });

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`openai_tts_${res.status}: ${snippet}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('openai_tts_no_audio: empty response body');
  return { contentBase64: buf.toString('base64'), mimeType: 'audio/mpeg', model, generationTimeMs: Date.now() - startedAt };
}

// ── Google Gemini TTS (BYOK) ──────────────────────────────────────────────────
// https://ai.google.dev/gemini-api/docs/speech-generation — generateContent with
// responseModalities:['AUDIO'] returns inline PCM (audio/L16). We wrap it in a WAV
// container so the stored asset is directly playable (the same generativelanguage
// API key the `google` provider already uses for chat).

const GOOGLE_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GOOGLE_DEFAULT_SPEECH_MODEL = 'gemini-2.5-flash-preview-tts';
const GOOGLE_DEFAULT_VOICE = 'Kore';
const KNOWN_GOOGLE_VOICES: ReadonlySet<string> = new Set([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]);

/** Map an opaque host `voiceId` to a real Gemini prebuilt voice. Exported for tests. */
export function resolveGoogleVoice(voiceId: string): string {
  return KNOWN_GOOGLE_VOICES.has(voiceId) ? voiceId : GOOGLE_DEFAULT_VOICE;
}

/** Wrap raw little-endian PCM (s16) in a minimal 44-byte WAV header so the bytes
 *  are a self-describing, directly-playable asset. Exported for unit testing. */
export function pcmToWav(pcmBase64: string, sampleRate: number, channels = 1, bitsPerSample = 16): string {
  const pcm = Buffer.from(pcmBase64, 'base64');
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

interface GeminiTtsResponse {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
}

export async function dispatchSpeechGoogle(args: DispatchSpeechArgs): Promise<DispatchSpeechResult> {
  const baseUrl = (process.env.GOOGLE_BASE_URL ?? GOOGLE_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = args.model ?? GOOGLE_DEFAULT_SPEECH_MODEL;
  const startedAt = Date.now();

  const res = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(args.apiKey)}`, {
    method: 'POST',
    ...(args.signal ? { signal: args.signal } : {}),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: args.text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: resolveGoogleVoice(args.voiceId) } } },
      },
    }),
  });

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`google_tts_${res.status}: ${snippet}`);
  }
  const body = (await res.json().catch(() => ({}))) as GeminiTtsResponse;
  const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  const data = part?.inlineData?.data;
  if (typeof data !== 'string' || data.length === 0) throw new Error('google_tts_no_audio: no inline audio in response');
  // Gemini returns raw PCM as `audio/L16;rate=NNNNN` (24 kHz default). Wrap → WAV.
  const rateMatch = /rate=(\d+)/.exec(part?.inlineData?.mimeType ?? '');
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  return { contentBase64: pcmToWav(data, sampleRate), mimeType: 'audio/wav', model, generationTimeMs: Date.now() - startedAt };
}

const ELEVENLABS_DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const ELEVENLABS_DEFAULT_MODEL = 'eleven_turbo_v2_5'; // low-latency model for conversational voice

/**
 * Synthesize one turn via ElevenLabs (ADR 0138 P3) — BYOK. `voiceId` is the
 * ElevenLabs voice id (in the path); the per-agent voice
 * (`agentProfile.configParameters.voice.voiceId`) flows straight through. Returns
 * mp3 bytes; throws (status + body snippet) on non-2xx → mapped to
 * `speech_synthesis_failed` by the adapter (mirrors the OpenAI/Google paths).
 */
export async function dispatchSpeechElevenLabs(args: DispatchSpeechArgs): Promise<DispatchSpeechResult> {
  const baseUrl = (process.env.ELEVENLABS_BASE_URL ?? ELEVENLABS_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = args.model ?? ELEVENLABS_DEFAULT_MODEL;
  const startedAt = Date.now();

  const res = await fetch(`${baseUrl}/v1/text-to-speech/${encodeURIComponent(args.voiceId)}`, {
    method: 'POST',
    ...(args.signal ? { signal: args.signal } : {}),
    headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': args.apiKey },
    body: JSON.stringify({
      text: args.text,
      model_id: model,
      ...(args.languageCode ? { language_code: args.languageCode } : {}),
    }),
  });

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`elevenlabs_tts_${res.status}: ${snippet}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('elevenlabs_tts_no_audio: empty response body');
  return { contentBase64: buf.toString('base64'), mimeType: 'audio/mpeg', model, generationTimeMs: Date.now() - startedAt };
}
