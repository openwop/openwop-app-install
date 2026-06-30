/**
 * AI providers host adapter.
 *
 * Implements `ctx.callAI(...)` / `ctx.callAIWithTools(...)` per the
 * normative contract in `spec/v1/host-capabilities.md §host.aiProviders`.
 * The factory is per-call: the executor builds one adapter per node
 * dispatch, scoped to that run's (runId, nodeId, attempt) so the
 * invocation-log cache key is deterministic and replay-safe.
 *
 * The implementation is structured as a pipeline:
 *
 *   validate provider              ← `provider_not_supported`
 *     → resolve policy             ← `provider_policy_denied` (4 modes)
 *     → resolve credential         ← `byok_required_but_unresolved`
 *     → invocation-log lookup      (replay-deterministic cache)
 *     → dispatch (Anthropic/OpenAI/Google)
 *     → emit cost
 *     → cache result (sans secret)
 *     → return normalized AiCallResult
 *
 * SECURITY invariants enforced inline:
 *   - cleartext API keys NEVER cross the return boundary
 *   - cleartext API keys NEVER reach `ctx.emit()`
 *   - cleartext API keys NEVER reach the invocation-log cache
 *   - the return surface carries `credentialRefHashed: sha256(ref)`
 *     so callers can correlate without exposing the key
 *
 * @see spec/v1/host-capabilities.md §host.aiProviders
 * @see spec/v1/capabilities.md §"aiProviders policies" (lines 246-289)
 * @see spec/v1/replay.md §"AI determinism"
 */

import { createHash } from 'node:crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type {
  AiCallRequest,
  AiCallResult,
  AiToolCallRequest,
  AiToolCallResult,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  TranscribeRequest,
  TranscriptResult,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '../executor/types.js';
import { dispatchImageGeneration, imageProviderConfigured } from '../host/imageProviderAdapter.js';
import { checkImageBudget, recordImages } from '../host/imageGenBudget.js';
import type { AiProviderPolicy, ProviderPolicyResolver } from '../host/index.js';
import { dispatchChat, type ChatMessage, type ProviderId } from '../providers/dispatch.js';
import { dispatchAnthropicToolsRound, type ToolsRoundRequest, type ToolsRoundResult } from '../providers/dispatchAnthropicTools.js';
import { dispatchOpenAIToolsRound, dispatchGoogleToolsRound, dispatchMiniMaxToolsRound } from '../providers/dispatchProviderTools.js';
import { embedText, DEFAULT_EMBEDDING_DIMS, LOCAL_EMBEDDING_MODEL } from './localEmbedding.js';
import {
  dispatchManagedChat,
  isManagedCredentialRef,
  managedProviderIdFromRef,
  resolveManagedSpeechKey,
  ManagedProviderError,
} from '../providers/managedProvider.js';
import { dispatchSpeechMiniMax, dispatchSpeechOpenAI, dispatchSpeechGoogle, dispatchSpeechElevenLabs } from '../providers/dispatchSpeech.js';
import { storeMediaAsset, resolveMediaAsset } from '../host/inMemorySurfaces.js';
import { AUDIO_TRANSCRIPTION_SYSTEM_PROMPT, AUDIO_TRANSCRIPTION_USER_PROMPT } from './mediaTranscriptionPrompts.js';
import { emitCost } from '../observability/costEmitter.js';
import { checkMediaBudget, recordMediaUsage } from './mediaBudget.js';
import { getStreamAudioResolver } from './streamAudio.js';
import { buildProviderUsagePayloadFromTokens } from '../providers/usageEmitter.js';
import { compactToolSchema } from '../providers/toolSchemaCompaction.js';
import { contextEconomy } from '../host/contextEconomy.js';
import { getInvocationLog } from '../executor/invocationLog.js';
import { createLogger } from '../observability/logger.js';
// RFC 0030 §A reasoning-directive synthesis lifted to @openwop/openwop@^1.1.3.
// The byte-identical helper at host/envelopeDirective.ts is now a type-only
// re-export shim — see that file for the rationale (envelopeReasoningConfig.ts
// still imports `ReasoningDirectiveStrength` from it; lifting that is a
// follow-up commit).
import { buildReasoningDirective } from '@openwop/openwop';
import { getEnvelopeReasoningConfig } from '../host/envelopeReasoningConfig.js';
import { getEnvelopeReliabilityConfig } from '../host/envelopeReliabilityConfig.js';
import {
  buildRetryAttemptedPayload,
  buildRetryExhaustedPayload,
  buildRefusalPayload,
  buildTruncatedPayload,
  buildRecoveryAppliedPayload,
  classifyTruncationStopReason,
  isRefusalFinishReason,
  tryLenientParse,
  type RetryReason,
} from '../host/envelopeReliabilityEmit.js';

const log = createLogger('aiProviders.host');

/** Providers the sample's `providers/dispatch.ts` knows how to dispatch. */
// `mock` is conformance-only — present unconditionally so RFC 0032/0033
// test fixtures can route `provider: 'mock'` through dispatchStructured.
// Production deployments are unaffected; the mock provider returns only
// what the test seam pre-programs via `POST /v1/host/openwop-app/test/mock-ai/
// program` keyed by (runId, nodeId), so a tenant that hasn't seeded a
// program for its run gets empty completions.
// `minimax` is advertised in discovery `aiProviders.supported[]` (RFC 0105 §A —
// the speech `provider?` arg MUST be in supported[]) and is genuinely routable:
// dispatch.ts has a `minimax` chat case, and the speech path routes it via the
// managed MiniMax T2A key — so listing it here keeps the advertised supported[]
// honest across both callAI and callSpeechSynthesizer.
const SUPPORTED_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google', 'minimax', 'mock'];

/** Anthropic is the only provider with a wired tool-calling path
 *  (`providers/dispatchAnthropicTools.ts`). Advertised via
 *  `capabilities.aiProviders.toolCalling.providers` so packs that
 *  request tools on other providers fail with a clear, gated error. */
const TOOL_CALLING_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google', 'minimax'];

/** True iff this host can offer native tool-calling for `provider` (the advertised
 *  `aiProviders.toolCalling.providers`). Lets a caller (e.g. the chat conversation)
 *  fall back to a plain completion instead of failing when the run's provider has
 *  no tool-calling path. */
export function providerSupportsToolCalling(provider: string): boolean {
  return (TOOL_CALLING_PROVIDERS as readonly string[]).includes(provider);
}

/** Route a single tool-calling round to the provider-specific dispatcher. All
 *  return the shared `ToolsRoundResult` shape (A3). */
function toolsRoundDispatcher(provider: string): (req: ToolsRoundRequest) => Promise<ToolsRoundResult> {
  switch (provider) {
    case 'openai':
      return dispatchOpenAIToolsRound;
    case 'google':
      return dispatchGoogleToolsRound;
    case 'minimax':
      return dispatchMiniMaxToolsRound;
    default:
      return dispatchAnthropicToolsRound;
  }
}

/** Default per-call timeout for upstream provider requests. Bound by
 *  `AbortController` so a hung provider can't hang the run. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AdapterScope {
  runId: string;
  nodeId: string;
  tenantId: string;
  scopeId?: string;
  attempt: number;
  secrets: Record<string, string>;
  policyResolver: ProviderPolicyResolver;
  /** Optional per-call timeout override. Defaults to 120s. */
  timeoutMs?: number;
  /**
   * RFC 0026 — `provider.usage` event emitter. When present, the adapter
   * fires one `provider.usage` event per upstream provider invocation
   * from inside `dispatchPlain` (so `dispatchStructured`'s parse-retry
   * loop produces one event per attempt). Invocation-log cache hits
   * return early in `callAI` before reaching the dispatch layer, so no
   * duplicate event is written — the original call's event was already
   * persisted on the first invocation and is available to SSE / webhook
   * subscribers and fork replay via `replay.md §"Forking + resumption"`.
   *
   * The cleartext credential is never read at the emission site.
   * Wired from the executor's per-node ctx so the event lands in the
   * same run event log with the same nodeId.
   */
  emit?: (type: string, payload: unknown) => Promise<{ eventId: string; sequence: number }>;
}

/** RFC 0026 — best-effort `provider.usage` emit. Swallows emit errors so
 *  a downstream event-log failure can't fail the LLM call itself; logs
 *  for visibility. Built from the normalized token counts that
 *  `dispatchChat`/`dispatchAnthropicToolsRound`/`dispatchManagedChat`
 *  return — credentialRef and prompt/response text are never touched. */
async function emitProviderUsage(
  scope: AdapterScope,
  provider: string,
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  /** ADR 0148 A2 — set the wire-legal `providerUsage.cacheHit` (already in the
   *  RFC 0026 schema) when a prompt-cache READ occurred this call. The finer
   *  token split stays internal (OTel span); it is NOT added to the payload
   *  (schema is additionalProperties:false). */
  cacheHit?: boolean,
  /** RFC 0116 — cost-only prompt-prefix cache token split (provider-reported).
   *  Emitted on the wire-legal `providerUsage.cacheReadTokens`/`cacheWriteTokens`
   *  (1.43.0 schema); cost-only, NOT replay-asserted. */
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): Promise<void> {
  if (!scope.emit) return;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return;
  try {
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    const payload = buildProviderUsagePayloadFromTokens(provider, model, inputTokens, outputTokens, {
      nodeId: scope.nodeId,
      ...(traceId ? { traceId } : {}),
      ...(cacheHit ? { cacheHit: true } : {}),
      ...(typeof cacheReadTokens === 'number' ? { cacheReadTokens } : {}),
      ...(typeof cacheWriteTokens === 'number' ? { cacheWriteTokens } : {}),
    });
    await scope.emit('provider.usage', payload);
  } catch (err) {
    log.warn('provider.usage emit failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Failure thrown by the adapter. Carries one of the 15 canonical
 * `aiProviders` error codes from `spec/v1/host-capabilities.md:141-154`.
 * The executor surfaces these to the caller as `node.failure` with the
 * `code` propagated.
 */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: AiProviderErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.details = details;
  }
}

export type AiProviderErrorCode =
  | 'provider_not_supported'
  | 'provider_policy_denied'
  | 'byok_required'
  | 'byok_required_but_unresolved'
  | 'model_not_supported'
  | 'model_not_allowed'
  | 'provider_unavailable'
  | 'provider_rate_limited'
  | 'provider_timed_out'
  | 'safety_filter'
  | 'content_filtered'
  | 'structured_output_invalid'
  | 'invalid_request'
  | 'host_capability_missing'
  | 'unsupported_modality'
  | 'internal_error'
  // RFC 0033 §F — envelope-completion contract error codes.
  // `envelope_invalid` covers schema-violation-retry-exhaustion (renamed
  // 2026-05-21 from `envelope_payload_invalid` per MyndHyve adoption
  // feedback); `envelope_refusal` is the safety-stop terminal (renamed
  // from `envelope_refused_by_provider` to mirror the `envelope.refusal`
  // RunEvent type name); `envelope_truncation_unrecoverable` is the
  // truncation-retry-exhaustion terminal (unchanged).
  | 'envelope_invalid'
  | 'envelope_truncation_unrecoverable'
  | 'envelope_refusal'
  // RFC 0105 §C — speech-synthesis error codes. `speech_synthesis_unsupported`
  // = requested provider has no wired speech path; `speech_synthesis_failed`
  // = the provider call failed; `content_too_long` = `text` exceeds the host's
  // char cap.
  | 'speech_synthesis_unsupported'
  | 'speech_synthesis_failed'
  | 'content_too_long'
  // RFC 0106 §C — real-time transcription error code. `transcription_unsupported`
  // = `ctx.callTranscriber` invoked but no streaming-STT path is wired for the
  // requested provider (never a no-op).
  | 'transcription_unsupported'
  // ADR 0106 — per-org media-generation budget exceeded (TTS chars / STT bytes).
  | 'media_budget_exceeded';

/** Factory: build a per-call adapter for one node dispatch. */
export function createAiProvidersAdapter(scope: AdapterScope): {
  callAI(req: AiCallRequest): Promise<AiCallResult>;
  callAIWithTools(req: AiToolCallRequest): Promise<AiToolCallResult>;
  callSpeechSynthesizer(req: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>;
  callTranscriber(req: TranscribeRequest): Promise<TranscriptResult>;
  callImageGenerator(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
} {
  return {
    callAI: (req) => callAI(scope, req),
    callAIWithTools: (req) => callAIWithTools(scope, req),
    callSpeechSynthesizer: (req) => callSpeechSynthesizer(scope, req),
    callTranscriber: (req) => callTranscriber(scope, req),
    callImageGenerator: (req) => callImageGenerator(scope, req),
  };
}

/** Parse the opaque token from a host media-asset URL
 *  (`…/v1/host/openwop-app/assets/<token>`). Returns null for anything else —
 *  callTranscriber's `audio.url` is the host's own asset surface (the RFC 0106
 *  `streamRef → mediaRef` finalize seam), NOT an arbitrary external URL, so no
 *  SSRF fetch is performed: the bytes are resolved from tenant-scoped storage. */
function parseAssetToken(url: string): string | null {
  const m = url.match(/\/assets\/([A-Za-z0-9_-]{1,512})\/?$/);
  return m ? m[1] : null;
}

/** RFC 0106 §B/§D — emit the canonical `voice.*` turn over `scope.emit` (the C1
 *  single-taxonomy, replay-safe durable-log path) and return the committed turn.
 *  Shared by the deterministic stub and the real managed-transcription path so
 *  the wire shape is produced in exactly ONE place. `voice.transcript` carries
 *  `contentTrust:'untrusted'` (RFC 0106 §F `voice-transcript-untrusted`). The
 *  interim/endpoint atMs values are synthesized around the settled `finalText`
 *  (a stateless host has no true streaming timeline; the EVENT shape is what the
 *  wire contract requires). */
async function emitVoiceTurn(scope: AdapterScope, finalText: string, language: string): Promise<TranscriptResult> {
  const COMMIT_AT_MS = 1650;
  if (scope.emit) {
    // The interim events + timings below are ILLUSTRATIVE, not a real streaming
    // timeline: the managed `callAI` returns only the settled transcript, so the
    // "interim" `prefix` (first 60%) is synthesized to model the settling shape the
    // §B wire contract describes. Only the committed `finalText` at `turn_commit` is
    // durable/replayable; interim text + `atMs` are observational (RFC 0106 R5).
    const cut = Math.max(1, Math.floor(finalText.length * 0.6));
    const prefix = finalText.slice(0, cut).trimEnd();
    await scope.emit('voice.speech_start', { atMs: 120 });
    await scope.emit('voice.transcript', { text: prefix, isFinal: false, atMs: 600, contentTrust: 'untrusted' });
    await scope.emit('voice.transcript', { text: finalText, isFinal: false, committedPrefix: prefix, stability: 0.7, atMs: 1100, contentTrust: 'untrusted' });
    await scope.emit('voice.endpoint_candidate', { atMs: 1400, confidence: 0.6 });
    await scope.emit('voice.transcript', { text: finalText, isFinal: true, formatted: true, atMs: 1600, contentTrust: 'untrusted' });
    await scope.emit('voice.turn_commit', { atMs: COMMIT_AT_MS, finalText });
  }
  return { finalText, atMs: COMMIT_AT_MS, language };
}

/** RFC 0106 §C (ADR 0109 P3) — emit `voice.synthesis_chunk` METADATA-ONLY
 *  run-events for a streaming-synthesis call. The audio bytes live at the
 *  tenant-scoped asset `url` (NEVER inline on the log — the C2/G8 budget rule);
 *  the chunks reference it. P3 stub: a single clause chunk over the finished
 *  whole-file asset; a real clause-by-clause streamer emits N chunks as they
 *  synthesize, behind this same shape. */
async function emitSynthesisChunks(
  scope: AdapterScope,
  audio: { url?: string; mimeType: string; durationSeconds?: number },
): Promise<void> {
  if (!scope.emit) return;
  const durationMs = audio.durationSeconds != null ? Math.round(audio.durationSeconds * 1000) : undefined;
  await scope.emit('voice.synthesis_chunk', {
    seq: 0,
    mimeType: audio.mimeType,
    ...(durationMs != null ? { durationMs } : {}),
    ...(audio.url ? { url: audio.url } : {}),
    final: true,
  });
}

/**
 * RFC 0106 §B — real-time transcription (`ctx.callTranscriber`). ADR 0109.
 *
 * One call = one turn: resolves at `voice.turn_commit` with the settled
 * `finalText`; the interim / speech_start / endpoint_candidate / turn_commit
 * signals are emitted as the canonical `voice.*` run-events on the DURABLE log
 * (the C1 single-taxonomy, replay-safe path; `voice.transcript` carries
 * `contentTrust:'untrusted'`, RFC 0106 §F).
 *
 * Paths:
 *   - `provider:'mock'` + `OPENWOP_TEST_SEAM_ENABLED` (P1) — the deterministic
 *     stub (fixed scripted turn), so the shape/behavioral conformance runs
 *     non-vacuously with no provider key. Defense-in-depth: gated here too, not
 *     only at the agents.ts seam.
 *   - `audio.url` (P2) — a host MEDIA-ASSET url (the `streamRef → mediaRef`
 *     finalize seam). The bytes are resolved from tenant-scoped storage and
 *     transcribed through the host's existing managed multimodal `callAI` audio
 *     path (RFC 0091 audio-in / ADR 0085) — a REAL transcript, then the same
 *     `voice.*` turn. Composes the existing STT; does not fork it.
 *   - `audio.streamRef` on a non-mock call (P2) — HONEST `transcription_unsupported`:
 *     true live streaming needs persistent media transport, which RFC 0106 §E
 *     leaves host-internal and is NOT wired on a stateless host. The advertised
 *     `realtimeVoice.transcription` stays truthful under OPENWOP_REQUIRE_BEHAVIOR
 *     (ADR 0085 advertise+accept-in-lockstep): the host accepts a finite-audio
 *     turn, and says so plainly when it cannot.
 */
async function callTranscriber(scope: AdapterScope, req: TranscribeRequest): Promise<TranscriptResult> {
  const hasStream = typeof req.audio?.streamRef === 'string' && req.audio.streamRef.length > 0;
  const hasUrl = typeof req.audio?.url === 'string' && req.audio.url.length > 0;
  // EXACTLY ONE of streamRef / url. Inline base64 + a finite-blob mediaRef are
  // rejected for a live stream (RFC 0106 §B.1) — the `audio` arg carries neither.
  if (hasStream === hasUrl) {
    throw new AiProviderError(
      'invalid_request',
      'callTranscriber requires EXACTLY ONE of `audio.streamRef` / `audio.url` (a live stream cannot be inline bytes).',
      { field: 'audio' },
    );
  }

  const provider = req.provider ?? 'minimax';
  const language = req.languageCode ?? 'en-US';

  // P1 deterministic stub — gated (defense-in-depth) so a prod `provider:'mock'`
  // cannot fake the capability.
  if (provider === 'mock' && process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    return emitVoiceTurn(scope, 'book a table for two', language);
  }

  // P1 (ADR 0138) — true live streaming (a `streamRef`). Transport is host-internal
  // (RFC 0106 §E) and lives in the `voice` feature; it registers a `StreamAudioResolver`
  // (streamAudio.ts) that yields the buffered utterance for the streamRef. When a
  // resolver is wired, resolve the bytes + tenant-bind (§F `voice-streamref-tenant-bound`)
  // and transcribe via the SAME managed path as finite audio. When NO transport is wired,
  // stay an honest `transcription_unsupported` — the advertisement is DERIVED, never a
  // no-op (ADR 0085 advertise-in-lockstep; ADR 0138 finding #3).
  if (hasStream) {
    const streamResolver = getStreamAudioResolver();
    if (!streamResolver) {
      throw new AiProviderError(
        'transcription_unsupported',
        'Live streaming transcription (`audio.streamRef`) needs a host-internal media transport (RFC 0106 §E), which is not wired on this host. Finalize the stream to a host media asset and pass its `audio.url` (the streamRef→mediaRef seam) for managed transcription.',
        { provider, capability: 'aiProviders.realtimeVoice.transcription' },
      );
    }
    const buffered = await streamResolver(req.audio.streamRef as string);
    // Collapse unknown-streamRef + cross-tenant into one error so the response is not an
    // existence oracle for another tenant's live handles (§F `voice-streamref-tenant-bound`).
    if (!buffered || buffered.tenantId !== scope.tenantId) {
      throw new AiProviderError('invalid_request', 'No buffered audio for `audio.streamRef`.', { field: 'audio.streamRef' });
    }
    const finalText = await transcribeManaged(scope, req, buffered.contentBase64, buffered.contentType);
    return emitVoiceTurn(scope, finalText, language);
  }

  // P2 real path — finite audio resolved from a tenant-scoped host media asset,
  // transcribed via the existing managed multimodal `callAI` (RFC 0091 audio-in).
  const token = parseAssetToken(req.audio.url as string);
  if (!token) {
    throw new AiProviderError(
      'invalid_request',
      '`audio.url` must be a host media-asset URL (…/v1/host/openwop-app/assets/<token>) — callTranscriber does not fetch arbitrary external URLs.',
      { field: 'audio.url' },
    );
  }
  const asset = await resolveMediaAsset(token);
  // `media-asset-url-tenant-scoped` invariant (RFC 0055): the token is an unguessable
  // capability, but `callTranscriber` resolves it on behalf of a tenant-scoped run, so
  // it MUST bind the asset to the caller's tenant — otherwise a leaked token would let
  // one tenant transcribe another's audio and land the transcript on its own run log.
  // Collapse not-found + cross-tenant into one error so the response is not an
  // existence oracle for another tenant's tokens.
  if (!asset || asset.tenantId !== scope.tenantId) {
    throw new AiProviderError('invalid_request', 'Media asset not found for `audio.url`.', { field: 'audio.url' });
  }
  const finalText = await transcribeManaged(scope, req, asset.contentBase64, asset.contentType);
  return emitVoiceTurn(scope, finalText, language);
}

/** Transcribe audio bytes via the host's managed multimodal `callAI` audio path
 *  (RFC 0091 audio-in / ADR 0085) — the ONE place finite + live-finalized audio
 *  is turned into text, so the STT path is composed, never forked. Google/Gemini
 *  is the host's audio-capable default (ADR 0085's `transcribe-source` node); a
 *  caller MAY override via `req.provider`/`req.model`. */
async function transcribeManaged(
  scope: AdapterScope,
  req: TranscribeRequest,
  contentBase64: string,
  contentType: string,
): Promise<string> {
  // Deterministic transcript under the test seam — exercises the resolver / buffer /
  // tenant-bind path (and the finite-asset path) with no provider key, gated so a prod
  // build can never fake it. Encodes the byte count so a test can prove the audio flowed.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    return `live transcript (${Buffer.from(contentBase64, 'base64').length} bytes)`;
  }
  const aiResult = await callAI(scope, {
    provider: req.provider && req.provider !== 'mock' ? req.provider : 'google',
    model: req.model ?? 'gemini-2.5-flash',
    messages: [
      { role: 'system', content: AUDIO_TRANSCRIPTION_SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: AUDIO_TRANSCRIPTION_USER_PROMPT },
        { type: 'audio', mimeType: contentType, dataBase64: contentBase64 },
      ] },
    ],
    ...(req.credentialRef ? { credentialRef: req.credentialRef } : {}),
  });
  return (aiResult.content ?? '').trim();
}

// ── Core flow ─────────────────────────────────────────────────────

/** A9 / RFC 0091 — input modalities this host's `callAI` accepts as ContentParts.
 *  `file` parts map to the `document` modality; the dispatch layer forwards
 *  image/document to provider-native vision/document blocks. `audio` parts are
 *  forwarded to provider-native audio blocks (Gemini / GPT-4o-audio class) and
 *  power notebook audio/video source transcription (ADR 0085 Phase 1) — adding it
 *  here flips both the advertisement (discovery derives from this constant) and the
 *  acceptance (assertModalitiesAdvertised) together, so there is no dishonest-wire
 *  window where audio is advertised but rejected, or accepted but unadvertised. */
export const INPUT_MODALITIES: readonly string[] = ['text', 'image', 'document', 'audio'];
const PART_TO_MODALITY: Record<string, string> = { text: 'text', image: 'image', file: 'document', audio: 'audio' };

/** Reject a ContentPart whose modality the host doesn't advertise, rather than
 *  silently dropping it (RFC 0091 §A). */
export function assertModalitiesAdvertised(req: AiCallRequest | AiToolCallRequest): void {
  const allowed = new Set(INPUT_MODALITIES);
  for (const m of req.messages) {
    if (typeof m.content === 'string') continue;
    for (const part of m.content) {
      const modality = PART_TO_MODALITY[part.type] ?? part.type;
      if (!allowed.has(modality)) {
        throw new AiProviderError(
          'unsupported_modality',
          `Input modality "${modality}" not supported (advertised aiProviders.input.modalities: [${INPUT_MODALITIES.map((x) => `'${x}'`).join(', ')}]).`,
          { capability: 'aiProviders.input', modality },
        );
      }
    }
  }
}

async function callAI(scope: AdapterScope, req: AiCallRequest): Promise<AiCallResult> {
  assertModalitiesAdvertised(req);
  if (req.embeddingMode) {
    // A5 — real, self-contained deterministic embedding (feature hashing). No
    // external model/key; the input text is the first message's content.
    const text = req.messages?.[0]?.content ?? '';
    const dims = typeof req.dimensions === 'number' && req.dimensions > 0 ? Math.floor(req.dimensions) : DEFAULT_EMBEDDING_DIMS;
    const embedding = embedText(typeof text === 'string' ? text : String(text), dims);
    return { embedding, model: LOCAL_EMBEDDING_MODEL };
  }

  // Managed-provider short-circuit. Bypasses policy + invocation-log
  // cache + BYOK resolution; the managed pipeline owns sign-in check,
  // daily cap, server-held-key lookup, and result rewriting. Replay
  // determinism does NOT apply: managed dispatch is for ad-hoc chat,
  // not workflow runs (which keep using BYOK).
  if (isManagedCredentialRef(req.credentialRef)) {
    return callAIManaged(scope, req);
  }

  assertProviderSupported(req.provider);
  await enforcePolicy(scope, req.provider, req.model, req.credentialRef);

  const { cleartext: credentialCleartext, refUsed } = resolveCredential(scope, req.provider, req.credentialRef);
  const credentialRefHashed = sha256Hex(refUsed);

  // Replay determinism: deterministic cache key. Defaults filled in
  // BEFORE hashing so `maxTokens: undefined` (caller omits) collapses
  // into the same key as `maxTokens: 4096` (dispatcher default) —
  // otherwise identical-effective requests double-spend the cache.
  // Note we hash the credentialRef alongside the request shape — the
  // cache value itself never contains the cleartext key.
  const providerKey = computeProviderKey({
    provider: req.provider,
    model: req.model,
    messages: req.messages,
    systemPrompt: req.systemPrompt ?? null,
    temperature: req.temperature ?? null,
    maxTokens: req.maxTokens ?? 4096,
    stopSequences: req.stopSequences ?? null,
    responseSchema: req.responseSchema ?? null,
    credentialRefHashed,
  });
  const cacheKey = {
    runId: scope.runId,
    nodeId: scope.nodeId,
    attempt: scope.attempt,
    providerKey,
  };
  const invocationLog = getInvocationLog();
  const cached = (await invocationLog.get(cacheKey)) as AiCallResult | null;
  if (cached) {
    log.debug('callAI: invocation-log cache hit', {
      runId: scope.runId,
      nodeId: scope.nodeId,
      provider: req.provider,
      model: req.model,
    });
    return { ...cached, credentialRefHashed };
  }

  // ADR 0079 §Phase 4 — stream the plain reply's token deltas onto the run event
  // log as canonical `ai.message.chunk` events, so a surface tailing this run's
  // SSE renders progressively (the same event the chat consumer already reads).
  // Transient (stream-only, no channel reducer folds it); the node's structured
  // result remains authoritative. OPT-IN per call (`req.stream`) so non-interactive
  // batch/agent nodes don't append one durable event per token for no consumer
  // (architect review HIGH — write amplification). Best-effort + emit-capable scope.
  const emit = scope.emit;
  const streamDelta = req.stream && emit
    ? async (delta: string): Promise<void> => {
        try { await emit('ai.message.chunk', { chunk: delta, isLast: false }); } catch { /* best-effort delta */ }
      }
    : undefined;
  const result = await wrapInSpan(scope, req.provider, req.model, async () => {
    if (req.responseSchema) {
      return dispatchStructured(scope, req, credentialCleartext);
    }
    return dispatchPlain(scope, req, credentialCleartext, streamDelta);
  });

  // Emit cost AFTER dispatch returns (real usage figures only).
  if (result.usage?.inputTokens != null || result.usage?.outputTokens != null) {
    emitCost({
      provider: req.provider,
      model: req.model,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
    });
  }

  // RFC 0026 — `provider.usage` event(s) were already emitted from
  // inside `dispatchPlain` (one per upstream provider invocation,
  // including each attempt inside `dispatchStructured`'s parse-retry
  // loop). callAI does NOT re-emit here — that would either double-
  // count single calls or collapse N retry attempts into 1 event.

  // `result` from dispatch* never carries `credentialRefHashed`, so
  // caching `{...result}` is already secret-free. The hashed ref is
  // re-attached for the current return value below.
  await invocationLog.put(cacheKey, result);
  return { ...result, credentialRefHashed };
}

/**
 * Single-round tool-calling. The pack receives `toolCalls[]` from the
 * model and orchestrates execution at the workflow level (downstream
 * nodes run the tools; the workflow re-invokes the LLM with the
 * results in `messages`). This matches the published
 * `core.ai.toolCalling` pack's expected return shape.
 *
 * NOT cached: the model's `toolCalls[]` output is intentionally
 * non-deterministic across attempts when the pack iterates (different
 * tool results lead to different next-round queries). The pack-level
 * cache for the eventual final text is the workflow's invocationLog,
 * not this single round.
 */
async function callAIWithTools(scope: AdapterScope, req: AiToolCallRequest): Promise<AiToolCallResult> {
  assertProviderSupported(req.provider);
  if (!TOOL_CALLING_PROVIDERS.includes(req.provider)) {
    throw new AiProviderError(
      'host_capability_missing',
      `Tool calling not supported for provider "${req.provider}" in this sample (advertised aiProviders.toolCalling.providers: [${TOOL_CALLING_PROVIDERS.map((p) => `'${p}'`).join(', ')}]).`,
      { provider: req.provider, capability: 'aiProviders.toolCalling' },
    );
  }
  await enforcePolicy(scope, req.provider, req.model, req.credentialRef);
  const { cleartext: credentialCleartext, refUsed } = resolveCredential(scope, req.provider, req.credentialRef);
  const credentialRefHashed = sha256Hex(refUsed);

  const toolDietOn = contextEconomy().toolDiet; // ADR 0148 A3
  const result = await wrapInSpan(scope, req.provider, req.model, async () => {
    const dispatchRound = toolsRoundDispatcher(req.provider);
    return mapDispatchErrors(req.provider, () =>
      runWithTimeout(scope, (signal) =>
        dispatchRound({
          model: req.model,
          apiKey: credentialCleartext,
          messages: toChatMessages(req),
          ...(req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
          // ADR 0148 A3 — tool-surface diet: strip non-functional schema
          // annotations before the catalog reaches the model (gated; off ⇒
          // unchanged). Sibling site: host/conversationToolLoop.ts (managed chat).
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: compactToolSchema(t.inputSchema, toolDietOn),
          })),
          ...(req.webSearch ? { webSearch: true } : {}),
          signal,
        }),
      ),
    );
  });

  if (result.inputTokens != null || result.outputTokens != null) {
    emitCost({
      provider: req.provider,
      model: req.model,
      promptTokens: result.inputTokens,
      completionTokens: result.outputTokens,
    });
  }

  // RFC 0026 — emit `provider.usage` after the tool-calling round so
  // billing reconciliation captures per-call records inside multi-turn
  // tool flows. The pack orchestrates subsequent rounds; each round
  // re-enters this function and emits its own event.
  await emitProviderUsage(scope, req.provider, req.model, result.inputTokens, result.outputTokens, (result.cachedReadTokens ?? 0) > 0, result.cachedReadTokens, result.cacheWriteTokens);

  const aiResult: AiToolCallResult = {
    content: result.text,
    toolCalls: result.toolUses,
    ...(result.citations && result.citations.length > 0 ? { citations: result.citations } : {}),
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    },
    finishReason: normalizeFinishReason(result.finishReason),
    credentialRefHashed,
  };
  return aiResult;
}

async function callAIManaged(scope: AdapterScope, req: AiCallRequest): Promise<AiCallResult> {
  if (req.responseSchema || req.embeddingMode) {
    throw new AiProviderError(
      'host_capability_missing',
      'Managed provider supports plain chat only (no structured-output / embedding mode in this sample).',
      { capability: 'managed_provider.modes' },
    );
  }
  const userFacingProvider = managedProviderIdFromRef(req.credentialRef!);
  const credentialRefHashed = sha256Hex(req.credentialRef!);
  try {
    const managed = await dispatchManagedChat({
      userFacingProvider,
      tenantId: scope.tenantId,
      messages: toChatMessages(req),
      ...(req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
    });
    if (managed.usage?.inputTokens != null || managed.usage?.outputTokens != null) {
      emitCost({
        provider: managed.provider,
        model: managed.model,
        promptTokens: managed.usage.inputTokens,
        completionTokens: managed.usage.outputTokens,
      });
    }

    // RFC 0026 — managed-provider calls emit the same event shape so
    // tenants can reconcile against their server-held-key spend.
    await emitProviderUsage(scope, managed.provider, managed.model, managed.usage?.inputTokens, managed.usage?.outputTokens);

    return {
      content: managed.completion,
      ...(managed.usage ? { usage: managed.usage } : {}),
      finishReason: normalizeFinishReason(managed.finishReason),
      model: managed.model,
      credentialRefHashed,
    };
  } catch (err) {
    if (err instanceof ManagedProviderError) {
      // Map managed-pipeline errors to canonical aiProviders codes so
      // existing callers don't need to learn a new vocabulary.
      const code: AiProviderErrorCode =
        err.code === 'sign_in_required' ? 'byok_required'
          : err.code === 'daily_limit_reached' ? 'provider_rate_limited'
          : 'provider_unavailable';
      throw new AiProviderError(code, err.message, { managedCode: err.code });
    }
    throw err;
  }
}

// ── Speech synthesis (RFC 0105) ───────────────────────────────────

/** Generous host-side char cap. RFC 0105 advertises NO normative char
 *  cap; this is an abuse backstop, not a wire constraint. Exceeding it
 *  fails with `content_too_long`. */
const MAX_SPEECH_CHARS = 50_000;

/** Providers with a wired speech-synthesis dispatch path. MiniMax T2A is the
 *  MANAGED provider (server-held key); OpenAI (`/audio/speech`) + Google Gemini
 *  TTS (`generateContent` AUDIO) are BYOK (the caller's own key — this host has no
 *  managed key for them). Anthropic is deliberately absent — Claude has NO speech-
 *  synthesis API, so advertising it would be a dishonest wire claim. `mock` is a
 *  conformance-only deterministic path (no network/credential) the speech seam
 *  selects under OPENWOP_TEST_SEAM_ENABLED so the speech-synthesis-roundtrip
 *  scenario runs non-vacuously in the `memory://` harness. */
const SPEECH_PROVIDERS: readonly string[] = ['minimax', 'openai', 'google', 'elevenlabs', 'mock'];

/** Providers whose speech path has a MANAGED server-held key on this host. Only
 *  MiniMax is managed; OpenAI/Google speech is BYOK-only (a managed request without
 *  a BYOK credential fails honestly rather than mis-routing to the MiniMax key). */
const MANAGED_SPEECH_PROVIDERS: readonly string[] = ['minimax', 'mock'];

/** A tiny deterministic synthetic audio payload (an MP3/ID3 header is enough —
 *  the conformance scenario asserts the result SHAPE, not decodable audio). */
const MOCK_SPEECH_AUDIO_B64 = 'SUQzBAAAAAAAF1RTU0UAAAANAAADTGF2ZjU4Ljc2LjEwMA==';

/**
 * RFC 0105 — synthesize one speaker turn (text-to-speech). Validates the
 * request, resolves the credential (managed MiniMax by default, BYOK +
 * policy for an explicit provider), dispatches to MiniMax T2A, stores the
 * returned audio as a tenant-scoped media asset, and returns an
 * `audio.url` result. The cleartext key never crosses the return boundary.
 */
// ── ADR 0115 — text-to-image generation ─────────────────────────────────────
const IMAGE_PROVIDERS = ['openai', 'google', 'mock'] as const;
const MANAGED_IMAGE_PROVIDERS: string[] = []; // no managed image key on this host (BYOK-only) until a provider is configured
const MAX_IMAGE_PROMPT_CHARS = 4_000;
const MAX_IMAGES_PER_CALL = 4;
/** ADR 0115 §honesty — advertise `imageGeneration:{supported:true}` ONLY when the
 *  operator has opted in (a real provider is configured). Default false →
 *  production-honest (the mock alone is test-seam-only). Mirrors the compat
 *  provider's `OPENWOP_COMPAT_PROVIDER_ENABLED` honest-flip. */
export function imageGenerationAdvertised(): boolean {
  return process.env.OPENWOP_IMAGE_PROVIDER_ENABLED === 'true';
}

// 1×1 transparent PNG — the deterministic test-seam asset (no network/credential).
const MOCK_IMAGE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAQDWUFLAAAAAAElFTkSuQmCC';

async function callImageGenerator(
  scope: AdapterScope,
  req: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const startedAt = Date.now();
  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) {
    throw new AiProviderError('invalid_request', 'Image generation requires a non-empty `prompt`.', { field: 'prompt' });
  }
  if (req.prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    throw new AiProviderError('content_too_long', `Image prompt exceeds the host cap of ${MAX_IMAGE_PROMPT_CHARS} characters.`, { max: MAX_IMAGE_PROMPT_CHARS, length: req.prompt.length });
  }
  const n = Math.min(Math.max(1, typeof req.n === 'number' ? req.n : 1), MAX_IMAGES_PER_CALL);
  const provider = req.provider ?? 'openai';
  if (!IMAGE_PROVIDERS.includes(provider as (typeof IMAGE_PROVIDERS)[number])) {
    throw new AiProviderError('host_capability_missing', `Image generation not supported for provider "${provider}".`, { provider, capability: 'aiProviders.imageGeneration' });
  }

  // Deterministic mock (test seam only — DEFENSE-IN-DEPTH: a node forwarding
  // provider:'mock' in prod must not fake an advertised capability; in prod it
  // falls through to managed resolution → honest image_generation_unsupported).
  if (provider === 'mock' && process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    const images: ImageGenerationResult['images'] = [];
    for (let i = 0; i < n; i++) {
      const stored = await storeMediaAsset(scope.tenantId, { contentBase64: MOCK_IMAGE_PNG_B64, contentType: 'image/png' });
      images.push({ url: stored.url, mimeType: 'image/png', metadata: { model: 'mock-image-1', provider, ...(req.seed != null ? { seed: req.seed } : {}) } });
    }
    return { images, totalTimeMs: Date.now() - startedAt, usage: { images: n } };
  }

  // Credential resolution. An explicit non-managed credentialRef routes through
  // policy + BYOK (mirroring callAI/TTS). No managed image key exists on this host
  // yet, so a managed request fails honestly rather than mis-routing another key.
  if (req.credentialRef && !isManagedCredentialRef(req.credentialRef)) {
    await enforcePolicy(scope, provider, req.model ?? '', req.credentialRef);
    // The concrete provider HTTP dispatch (OpenAI gpt-image / Google Imagen) lands
    // with the first wired provider; the BYOK credential is resolved host-side and
    // never crosses back into the node (Phase 1 establishes the seam + mock).
    resolveCredential(scope, provider, req.credentialRef);
  } else if (!MANAGED_IMAGE_PROVIDERS.includes(provider)) {
    throw new AiProviderError(
      'host_capability_missing',
      `Image generation for provider "${provider}" requires a BYOK credential on this host (no managed image key is configured).`,
      { provider, capability: 'aiProviders.imageGeneration' },
    );
  }
  // ADR 0115 Phase 3 — the real external-provider dispatch, present ONLY when the
  // operator opted in + wired an endpoint (else honest-off below). The returned
  // base64 is stored host-side as a Media asset; raw bytes never cross the result
  // boundary; the endpoint is §D-private (the adapter scrubs it from any error).
  if (imageProviderConfigured(provider)) {
    // ADR 0115 Phase 5 — per-tenant daily image budget, checked BEFORE the metered
    // provider call (over ⇒ no dispatch, no charge), recorded by images returned.
    const day = new Date().toISOString().slice(0, 10);
    const budget = await checkImageBudget(scope.tenantId, day);
    if (!budget.allowed) {
      throw new AiProviderError('provider_rate_limited', `Daily image-generation budget reached (${budget.used}/${budget.max}).`, { used: budget.used, max: budget.max });
    }
    // ADR 0115 Phase 6 — the adapter resolves the per-PROVIDER endpoint + key from
    // `provider`, so `openai` and `google` (Imagen) route to their own configured
    // endpoints (or the shared generic one). Inert until the operator configures it.
    const raws = await dispatchImageGeneration({
      prompt: req.prompt,
      provider,
      ...(req.model ? { model: req.model } : {}),
      ...(req.size ? { size: req.size } : {}),
      n: Math.min(n, budget.remaining), // never exceed the remaining budget
    });
    const images: ImageGenerationResult['images'] = [];
    for (const raw of raws) {
      const stored = await storeMediaAsset(scope.tenantId, { contentBase64: raw.base64, contentType: raw.mimeType });
      images.push({ url: stored.url, mimeType: raw.mimeType, metadata: { provider, ...(req.model ? { model: req.model } : {}), ...(req.seed != null ? { seed: req.seed } : {}) } });
    }
    await recordImages(scope.tenantId, day, images.length);
    return { images, totalTimeMs: Date.now() - startedAt, usage: { images: images.length } };
  }

  // Honest-off: no provider wired on this host.
  throw new AiProviderError('host_capability_missing', `Image generation provider "${provider}" is not yet wired on this host.`, { provider });
}

async function callSpeechSynthesizer(
  scope: AdapterScope,
  req: SpeechSynthesisRequest,
): Promise<SpeechSynthesisResult> {
  const startedAt = Date.now();
  if (typeof req.text !== 'string' || req.text.length === 0) {
    throw new AiProviderError('invalid_request', 'Speech synthesis requires a non-empty `text`.', { field: 'text' });
  }
  if (typeof req.voiceId !== 'string' || req.voiceId.length === 0) {
    throw new AiProviderError('invalid_request', 'Speech synthesis requires a non-empty `voiceId`.', { field: 'voiceId' });
  }
  if (req.text.length > MAX_SPEECH_CHARS) {
    throw new AiProviderError(
      'content_too_long',
      `Speech synthesis text exceeds the host cap of ${MAX_SPEECH_CHARS} characters (got ${req.text.length}).`,
      { max: MAX_SPEECH_CHARS, length: req.text.length },
    );
  }

  // ADR 0106 — per-org daily TTS budget (the AGGREGATE ceiling above the per-call
  // MAX_SPEECH_CHARS cap). No-op when the budget is unset (default). Check before
  // the paid dispatch; record actual chars after success.
  const ttsBudget = await checkMediaBudget(scope.tenantId, 'tts', req.text.length);
  if (ttsBudget.exceeded) {
    throw new AiProviderError(
      'media_budget_exceeded',
      `Daily text-to-speech budget reached (${ttsBudget.cap} characters; ${ttsBudget.used} used). Resets at 00:00 UTC.`,
      { kind: 'tts', cap: ttsBudget.cap, used: ttsBudget.used },
    );
  }

  const provider = req.provider ?? 'minimax';
  if (!SPEECH_PROVIDERS.includes(provider)) {
    throw new AiProviderError(
      'speech_synthesis_unsupported',
      `Speech synthesis not supported for provider "${provider}" (this host routes TTS via: [${SPEECH_PROVIDERS.map((p) => `'${p}'`).join(', ')}]).`,
      { provider, capability: 'aiProviders.speechSynthesis' },
    );
  }

  // Conformance-only deterministic TTS (no network, no credential). Stores a
  // tiny synthetic asset and returns the locked RFC 0105 §A result shape so the
  // speech-synthesis-roundtrip scenario passes non-vacuously where no managed
  // MiniMax key exists. DEFENSE-IN-DEPTH: gated on OPENWOP_TEST_SEAM_ENABLED here
  // too (not only at the agents.ts seam) — `callSpeechSynthesizer` is exposed to
  // every workflow node as `ctx.callSpeechSynthesizer`, so without this gate a
  // node forwarding `provider:'mock'` could fake an advertised capability in
  // prod. With the gate, a prod `provider:'mock'` falls through to managed
  // resolution → honest `speech_synthesis_unsupported`. Real MiniMax unchanged.
  if (provider === 'mock' && process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    const storedMock = await storeMediaAsset(scope.tenantId, {
      contentBase64: MOCK_SPEECH_AUDIO_B64,
      contentType: 'audio/mpeg',
    });
    const mockResult: SpeechSynthesisResult = {
      audio: {
        url: storedMock.url,
        mimeType: 'audio/mpeg',
        voiceId: req.voiceId,
        ...(req.seed != null ? { seed: req.seed } : {}),
        metadata: { model: 'mock-tts-1', provider, generationTimeMs: 0 },
      },
      totalTimeMs: Date.now() - startedAt,
      usage: { characters: req.text.length },
    };
    if (req.stream === true) await emitSynthesisChunks(scope, mockResult.audio);
    return mockResult;
  }

  // Credential resolution. An explicit non-managed credentialRef routes through
  // policy + BYOK (mirroring callAI) for ANY supported speech provider. Otherwise
  // only MiniMax has a managed server-held key on this host — OpenAI/Google speech
  // is BYOK-only, so a managed request for them fails honestly rather than
  // mis-routing the MiniMax key.
  let apiKey: string;
  if (req.credentialRef && !isManagedCredentialRef(req.credentialRef)) {
    await enforcePolicy(scope, provider, req.model ?? '', req.credentialRef);
    apiKey = resolveCredential(scope, provider, req.credentialRef).cleartext;
  } else if (MANAGED_SPEECH_PROVIDERS.includes(provider)) {
    const managed = await resolveManagedSpeechKey();
    if (!managed) {
      throw new AiProviderError(
        'speech_synthesis_unsupported',
        'No managed speech credential is configured on this host (set MINIMAX_API_KEY).',
        { provider },
      );
    }
    apiKey = managed;
  } else {
    throw new AiProviderError(
      'speech_synthesis_unsupported',
      `Speech synthesis for provider "${provider}" is BYOK on this host — supply a credentialRef (no managed key is configured for it).`,
      { provider, capability: 'aiProviders.speechSynthesis' },
    );
  }

  // Route to the provider's dispatch path (all share the DispatchSpeech shape).
  const dispatchArgs = {
    apiKey,
    ...(req.model ? { model: req.model } : {}),
    text: req.text,
    voiceId: req.voiceId,
    ...(req.speed != null ? { speed: req.speed } : {}),
    ...(req.languageCode ? { languageCode: req.languageCode } : {}),
  };
  const dispatchFor = provider === 'openai'
    ? dispatchSpeechOpenAI
    : provider === 'google'
      ? dispatchSpeechGoogle
      : provider === 'elevenlabs'
        ? dispatchSpeechElevenLabs
        : dispatchSpeechMiniMax;

  let dispatched;
  try {
    dispatched = await runWithTimeout(scope, (signal) => dispatchFor({ ...dispatchArgs, signal }));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiProviderError('provider_timed_out', 'Speech provider call exceeded the configured timeout.', { provider });
    }
    throw new AiProviderError('speech_synthesis_failed', 'Speech provider call failed.', {
      provider,
      upstreamMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
  }

  const stored = await storeMediaAsset(scope.tenantId, {
    contentBase64: dispatched.contentBase64,
    contentType: dispatched.mimeType,
  });

  // ADR 0106 — record the actual TTS chars against the per-org daily budget
  // (best-effort, no-op when the budget is unset).
  await recordMediaUsage(scope.tenantId, 'tts', req.text.length);

  const result: SpeechSynthesisResult = {
    audio: {
      url: stored.url,
      mimeType: dispatched.mimeType,
      voiceId: req.voiceId,
      ...(req.seed != null ? { seed: req.seed } : {}),
      metadata: {
        model: dispatched.model,
        provider,
        generationTimeMs: dispatched.generationTimeMs,
      },
    },
    totalTimeMs: Date.now() - startedAt,
    usage: { characters: req.text.length },
  };
  if (req.stream === true) await emitSynthesisChunks(scope, result.audio);
  return result;
}

// ── Pipeline stages ───────────────────────────────────────────────

function assertProviderSupported(provider: string): asserts provider is ProviderId {
  if (!SUPPORTED_PROVIDERS.includes(provider as ProviderId)) {
    throw new AiProviderError(
      'provider_not_supported',
      `Provider "${provider}" is not in the host's aiProviders.supported list.`,
      { provider, supported: SUPPORTED_PROVIDERS },
    );
  }
}

async function enforcePolicy(
  scope: AdapterScope,
  provider: string,
  model: string,
  credentialRef: string | undefined,
): Promise<void> {
  let policies: readonly AiProviderPolicy[];
  try {
    policies = await scope.policyResolver.resolveForRun({
      tenantId: scope.tenantId,
      ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
    });
  } catch (err) {
    // Per `capabilities.md:284`, resolver outage fails open to `optional`.
    log.warn('policy resolver failed; failing open to optional', {
      tenantId: scope.tenantId,
      ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const policy = policies.find((p) => p.provider === provider) ?? { provider, mode: 'optional' as const };
  switch (policy.mode) {
    case 'disabled':
      throw new AiProviderError(
        'provider_policy_denied',
        `Provider "${provider}" is disabled by host policy.`,
        { provider, reason: 'provider_disabled' },
      );
    case 'required': {
      // A credential MUST be resolvable for this provider. Packs from
      // `core.openwop.ai` don't forward credentialRef through
      // `ctx.callAI`, so we ALSO accept the convention-lookup paths
      // (`secrets[provider]`, `secrets[<provider>-*]`, etc.). The
      // call still fails if NONE of these resolve.
      try {
        resolveCredential(scope, provider, credentialRef);
      } catch (err) {
        if (err instanceof AiProviderError) throw err;
        throw new AiProviderError(
          'byok_required',
          `Provider "${provider}" requires a BYOK credential and none is available.`,
          { provider, reason: 'byok_required' },
        );
      }
      break;
    }
    case 'restricted': {
      // Per `capabilities.md:285`: restricted with empty allowedModels MUST fail closed.
      const allowed = policy.allowedModels ?? [];
      if (allowed.length === 0 || !modelMatchesAllowlist(model, allowed)) {
        throw new AiProviderError(
          'model_not_allowed',
          `Model "${model}" not allowed by policy for provider "${provider}".`,
          { provider, model, reason: 'model_not_allowed', allowed },
        );
      }
      break;
    }
    case 'optional':
    default:
      break;
  }
}

/**
 * Resolve the cleartext API key for a request.
 *
 * Per `spec/v1/host-capabilities.md §host.aiProviders`, the pack does
 * NOT pass an opaque credentialRef — the host resolves credentials
 * internally from whatever `configurable.credentialRefs[]` mapped to
 * `ctx.secrets`. The pack only knows `provider` + `model`; the host
 * is responsible for naming convention.
 *
 * Lookup order:
 *   1. If the caller explicitly passed `credentialRef`, use it.
 *   2. Exact match: `secrets[provider]` (e.g., `secrets['anthropic']`).
 *   3. Prefix match: any key starting with `<provider>-` or `<provider>:`
 *      (e.g., `anthropic-tenant-acme`, `anthropic:prod`).
 *
 * If nothing matches, throw `byok_required` with the list of refs the
 * caller actually has (just the refs — NEVER the values).
 */
function resolveCredential(
  scope: AdapterScope,
  provider: string,
  credentialRef: string | undefined,
): { cleartext: string; refUsed: string } {
  // Conformance-only `mock` provider does not consult real BYOK — it
  // reads its program from an in-memory queue keyed by (runId, nodeId).
  // Return a sentinel so the BYOK check passes; the value is never
  // surfaced to the mock dispatcher (`dispatchMock` ignores apiKey).
  if (provider === 'mock') {
    return { cleartext: 'mock-no-credential', refUsed: 'mock' };
  }
  if (credentialRef) {
    const direct = scope.secrets[credentialRef];
    if (!direct) {
      throw new AiProviderError(
        'byok_required_but_unresolved',
        `BYOK credentialRef "${credentialRef}" did not resolve to a value.`,
        { reason: 'byok_required_but_unresolved' },
      );
    }
    return { cleartext: direct, refUsed: credentialRef };
  }
  const exact = scope.secrets[provider];
  if (exact) return { cleartext: exact, refUsed: provider };
  for (const [ref, value] of Object.entries(scope.secrets)) {
    if (ref.startsWith(`${provider}-`) || ref.startsWith(`${provider}:`)) {
      return { cleartext: value, refUsed: ref };
    }
  }
  throw new AiProviderError(
    'byok_required',
    `No credential available for provider "${provider}". The host looks up secrets[provider] then any secret prefixed with "${provider}-" or "${provider}:". Available refs: ${Object.keys(scope.secrets).join(', ') || '(none)'}.`,
    {
      provider,
      reason: 'no_default_credential',
      availableRefs: Object.keys(scope.secrets),
    },
  );
}

// ── Dispatch ──────────────────────────────────────────────────────

async function dispatchPlain(
  scope: AdapterScope,
  req: AiCallRequest,
  apiKey: string,
  // ADR 0079 §Phase 4 — when present, stream the reply's token deltas. Passed
  // ONLY from callAI's plain-text branch; the structured/NL-to-format callers
  // omit it (streaming a JSON body mid-parse-retry is noise, not progress).
  onDelta?: (delta: string) => Promise<void>,
): Promise<AiCallResult> {
  const result = await mapDispatchErrors(req.provider, () =>
    runWithTimeout(scope, async (signal) => {
      const raw = await dispatchChat({
        provider: req.provider as ProviderId,
        model: req.model,
        apiKey,
        messages: toChatMessages(req),
        ...(req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
        signal,
        ...(onDelta ? { onDelta } : {}),
        // RFC 0032/0033 — the conformance-only `mock` provider reads
        // its pre-programmed response queue keyed by `nodeId`. Real
        // providers ignore this extension field. See `dispatchMock.ts`.
        ...(req.provider === 'mock' ? { nodeId: scope.nodeId } : {}),
      } as Parameters<typeof dispatchChat>[0]);
      return {
        content: raw.completion,
        usage: {
          inputTokens: raw.usage?.inputTokens,
          outputTokens: raw.usage?.outputTokens,
          // ADR 0148 A2 — carry the prompt-cache read count through so the
          // emit site can set the wire-legal `providerUsage.cacheHit`.
          ...(raw.usage?.cachedReadTokens != null ? { cachedReadTokens: raw.usage.cachedReadTokens } : {}),
        },
        finishReason: normalizeFinishReason(raw.finishReason),
        model: raw.model,
      };
    }),
  );
  // RFC 0026 §B: emit one `provider.usage` event per upstream provider
  // invocation. Located here (NOT at the `callAI` boundary) so that
  // `dispatchStructured`'s parse-retry loop — which calls dispatchPlain
  // up to STRUCTURED_OUTPUT_RETRIES + 1 times — emits one event per
  // attempt rather than collapsing N invocations into a single event.
  await emitProviderUsage(scope, req.provider, req.model, result.usage?.inputTokens, result.usage?.outputTokens, (result.usage?.cachedReadTokens ?? 0) > 0, result.usage?.cachedReadTokens, undefined);
  return result;
}

const STRUCTURED_OUTPUT_RETRIES = 2;

async function dispatchStructured(
  scope: AdapterScope,
  req: AiCallRequest,
  apiKey: string,
): Promise<AiCallResult> {
  // Append a JSON-only instruction to the system prompt so the model
  // emits parseable output. Real production hosts use provider-native
  // structured output (Anthropic tool-use, OpenAI response_format,
  // Gemini responseSchema). Sample-grade: prompt nudge + retry.
  const schemaHint = `Respond with a JSON object that matches this schema, with no preamble or trailing text: ${JSON.stringify(req.responseSchema)}`;
  // RFC 0030 §A: when the responseSchema declares a top-level `reasoning`
  // property AND the host's posture is `"advisory"` or `"mandatory"`,
  // append the reasoning-field directive after the schema-shape hint.
  // The two directives compose: the schema hint shapes the JSON; the
  // reasoning directive shapes the order-of-thought inside it. Mirrors
  // the staged composition pattern in spec/v1/ai-envelope.md §"Reasoning
  // field (normative)". Hosts MUST NOT reject envelopes where `reasoning`
  // is absent regardless of directive strength (RFC 0030 §A).
  const reasoningConfig = getEnvelopeReasoningConfig();
  const reasoningDirective = reasoningConfig.supported
    ? buildReasoningDirective(req.responseSchema, reasoningConfig.promptDirective)
    : null;
  const augmentedSystem = [req.systemPrompt, schemaHint, reasoningDirective]
    .filter((s): s is string => Boolean(s))
    .join('\n\n');

  // RFC 0032 §B + RFC 0033 §A — envelope-reliability emission + truncation-
  // vs-schema-violation retry routing. When `endToEndEnabled` is false the
  // host reverts to the legacy undifferentiated retry loop (no event emit,
  // no truncation-budget-doubling). Operator circuit-breaker.
  const reliabilityCfg = getEnvelopeReliabilityConfig();
  if (!reliabilityCfg.endToEndEnabled) {
    return dispatchStructuredLegacy(scope, req, apiKey, augmentedSystem);
  }

  // Per-attempt state. `lastFailure` tracks the prior attempt's classified
  // failure mode so the NEXT iteration can:
  //   (a) emit envelope.retry.attempted with the right `reason`
  //   (b) route truncation through the budget-doubling path WITHOUT a
  //       corrective fragment (RFC 0033 §B), OR keep the corrective fragment
  //       on schema-violation WITHOUT a budget change (RFC 0033 §C).
  let lastError: unknown = null;
  let lastFailureReason: RetryReason | null = null;
  let lastFailureMessage: string | undefined;
  // Mutate per-attempt: truncation retries DOUBLE maxTokens; schema-violation
  // retries keep the original budget. Starting maxTokens defaults to the
  // request value (provider-default behavior preserves prior semantics
  // when undefined). The dispatch helper's request shape uses `maxTokens`
  // as an optional field — see ChatRequest in providers/dispatch.ts.
  let currentMaxTokens: number | undefined = req.maxTokens;
  // Schema hint is suppressed on truncation retries — RFC 0033 §B forbids
  // applying a schema-correction fragment to truncation failures (the
  // shape was right; only the output was incomplete).
  let suppressSchemaHint = false;
  // RFC 0032 §B.5 NL-to-Format fallback. After the retry loop exhausts
  // on parse-error / schema-violation, if the last response was clearly
  // natural-language (no JSON sigil in the first 16 bytes), fire ONE
  // extra dispatch with a strong coercion fragment. Tracks the last
  // raw text so the post-loop fallback decision has context.
  let lastResponseText = '';

  for (let attempt = 1; attempt <= reliabilityCfg.maxRetryAttempts; attempt++) {
    // Emit envelope.retry.attempted BEFORE the second-and-subsequent calls
    // per RFC 0032 §B.1 normative text. The first attempt does NOT emit.
    if (attempt > 1 && lastFailureReason !== null) {
      await scope.emit?.('envelope.retry.attempted',
        buildRetryAttemptedPayload(scope.nodeId, attempt, lastFailureReason, lastFailureMessage),
      ).catch((err) => {
        log.warn('envelope.retry.attempted emit failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Compose this attempt's system prompt. Truncation retries skip the
    // schema-shape hint (the previous attempt's shape was correct; only
    // the budget was insufficient).
    const systemForAttempt = suppressSchemaHint
      ? [req.systemPrompt, reasoningDirective].filter((s): s is string => Boolean(s)).join('\n\n')
      : augmentedSystem;
    const enrichedReq: AiCallRequest = {
      ...req,
      systemPrompt: systemForAttempt,
      ...(currentMaxTokens !== undefined ? { maxTokens: currentMaxTokens } : {}),
    };

    let raw: AiCallResult;
    try {
      raw = await dispatchPlain(scope, enrichedReq, apiKey);
    } catch (err) {
      lastError = err;
      lastFailureReason = 'parse-error';
      lastFailureMessage = err instanceof Error ? err.message : String(err);
      // Reset the truncation-suppression state for the next attempt —
      // a dispatch-layer error isn't truncation.
      suppressSchemaHint = false;
      continue;
    }

    // Per-attempt failure-mode classification. Refusal is checked first
    // (it's terminal — no retry); truncation second (drives budget-doubling
    // on next attempt); schema-violation last (drives corrective-fragment
    // retry per the existing path).
    const refusalDetected = isRefusalFinishReason(raw.finishReason);
    const truncationStopReason = classifyTruncationStopReason(raw.finishReason);

    if (refusalDetected) {
      // RFC 0032 §B.3 — emit envelope.refusal AND break the loop. Hosts
      // MUST NOT retry on refusal (circumvention concern per RFC 0033 §D).
      await scope.emit?.('envelope.refusal',
        buildRefusalPayload(
          scope.nodeId,
          req.provider,
          req.model,
          // `refusalText` is the provider's safety message when surfaced.
          // The mock provider populates raw.content with the refusal text;
          // production hosts extract from the provider response shape.
          // SR-1 redaction runs at the eventLog.append boundary in executor.ts
          // (stripSecretsFromPersisted), so canary substrings get scrubbed
          // before the payload lands in the durable event log.
          raw.content ?? null,
          // safetyCategory is provider-specific; the sample doesn't extract
          // it from the response. Production hosts populate from the
          // provider's safety-categories metadata block.
          null,
        ),
      ).catch((err) => {
        log.warn('envelope.refusal emit failed', { err: err instanceof Error ? err.message : String(err) });
      });
      throw new AiProviderError(
        'envelope_refusal',
        // Error message MUST NOT echo the refusal text per RFC 0033 §F +
        // SECURITY invariant envelope-refusal-no-prompt-leak. The refusal
        // text lives only on the event-log entry (redacted).
        `LLM provider returned an explicit refusal for ${req.provider}/${req.model}.`,
        { provider: req.provider, model: req.model },
      );
    }

    if (truncationStopReason !== null) {
      // RFC 0032 §B.4 — emit envelope.truncated. Compute partialPayload
      // signal by attempting parse on the truncated content; success here
      // is unusual but a model could emit valid partial JSON.
      let partialPayloadAvailable = false;
      try {
        if (raw.content && raw.content.length > 0) {
          JSON.parse(raw.content);
          partialPayloadAvailable = true;
        }
      } catch {
        partialPayloadAvailable = false;
      }
      await scope.emit?.('envelope.truncated',
        buildTruncatedPayload(
          scope.nodeId,
          req.provider,
          req.model,
          truncationStopReason,
          partialPayloadAvailable,
          raw.usage?.outputTokens ?? null,
        ),
      ).catch((err) => {
        log.warn('envelope.truncated emit failed', { err: err instanceof Error ? err.message : String(err) });
      });
      // RFC 0033 §B truncation retry path. Double the budget for the next
      // attempt; skip the schema-correction fragment (the shape was right).
      // Combined truncation + parse-failure is routed as truncation per
      // RFC 0033 §A priority rule — output budget is the upstream cause.
      lastError = new Error(`response truncated at finish_reason=${raw.finishReason}`);
      lastFailureReason = 'truncation';
      lastFailureMessage = `finish_reason=${raw.finishReason}; tokens=${raw.usage?.outputTokens ?? 'unknown'}`;
      const newBudget =
        currentMaxTokens !== undefined
          ? Math.min(currentMaxTokens * reliabilityCfg.truncationBudgetMultiplier, 64_000)
          : 4_000;
      currentMaxTokens = newBudget;
      suppressSchemaHint = true;
      continue;
    }

    // Clean-stop branch: parse + schema-validate. Schema-violation drives
    // the corrective-fragment retry per RFC 0033 §C (already in the
    // existing schemaHint composition).
    const text = raw.content ?? '';
    lastResponseText = text;
    // RFC 0032 §B.6 — lenient parsing. Try strict JSON.parse first; on
    // failure walk a small set of recovery paths (markdown-fence,
    // balanced-brace). Each path that succeeds emits
    // `envelope.recovery.applied` with the canonical
    // `{nodeId, path, byteOffset?}` shape and DOES NOT count against
    // the retry budget (per RFC 0033 §D: recovery is a parse-fixup, not
    // a retry — the model's emission was usable, just wrapped).
    const lenientParse = tryLenientParse(text);
    if (lenientParse !== null) {
      if (lenientParse.path !== 'direct') {
        await scope.emit?.('envelope.recovery.applied',
          buildRecoveryAppliedPayload(scope.nodeId, lenientParse.path, lenientParse.byteOffset),
        ).catch((err) => {
          log.warn('envelope.recovery.applied emit failed', { err: err instanceof Error ? err.message : String(err) });
        });
      }
      if (validateAgainstSchema(lenientParse.data, req.responseSchema)) {
        return {
          ...raw,
          content: undefined,
          data: lenientParse.data,
        };
      }
      lastError = new Error('structured output did not match required-key check');
      lastFailureReason = 'schema-violation';
      lastFailureMessage = 'required-key check failed';
      suppressSchemaHint = false;
    } else {
      lastError = new Error('structured output did not parse as JSON (even with lenient fallbacks)');
      lastFailureReason = 'parse-error';
      lastFailureMessage = 'JSON.parse failed + lenient recovery paths exhausted';
      suppressSchemaHint = false;
    }
  }

  // RFC 0032 §B.5 — NL-to-Format fallback. After retry exhaustion, if the
  // last response was clearly natural-language (no `{` / `[` sigil in the
  // first 16 bytes) AND the failure was parse/schema-violation (NOT
  // truncation — truncated NL is still truncated), fire ONE extra
  // dispatch with a strong coercion fragment. Per Tam et al. ("Let Me
  // Speak Freely?") this captures the common pattern where models emit
  // free-form prose when they should have emitted structured output;
  // the reformat call coerces the prose into the schema. Conformance-
  // detectable via `envelope.nlToFormat.engaged { originalEnvelopeType,
  // fallbackCalls }`.
  const isNlResponse = (text: string): boolean => {
    const head = text.trimStart().slice(0, 16);
    return head.length > 0 && !head.startsWith('{') && !head.startsWith('[') && !head.startsWith('```');
  };
  if (
    lastFailureReason !== null
    && lastFailureReason !== 'truncation'
    && lastFailureReason !== 'refusal'
    && isNlResponse(lastResponseText)
  ) {
    const originalEnvelopeType = inferEnvelopeType(req.responseSchema) ?? 'structured-output';
    await scope.emit?.('envelope.nlToFormat.engaged',
      { nodeId: scope.nodeId, originalEnvelopeType, fallbackCalls: 1 },
    ).catch((err) => {
      log.warn('envelope.nlToFormat.engaged emit failed', { err: err instanceof Error ? err.message : String(err) });
    });
    const coercionFragment =
      'Your previous response was natural language; you MUST emit a JSON object that exactly matches the response schema, with no preamble or trailing prose. Return only the JSON.';
    const coercedSystem = [req.systemPrompt, augmentedSystem, coercionFragment]
      .filter((s): s is string => Boolean(s))
      .join('\n\n');
    try {
      const raw = await dispatchPlain(scope, { ...req, systemPrompt: coercedSystem }, apiKey);
      const text = raw.content ?? '';
      const parsed = tryLenientParse(text);
      if (parsed !== null && validateAgainstSchema(parsed.data, req.responseSchema)) {
        return { ...raw, content: undefined, data: parsed.data };
      }
    } catch {
      /* fall through to exhaustion path */
    }
  }

  // Retry budget exhausted. RFC 0032 §B.2 — emit envelope.retry.exhausted
  // BEFORE throwing. The error code distinguishes truncation-exhaustion
  // (envelope_truncation_unrecoverable per RFC 0033 §F) from schema-
  // violation-exhaustion (envelope_invalid per RFC 0033 §F, renamed
  // 2026-05-21 from envelope_payload_invalid). Refusal path threw above
  // and doesn't reach here.
  const finalReason: RetryReason = lastFailureReason ?? 'unknown';
  await scope.emit?.('envelope.retry.exhausted',
    buildRetryExhaustedPayload(scope.nodeId, reliabilityCfg.maxRetryAttempts, finalReason, lastFailureMessage),
  ).catch((err) => {
    log.warn('envelope.retry.exhausted emit failed', { err: err instanceof Error ? err.message : String(err) });
  });

  const errorCode =
    finalReason === 'truncation'
      ? 'envelope_truncation_unrecoverable'
      : 'envelope_invalid';
  const errorMessage =
    finalReason === 'truncation'
      ? `Provider truncated the structured-output emission across ${reliabilityCfg.maxRetryAttempts} attempts; truncation-retry budget exhausted (RFC 0033 §B + §F).`
      : `Provider did not emit valid JSON matching the response schema after ${reliabilityCfg.maxRetryAttempts} attempts.`;
  throw new AiProviderError(errorCode, errorMessage, {
    lastError: lastError instanceof Error ? lastError.message : String(lastError),
    finalReason,
  });
}

/**
 * Legacy undifferentiated retry loop preserved for operators that set
 * `OPENWOP_ENVELOPE_RELIABILITY_END_TO_END=false`. No envelope-reliability
 * emission; no truncation-vs-schema-violation routing. Mirrors the pre-
 * RFC-0032 dispatchStructured behavior verbatim so a future regression
 * can't silently change semantics for hosts that opted out of the new
 * code path.
 */
async function dispatchStructuredLegacy(
  scope: AdapterScope,
  req: AiCallRequest,
  apiKey: string,
  augmentedSystem: string,
): Promise<AiCallResult> {
  const enrichedReq: AiCallRequest = { ...req, systemPrompt: augmentedSystem };
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= STRUCTURED_OUTPUT_RETRIES; attempt++) {
    let raw: AiCallResult;
    try {
      raw = await dispatchPlain(scope, enrichedReq, apiKey);
    } catch (err) {
      lastError = err;
      continue;
    }
    const text = raw.content ?? '';
    try {
      const data = JSON.parse(text);
      if (validateAgainstSchema(data, req.responseSchema)) {
        return { ...raw, content: undefined, data };
      }
      lastError = new Error('structured output did not match required-key check');
    } catch (parseErr) {
      lastError = parseErr;
    }
  }
  throw new AiProviderError(
    'envelope_invalid',
    `Provider did not emit valid JSON matching the response schema after ${STRUCTURED_OUTPUT_RETRIES + 1} attempts.`,
    { lastError: lastError instanceof Error ? lastError.message : String(lastError) },
  );
}

/** Shallow JSON Schema check: every key in `required[]` is present on
 *  the data object. Real production hosts run full Ajv2020 validation. */
function validateAgainstSchema(data: unknown, schema: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  if (!schema || typeof schema !== 'object') return true;
  const s = schema as Record<string, unknown>;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  for (const key of required) {
    if (!(key in (data as Record<string, unknown>))) return false;
  }
  return true;
}

/** RFC 0032 §B.5 — derive the envelope's `originalEnvelopeType` from
 *  the response-schema for `envelope.nlToFormat.engaged` event payload.
 *  Sample heuristics: prefer the schema's `$id` last-segment, fall back
 *  to `title`, otherwise return null (caller substitutes `'structured-
 *  output'`). Production hosts that emit named envelope kinds (e.g.
 *  `prd.create`) typically carry the kind on a wrapping metadata layer;
 *  this best-effort derivation is best-effort. */
function inferEnvelopeType(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as Record<string, unknown>;
  if (typeof s.$id === 'string') {
    const last = s.$id.split('/').pop();
    if (last && last.length > 0) return last.replace(/\.schema\.json$/, '');
  }
  if (typeof s.title === 'string' && s.title.length > 0) return s.title;
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────

function toChatMessages(req: AiCallRequest | AiToolCallRequest): readonly ChatMessage[] {
  const out: ChatMessage[] = [];
  if (req.systemPrompt) out.push({ role: 'system', content: req.systemPrompt });
  for (const m of req.messages) out.push({ role: m.role, content: m.content });
  return out;
}

function normalizeFinishReason(raw: string | undefined): AiCallResult['finishReason'] {
  if (!raw) return undefined;
  const r = raw.toLowerCase();
  if (['end_turn', 'stop'].includes(r)) return 'stop';
  if (['max_tokens', 'length'].includes(r)) return 'length';
  if (['safety', 'content_filter'].includes(r)) return 'content-filter';
  if (['tool_use', 'tool_calls'].includes(r)) return 'tool-call';
  return 'other';
}

function computeProviderKey(input: Record<string, unknown>): string {
  // Stable canonical JSON: walk keys in sorted order.
  const sorted = canonicalize(input);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function modelMatchesAllowlist(model: string, allowed: readonly string[]): boolean {
  for (const pattern of allowed) {
    if (pattern === model) return true;
    if (pattern.endsWith('*') && model.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

async function mapDispatchErrors<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // Preserve AbortError → provider_timed_out before string-matching.
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiProviderError('provider_timed_out', 'Provider call exceeded the configured timeout.', { provider });
    }
    if (err instanceof AiProviderError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // Provider error shapes (e.g., "anthropic_429: ...", "openai_404: ...")
    // get mapped to canonical aiProviders error codes per
    // `spec/v1/host-capabilities.md:141-154`. The provider's RAW error
    // body (which `providers/dispatch.ts` already truncates to 300
    // chars) is STASHED under `details.upstreamMessage` so audit
    // consumers can inspect it server-side, but the `AiProviderError.
    // message` itself never carries it — that prevents accidental
    // leakage of provider-side credential echoes through the run
    // event log's `node.failure.error.message` field.
    const upstreamMessage = msg.slice(0, 200);
    const match = msg.match(/^[a-z]+_(\d{3}):/i);
    if (match) {
      const status = Number(match[1]);
      if (status === 401 || status === 403) {
        throw new AiProviderError('byok_required_but_unresolved', 'Provider rejected credential.', { provider, status, upstreamMessage });
      }
      if (status === 404) {
        throw new AiProviderError('model_not_supported', 'Provider rejected model.', { provider, status, upstreamMessage });
      }
      if (status === 429) {
        throw new AiProviderError('provider_rate_limited', 'Provider rate-limited.', { provider, status, upstreamMessage });
      }
      if (status >= 500) {
        throw new AiProviderError('provider_unavailable', 'Provider 5xx.', { provider, status, upstreamMessage });
      }
      throw new AiProviderError('invalid_request', 'Provider rejected request.', { provider, status, upstreamMessage });
    }
    throw new AiProviderError('internal_error', 'Provider call failed — see span attributes for trace details.', { provider, upstreamMessage });
  }
}

/**
 * Bound an async operation by an AbortController. The signal is
 * passed into the operation so the underlying fetch can be aborted;
 * a separate timer rejects with an `AbortError` on timeout. Honors
 * `scope.timeoutMs` with a 120s default per `DEFAULT_TIMEOUT_MS`.
 */
async function runWithTimeout<T>(scope: AdapterScope, op: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = scope.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await op(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      const e = new Error(`request_timed_out_after_${timeoutMs}ms`);
      e.name = 'AbortError';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrap an upstream provider call in an OTel span. Follows the spec
 * taxonomy at `spec/v1/observability.md`:
 *
 *   - Span name: `openwop.activity.<provider>` (per §"Span attributes"
 *     line 217 — wraps external API calls)
 *   - Run/node attrs: `openwop.tenant_id`, `openwop.scope_id?`,
 *     `openwop.run_id`, `openwop.node_id`
 *   - Cost attrs: `openwop.cost.provider`, `openwop.cost.tokens.input`,
 *     `openwop.cost.tokens.output` (per §"Cost attribution attributes"
 *     lines 711-721)
 *   - Model + finish reason use the OTel GenAI semantic conventions
 *     (`gen_ai.*`) outside the `openwop.*` namespace.
 */
async function wrapInSpan<T extends AiCallResult | { usage?: { inputTokens?: number; outputTokens?: number }; finishReason?: string }>(
  scope: AdapterScope,
  provider: string,
  model: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('openwop.workflow-engine-sample');
  const span = tracer.startSpan(`openwop.activity.${provider}`, {
    attributes: {
      'openwop.tenant_id': scope.tenantId,
      ...(scope.scopeId ? { 'openwop.scope_id': scope.scopeId } : {}),
      'openwop.run_id': scope.runId,
      'openwop.node_id': scope.nodeId,
      'openwop.cost.provider': provider,
      'gen_ai.request.model': model,
    },
  });
  try {
    const r = await fn();
    const finish = 'finishReason' in r ? r.finishReason : undefined;
    if (finish) span.setAttribute('gen_ai.response.finish_reason', finish);
    const usage = 'usage' in r ? r.usage : undefined;
    if (usage?.inputTokens != null) span.setAttribute('openwop.cost.tokens.input', usage.inputTokens);
    if (usage?.outputTokens != null) span.setAttribute('openwop.cost.tokens.output', usage.outputTokens);
    span.setStatus({ code: SpanStatusCode.OK });
    return r;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}
