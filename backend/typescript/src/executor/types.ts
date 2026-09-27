/**
 * Executor-internal types.
 *
 * `NodeModule` is the contract every node-pack entry must satisfy. The
 * shape is intentionally narrow — a single async `execute(ctx)` function
 * returning `success`, `failure`, or `suspended`. Real openwop hosts
 * extend with retry policies, side-effect tracking, etc.; the sample
 * keeps it minimal.
 */

import type { ContentPart } from '../providers/dispatch.js';
import type { A2aSurface } from '../host/a2aSurface.js';
import type { KanbanSurface } from '../host/kanbanSurface.js';
import type { KnowledgeSurface } from '../host/knowledgeSurface.js';
import type { ChatSurface } from '../host/chatSurface.js';
import type { CanvasSurface } from '../host/canvasSurface.js';
import type { WebResearchSurface } from '../host/webResearchSurface.js';
import type { LaunchStudioSurface } from '../host/launchStudioSurface.js';
import type { FeatureSurface } from '../host/featureSurfaces.js';
import type { fetch as undiciFetch } from 'undici';
import type { CompensationPolicy } from '../host/compensationUnwind.js';
import type { PackNodeOrigin } from '../host/packWorkerContract.js';
import type { TraceContext } from '../host/traceContext.js';

/** Host-mediated egress fn (ctx.http.safeFetch). Mirrors the undici `fetch`
 *  signature exactly so the host injection layer + the pack agree on the shape
 *  (RFC 0076 §B). Type-only import — erased at build, no runtime coupling. */
export type HostSafeFetch = (url: string, init?: Parameters<typeof undiciFetch>[1]) => ReturnType<typeof undiciFetch>;

/**
 * Single message in a chat-style AI request. Field shapes mirror
 * `spec/v1/host-capabilities.md §host.aiProviders` verbatim.
 */
export interface AiCallMessage {
  role: 'user' | 'assistant' | 'system';
  /** RFC 0091 / A9 — `string` (text-only, always valid) OR typed multimodal
   *  PERCEPTION parts (text/image/file/audio). Non-text modalities are gated on
   *  `aiProviders.input.modalities`; an unadvertised one is rejected with
   *  `unsupported_modality`. */
  content: string | readonly ContentPart[];
}

/**
 * Request shape for `ctx.callAI(...)`. Implements the spec's
 * §host.aiProviders contract. `responseSchema` switches the call into
 * structured-output mode; `embeddingMode` switches into embeddings
 * mode (declared for type-completeness; sample host returns
 * `host_capability_missing` for embeddings).
 */
export interface AiCallRequest {
  /** Provider id — MUST be in the host's advertised aiProviders.supported list. */
  provider: string;
  /** Provider-specific model id. */
  model: string;
  /** Optional system prompt (top-level for Anthropic / Gemini; first message for OpenAI). */
  systemPrompt?: string;
  /** Conversation. Non-empty unless `embeddingMode` is true. */
  messages: ReadonlyArray<AiCallMessage>;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: ReadonlyArray<string>;
  /** When present, the host requests structured-output mode and
   *  attempts to parse the result against this JSON Schema. */
  responseSchema?: Record<string, unknown>;
  /** When true, this is an embedding request — `messages` is treated
   *  as the input text (first message's content). */
  embeddingMode?: boolean;
  /** Optional dimensions for the embedding (provider-dependent). */
  dimensions?: number;
  /** BYOK credentialRef. Required when policy is `required`; otherwise
   *  the host MAY route through its own credential of last resort. */
  credentialRef?: string;
  /** ADR 0079 §Phase 4 — opt INTO progressive token streaming for this call:
   *  the host emits `output.chunk` deltas onto the run event log as the
   *  plain reply generates. Default (omitted/false) emits NO deltas — set it
   *  only when an interactive surface tails this run's SSE, so non-interactive
   *  batch/agent nodes don't write one durable event per token for no consumer.
   *  Ignored for structured-output / embedding calls (they never stream). */
  stream?: boolean;
}

/**
 * Result shape for `ctx.callAI(...)`. Note: `credentialRefHashed` is
 * the SHA-256 of `credentialRef` — the cleartext API key NEVER
 * appears in the result. This is enforced by
 * `aiProviders/aiProvidersHost.ts`.
 */
export interface AiCallResult {
  /** Free-form chat output. Absent for structured-output / embedding modes. */
  content?: string;
  /** Parsed structured-output payload. Present iff `responseSchema` was supplied. */
  data?: unknown;
  /** Embedding vector. Present iff `embeddingMode` was true. */
  embedding?: ReadonlyArray<number>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Canonical: `stop` | `length` | `content-filter` | `tool-call` | `other`. */
  finishReason?: 'stop' | 'length' | 'content-filter' | 'tool-call' | 'other';
  model?: string;
  /** SHA-256 hex of the credentialRef used (NEVER the cleartext key). */
  credentialRefHashed?: string;
}

/**
 * Request shape for `ctx.callSpeechSynthesizer(...)` — RFC 0105
 * (speech synthesis / text-to-speech). A parallel of `AiCallRequest`:
 * a single call produces ONE speaker turn from `text`, whole-file (no
 * streaming), plain text (no SSML). The LOCKED wire shape — field names
 * are normative and MUST match the RFC verbatim.
 */
export interface SpeechSynthesisRequest {
  /** Provider id. Defaults to the host's managed speech provider ('minimax'). */
  provider?: string;
  /** Provider-specific model id. Defaults to the provider's recommended voice model. */
  model?: string;
  /** Text to synthesize. REQUIRED, non-empty. Plain text — NO SSML. */
  text: string;
  /** Opaque, provider-specific voice id. REQUIRED. */
  voiceId: string;
  /** Desired audio container/codec MIME (advisory; provider may normalize). */
  mimeType?: string;
  /** Provider-specific format hint (e.g. 'mp3'). */
  format?: string;
  /** BCP-47 language hint. */
  languageCode?: string;
  /** Speaking-rate multiplier (1.0 = normal). */
  speed?: number;
  /** Determinism seed where the provider supports it. */
  seed?: number;
  /** BYOK credentialRef. When omitted, the host MAY route through its
   *  managed credential of last resort. */
  credentialRef?: string;
  /** RFC 0106 §C streaming arm (ADR 0109 P3). When true (and the host advertises
   *  `aiProviders.realtimeVoice.synthesis: "streaming"`), the host emits
   *  `voice.synthesis_chunk` METADATA-ONLY run-events on the durable log while
   *  synthesizing; the Promise still resolves with the finished whole-file asset.
   *  Default false = RFC 0105 whole-file behavior, unchanged. */
  stream?: boolean;
}

/**
 * Result shape for `ctx.callSpeechSynthesizer(...)` — RFC 0105.
 * EXACTLY ONE of `audio.url` / `audio.base64` is present: the host
 * returns a tenant-scoped asset URL for synthesized bytes. The LOCKED
 * wire shape — field names are normative and MUST match the RFC verbatim.
 */
export interface SpeechSynthesisResult {
  audio: {
    /** Tenant-scoped asset URL. Present iff `base64` is absent. */
    url?: string;
    /** Inline base64 audio. Present iff `url` is absent. EXACTLY ONE of url|base64. */
    base64?: string;
    /** MIME of the returned audio (e.g. 'audio/mpeg'). */
    mimeType: string;
    /** Decoded duration where the host can compute it. */
    durationSeconds?: number;
    /** Echo of the input `voiceId`. */
    voiceId: string;
    /** Echo of the input `seed` where supplied. */
    seed?: number;
    metadata?: {
      model?: string;
      provider?: string;
      generationTimeMs?: number;
    };
  };
  /** Wall-clock time the host spent on the whole call. */
  totalTimeMs?: number;
  usage?: {
    totalCost?: number;
    /** Characters of `text` synthesized. */
    characters?: number;
  };
}

/**
 * Request shape for `ctx.callTranscriber(...)` — RFC 0106 §B (real-time
 * streaming transcription, post-amendment shape openwop#745). ONE call =
 * ONE turn: the Promise resolves at `voice.turn_commit` with the settled
 * final transcript, while interim / `voice.speech_start` /
 * `voice.endpoint_candidate` / `voice.turn_commit` arrive as `voice.*`
 * run-events on the durable log (the C1 single-taxonomy, replay-safe path —
 * the `callAI(stream:true)` emit-to-log idiom). The live audio SOURCE is a
 * `streamRef` (an opaque, session-bound LIVE handle, RFC 0106 §B.1) or a
 * host-fetchable `url`; inline base64 and a finite-blob `mediaRef` are NOT
 * permitted (a live stream is unbounded). The LOCKED wire shape.
 */
export interface TranscribeRequest {
  /** Provider id. Defaults to the host's managed STT provider. */
  provider?: string;
  /** Provider-specific model id. */
  model?: string;
  /** The live audio SOURCE — EXACTLY ONE of `streamRef` / `url`. */
  audio: { streamRef?: string; url?: string };
  /** BCP-47 language hint (e.g. 'en-US'). */
  languageCode?: string;
  /** Request provisional `voice.transcript` parts (default true). */
  interimResults?: boolean;
  /** Advisory endpointing hint; host MAY clamp. Semantics stay host-defined. */
  endpointing?: { silenceMs?: number };
  /** BYOK credentialRef. When omitted, the host MAY route through its managed credential. */
  credentialRef?: string;
}

/**
 * Result shape for `ctx.callTranscriber(...)` — RFC 0106 §B. The Promise
 * resolves at `voice.turn_commit` with the settled final transcript for the
 * turn. The interim/endpoint signals were emitted as `voice.*` run-events
 * (the canonical, replay-safe record on the durable log); this return value
 * is just the committed turn. The LOCKED wire shape.
 */
export interface TranscriptResult {
  /** The settled final transcript for this turn (== `voice.turn_commit.finalText`). */
  finalText: string;
  /** Audio-time (ms) of the turn commit. */
  atMs: number;
  /** BCP-47 language used, where the host can report it. */
  language?: string;
  usage?: { totalCost?: number; audioMs?: number };
}

/** Request shape for `ctx.callImageGenerator(...)` (ADR 0115) — text-to-image. The
 *  `core.openwop.ai.image-generate` node delegates `{...config, ...inputs}` here;
 *  host-mediated credential, never carried in node code. */
export interface ImageGenerationRequest {
  prompt: string;
  provider?: string;        // default 'openai' (gpt-image); 'mock' under the test seam
  model?: string;
  size?: string;            // e.g. '1024x1024'
  n?: number;               // image count (host-clamped)
  seed?: number;
  credentialRef?: string;   // BYOK; managed resolution otherwise
}

/** Result shape for `ctx.callImageGenerator(...)`. Each image is persisted as a
 *  host Media asset (ADR 0007/0083) and carried as a `media:`/asset URL — never raw
 *  base64 on the result boundary. */
export interface ImageGenerationResult {
  images: Array<{ url: string; mimeType: string; metadata?: { model?: string; provider?: string; seed?: number } }>;
  totalTimeMs?: number;
  usage?: { images: number };
}

/** Request/result for `ctx.callVideoGenerator(...)` (ADR 0411) — text-to-video.
 *  The accepted spec contract (host-capabilities.md §host.aiProviders): host
 *  HIDES async polling, videos return as a host-served URL (never inline
 *  base64), and `ctx.signal` aborts. */
export interface VideoGenerationRequest {
  prompt: string;
  provider?: string;        // default 'replicate' (hosts Veo 3 + many models)
  model?: string;           // e.g. 'google/veo-3-fast'
  negativePrompt?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  includeAudio?: boolean;
  seed?: number;
  brandColors?: string[];
  credentialRef?: string;   // BYOK
}

export interface VideoGenerationResult {
  video: {
    url: string;            // host-served (videos are too large for inline base64)
    durationSeconds: number;
    width: number;
    height: number;
    mimeType: string;       // 'video/mp4' | 'video/webm'
    fileSizeBytes?: number;
    seed?: number;
    safetyFiltered: boolean;
    metadata?: { model?: string; provider?: string; generationTimeMs?: number };
  };
  totalTimeMs?: number;
  usage?: { videos: number };
}

/** Request shape for `ctx.callImageEditor(...)` (ADR 0401) — raster edit ops on
 *  an existing image: whole-image edit (prompt), inpaint/generative-fill
 *  (prompt + mask), background-remove (no prompt). Bytes arrive base64 (the
 *  node schema's `imageBase64`); results persist as Media assets, never raw
 *  bytes on the result boundary. Unsupported (provider, op) pairs are a typed
 *  `host_capability_missing` — never a silent fallback. */
export interface ImageEditRequest {
  imageBase64: string;
  mimeType?: string;
  op: 'edit' | 'inpaint' | 'background-remove';
  prompt?: string;          // required for edit/inpaint; forbidden for background-remove
  maskBase64?: string;      // required for inpaint (white = repaint)
  provider?: string;        // default 'replicate' (the full-op-set vendor)
  model?: string;
  credentialRef?: string;
}

/** Request shape for `ctx.callImageUpscaler(...)` (ADR 0401). */
export interface ImageUpscaleRequest {
  imageBase64: string;
  mimeType?: string;
  scale: 2 | 4;
  provider?: string;        // default 'replicate'
  model?: string;
  credentialRef?: string;
}

/** Request shape for `ctx.runSandboxedCode(...)` (ADR 0114) — execute a snippet in
 *  an EXTERNAL sandbox. Host-mediated; the sandbox endpoint + key are a brokered
 *  Connection credential, never carried in node code. */
export interface SandboxExecRequest {
  /** Adapter-validated language id, e.g. `python` / `javascript`. */
  language: string;
  code: string;
  stdin?: string;
  /** Per-call wall-clock cap; the adapter clamps to its own ceiling. */
  timeoutMs?: number;
}

/** Result shape for `ctx.runSandboxedCode(...)`. `files` become typed artifacts
 *  (ADR 0055) downstream; `contentTrust:'untrusted'` applies to all execution
 *  output (it is model/code-derived, not operator-trusted). */
export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  files?: Array<{ name: string; mimeType: string; base64: string }>;
}

/** Tool definition handed to `ctx.callAIWithTools(...)`. */
export interface AiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AiToolCallRequest extends Omit<AiCallRequest, 'responseSchema' | 'embeddingMode' | 'dimensions'> {
  tools: ReadonlyArray<AiTool>;
  /** Enable the provider's NATIVE web search/grounding for this turn, using the
   *  same provider key (ADR 0101). Honored only by providers that advertise it. */
  webSearch?: boolean;
}

/** Tool-use block from a single `callAIWithTools` round. Pack-level
 *  workflow code orchestrates execution + replies by appending tool
 *  results to its `messages` array on the next call. */
export interface AiToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A web-search/grounding source (ADR 0101 Phase 2), mirroring the provider
 *  `Citation` shape so native sources can be surfaced + replayed. */
export interface AiCitation {
  url: string;
  title?: string;
  snippet?: string;
}

export interface AiToolCallResult extends AiCallResult {
  /** Tool-use requests from the model. Empty array when the model
   *  produced only text. */
  toolCalls?: ReadonlyArray<AiToolUseBlock>;
  /** Sources from the provider's native web search/grounding this round. */
  citations?: ReadonlyArray<AiCitation>;
}

/** Runtime agent reference per `agent-ref.schema.json` (Multi-Agent
 *  Shift Phase 1). `agentId` is required; everything else is optional
 *  metadata. `sourceManifestId` is the RFC 0003 provenance pointer back
 *  to the `AgentManifest.agentId` this ref was projected from (absent
 *  for host-internal `host:<id>` agents). */
export interface AgentRef {
  agentId: string;
  name?: string;
  modelClass?: string;
  memoryRef?: string;
  version?: string;
  channel?: string;
  sourceManifestId?: string;
}

/**
 * ADR 0099 — the resolved per-run tool-output compaction decision. Frozen into
 * `run.metadata.compaction` at run creation and read verbatim on `:fork`. The
 * core contract of the `host/toolResultTransform` seam; the kernel lives in the
 * `tool-output-compaction` feature (core owns the type, not the implementation).
 */
export interface CompactionDecision {
  /** `off` → identity. `lossless` → MINIFY ONLY: insignificant whitespace is
   *  DELETED FROM THE SOURCE TEXT, so the output is the input minus whitespace
   *  and every other byte survives (keys, string values, numeric literals,
   *  escapes, key order, duplicate keys). `lossy` → re-serialises, and
   *  additionally drops structurally-empty fields and elides long arrays, each
   *  with an explicit disclosure marker (`_emptied` / `_elided`); because it
   *  rebuilds the value, IEEE-754 normalisation and last-key-wins apply there.
   *
   *  CORRECTED 2026-08-23 (review H2 / ADR 0604): the paragraph above used to
   *  say `lossless` is "provably information-preserving: `JSON.parse(out)`
   *  deep-equals `JSON.parse(in)`". That claim was true and the WRONG CLAIM —
   *  the string is what reaches the model, and re-serialising rewrote it:
   *  `{"a": 9007199254740993}` → `{"a":…992}`, `{"a":1e400}` → `{"a":null}`,
   *  `{"status":"ok","status":"degraded"}` → `{"status":"degraded"}`. The
   *  witness asserted the parse-level identity, so it was blind to all of it by
   *  construction. `lossless` no longer re-serialises.
   *
   *  CORRECTED 2026-08-23 (TOCC-3 / ADR 0604): this line used to read "`lossless`
   *  → minify + drop-empty", i.e. it defined a mode named lossless as one that
   *  deletes fields. Measured, `{"results":[],"query":"q"}` became
   *  `{"query":"q"}` and `{"agents":[],…}` became `{}` — an honest empty turned
   *  into an absent field. Dropping now lives only under `lossy`. */
  mode: 'off' | 'lossless' | 'lossy';
  /** Lossy only: rows kept from the head of a long array (default 3). */
  head?: number;
  /** Lossy only: rows kept from the tail of a long array (default 1). */
  tail?: number;
  /** Skip payloads at or below this many chars (default 0 = compact everything). */
  minChars?: number;
  /** Tool names whose output is exempt from compaction (kept byte-exact). */
  exemptTools?: string[];
}

export interface NodeContext {
  runId: string;
  nodeId: string;
  tenantId: string;
  /** ADR 0632 — the run's abort signal (armed once per run by `executeRunBody`).
   *  Fires on cancel and on an `immediate` pause; a long-running node body
   *  (sleeps, provider calls) SHOULD race against it. `undefined` when the
   *  node is reached outside a run body (a test harness). */
  signal?: AbortSignal;
  scopeId?: string;
  inputs: unknown;
  config?: Record<string, unknown>;
  /** Multi-Agent Shift Phase 1 — the node's authoring-time agent pin
   *  (`node.agent`, an `agent-ref.schema.json`), surfaced so node modules
   *  can honor `nodes[].agent.agentId`. Undefined when the node carries no
   *  pin. Distinct from `config`, which the schema models as a sibling. */
  nodeAgent?: AgentRef;
  /** Run-level configurable overlay from RunOptions.configurable. */
  configurable: Record<string, unknown>;
  /** ctx.triggerData — the run-scoped trigger payload the `core.openwop.triggers`
   *  entry nodes surface to downstream nodes. Captured at run start, identical
   *  for every node (replay-safe). `undefined` for runs not started by a
   *  trigger that carries a payload. */
  triggerData?: unknown;
  /** Per-attempt counter; first attempt = 1. */
  attempt: number;
  /** Trust boundary of inputs entering this node (RFC 0020 §D).
   *
   *   - `'trusted'` (default): inputs come from authenticated openwop callers,
   *     internal workflow chaining, or other host-trusted sources.
   *   - `'untrusted'`: inputs originated from an external untrusted boundary
   *     (e.g. inbound MCP `tools/call.arguments`, A2A peer messages, raw
   *     webhook payloads). Pack nodes that forward this content to LLM
   *     surfaces SHOULD mark it as untrusted per the
   *     `threat-model-prompt-injection.md` UNTRUSTED-marker convention.
   *
   * Read from `run.metadata.trustBoundary` at run-start; constant across
   * the run. Defaults to `'trusted'` when metadata is absent. */
  trustBoundary?: 'trusted' | 'untrusted';
  /**
   * ADR 0189 — true when a human chat session created this run
   * (`run.metadata.chatSessionId`, stamped by the chat transport) AND an
   * acting human exists (`metadata.actingUserId`). Gates the mid-run
   * connect-to-continue prompt: only an interactive run may suspend on
   * `connector_no_connection`; headless runs (scheduler / heartbeat / A2A /
   * system) never carry the marker and keep the graceful fail-closed no-op
   * (ADR 0033). Derived once at ctx build (the `trustBoundary` pattern). */
  interactiveSession?: boolean;
  /**
   * ADR 0099 — the per-run tool-output compaction decision, frozen into
   * `run.metadata.compaction` at run creation and read here at run-start
   * (the `trustBoundary` pattern). Constant across the run; copied verbatim on
   * `:fork`. Nodes that assemble tool-result content (the LLM-tools node) pass
   * it to `applyToolResultTransform`. `undefined` ⇒ identity (no compaction). */
  compaction?: CompactionDecision;
  /**
   * RFC 0151 §C — present ONLY when this node is executing as an INVERSE ACTION
   * (a compensator the unwind invoked), absent on every forward execution.
   *
   * WHY A COMPENSATOR NEEDS THIS AND A FORWARD NODE DOES NOT. §C requires the
   * inverse-action identity to be retry-stable — "a retry re-presents the SAME
   * identity as its idempotency key; a second key at the downstream is a second
   * obligation (two refunds)" — and `attempt` is deliberately OUTSIDE that
   * identity for exactly this reason. The host holds the identity in the ledger,
   * but the thing that must present it to the downstream provider is the
   * compensator itself. Without this block it could not: a refund node had no
   * way to reach its obligation's id, so its idempotency key would have to be
   * derived from something else — and anything else varies per attempt, which
   * is how one refund becomes three.
   *
   * `inverseActionId` is the §C tuple's opaque digest and is CONSTANT across
   * retries of the same obligation; `attempt` moves. Use the former as the
   * idempotency key, never a composition of the two.
   *
   * Added by the ADR 0554 wire flip, when advertising `capabilities.compensation`
   * made §C a MUST this host had to be able to honour AND witness — the §21
   * recovery seam reports the key the fake downstream received on each attempt,
   * and a seam that invented that key would prove nothing about production.
   */
  compensation?: {
    readonly inverseActionId: string;
    readonly attempt: number;
  };
  /** Resolved BYOK secret values keyed by `credentialRef`. Empty if none required. */
  secrets: Record<string, string>;
  /**
   * Emit a side-effect-free event into the run log.
   *
   * Returns the persisted event's `eventId` + `sequence` so the node
   * can build downstream `causationId` chains per RFC 0002 §B (e.g.,
   * `agent.toolReturned.causationId MUST equal agent.toolCalled.eventId`).
   * Callers that don't need the return value can ignore it — additive
   * relative to the prior `Promise<void>` signature.
   *
   * `opts.causationId` stamps the persisted event ENVELOPE's
   * `causationId` (run-event.schema.json §causationId) — distinct from
   * any payload-level mirror. RFC 0002 §B's toolCalled→toolReturned
   * chain is asserted by the conformance suite at the envelope level.
   */
  emit(
    type: string,
    payload: unknown,
    opts?: { causationId?: string },
  ): Promise<{ eventId: string; sequence: number }>;
  /**
   * Spec-defined AI provider entry point per
   * `spec/v1/host-capabilities.md §host.aiProviders`. Present when
   * the host advertises `capabilities.aiProviders.supported`.
   * Routes through host-managed credential resolution + policy
   * enforcement; the cleartext API key never crosses the call
   * boundary back into the node.
   */
  callAI?(req: AiCallRequest): Promise<AiCallResult>;
  /**
   * Tool-calling variant. Present iff the host advertises
   * `aiProviders.toolCalling.supported`. Anthropic-only in this sample.
   */
  callAIWithTools?(req: AiToolCallRequest): Promise<AiToolCallResult>;
  /**
   * Speech-synthesis (text-to-speech) entry point per RFC 0105.
   * Present iff the host advertises `aiProviders.speechSynthesis`.
   * One call = one speaker turn, whole-file (no streaming), plain text
   * (no SSML). Routes through host-managed credential resolution; the
   * cleartext API key never crosses the call boundary back into the node.
   */
  callSpeechSynthesizer?(req: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>;
  /**
   * Real-time streaming transcription (speech-to-text) per RFC 0106 §B.
   * Present iff the host advertises `aiProviders.realtimeVoice.transcription`.
   * ONE call = ONE turn: resolves at `voice.turn_commit` with the settled
   * final transcript; interim / `voice.speech_start` / `voice.endpoint_candidate`
   * / `voice.turn_commit` are emitted as `voice.*` run-events on the durable
   * log (the single canonical, replay-safe taxonomy — C1). `voice.transcript`
   * carries `contentTrust:'untrusted'` (RFC 0106 §F live-ingress boundary).
   */
  callTranscriber?(req: TranscribeRequest): Promise<TranscriptResult>;
  /**
   * Sandboxed code execution (ADR 0114). Present IFF the host wires an EXTERNAL
   * sandbox adapter; ABSENT by default — the `feature.code-exec.nodes.run` node
   * throws `capability_not_provided` when it's missing (honest-off, the same shape
   * as the optional methods above). The sandbox endpoint + key are a brokered
   * Connection credential, never in node code; the call is the only egress the
   * node makes (SSRF-guarded). A NORMATIVE cross-host code-execution capability
   * advertisement would require an openwop RFC — this ctx method is non-normative
   * host-extension only.
   */
  runSandboxedCode?(req: SandboxExecRequest): Promise<SandboxExecResult>;
  /**
   * Text-to-image generation (ADR 0115). Present IFF the host implements it; the
   * existing `core.openwop.ai.image-generate` node delegates here. Output images
   * are persisted as host Media assets; a deterministic mock runs under the test
   * seam. Advertised `imageGeneration:{supported:true}` ONLY when a real provider
   * is configured (the speechSynthesis honesty rule).
   */
  callImageGenerator?(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
  /** ADR 0401 — raster edit ops (edit / inpaint / background-remove). */
  callImageEditor?(req: ImageEditRequest): Promise<ImageGenerationResult>;
  /** ADR 0401 — 2×/4× upscale. */
  callImageUpscaler?(req: ImageUpscaleRequest): Promise<ImageGenerationResult>;
  /** ADR 0411 — generative video (text-to-video); host-hidden async polling. */
  callVideoGenerator?(req: VideoGenerationRequest): Promise<VideoGenerationResult>;
  /**
   * Host capability surfaces per RFCs 0014–0019. Present when the host
   * wires `initInMemorySurfaces()` (demo) or a real-backend equivalent.
   * Pack delegates index into these maps directly; the index signatures
   * are intentionally loose to match how packs spread `{ ...config,
   * ...inputs }` into surface methods. See
   * `src/host/inMemorySurfaces.ts` for the demo implementation and
   * the surface-shape comments next to each field.
   */
  storage?: HostStorageSurfaces;
  /** ctx.db.{sql, vector, …} — see RFC 0018. */
  db?: HostDbSurfaces;
  /** ctx.fs — RFC 0014 file-system surface. */
  fs?: HostFsSurface;
  /** ctx.queueBus — RFC 0017 messaging bus (used by core.messaging.* nodes). */
  queueBus?: HostQueueBusSurface;
  /** ctx.observability — used by core.openwop.obs nodes. */
  observability?: HostObservabilitySurface;
  /** ctx.a2a — RFC 0076 §A `host.a2a`. The A2A (Agent-to-Agent) client the
   *  `core.openwop.a2a` pack delegates to (`spec/v1/a2a-integration.md`). */
  a2a?: A2aSurface;
  /** ctx.kanban — `host.kanban`. The `vendor.myndhyve.kanban` pack's bridge to
   *  the demo kanban store (`spec/v1/host-capabilities.md §host.kanban`). */
  kanban?: KanbanSurface;
  /** ctx.knowledge — `host.knowledge`. Lexical RAG retrieval for the
   *  `vendor.myndhyve.knowledge-tools` pack (§host.knowledge). */
  knowledge?: KnowledgeSurface;
  /** ctx.features.<id> — typed surfaces a BackendFeature contributes for
   *  workflow nodes (ADR 0014). `ctx.features.kb.search({orgId,collectionId,
   *  query})` etc. Methods enforce tenant isolation (CTI-1) via the feature
   *  service; called from `role:action` nodes (recorded → replay-safe). */
  features?: Record<string, FeatureSurface>;
  /** ctx.chat — `host.chat`. The `vendor.myndhyve.chat` pack's bridge to the
   *  demo chat store (`spec/v1/host-capabilities.md §host.chat`). */
  chat?: ChatSurface;
  /** ctx.interrupt / ctx.suspend — the normative interrupt primitive
   *  (`spec/v1/interrupt.md §"engine MUST expose interrupt"`). Awaitable:
   *  suspends the run and returns the resume value on re-entry, short-circuiting
   *  on the deterministic `key` (interrupt.md §"key field"). `interrupt` is the
   *  spec name; `suspend` is the alias the packs call. */
  interrupt?(payload: Record<string, unknown>): Promise<unknown>;
  suspend?(payload: Record<string, unknown>): Promise<unknown>;
  /** ctx.canvas — `host.canvas`. Durable shared-canvas store for the
   *  `vendor.myndhyve.canvas` pack (§host.canvas). */
  canvas?: CanvasSurface;
  /** ctx.webResearch — `host.webResearch` (§host.webResearch). */
  webResearch?: WebResearchSurface;
  /** ctx.launchStudio — `host.launchStudio` (§host.launchStudio). */
  launchStudio?: LaunchStudioSurface;
  /** ctx.userId — opaque principal id for vendor surfaces that key context on
   *  a user (e.g. launch-studio). The sample host sets it to the run tenant. */
  userId?: string;
  /** ctx.actingUserId — the DURABLE human the run was created for (ADR 0024 §4 /
   *  D2). Distinct from `userId` (which the sample maps to the tenant for
   *  launch-studio keying): this is the run owner's stable user id, the principal
   *  the Connections broker resolves per-user credentials + `connections:use`
   *  against. Absent for system runs (schedule / inbound webhook — no human),
   *  which is the correct fail-closed signal. Stamped on `run.metadata.actingUserId`
   *  at run creation and re-stamped to the FORKING caller on `:fork`. */
  actingUserId?: string;
  /** RFC 0207 §A/§B — the W3C trace context the RUN was created under
   *  (`run.metadata.traceContext`, a reserved key stamped host-side from the
   *  creating request's `traceparent` header). A node that calls out over MCP
   *  or A2A carries a CHILD of it in both the in-message carrier and the HTTP
   *  header, so the peer's spans join the caller's trace. Absent when the run
   *  was started with no inbound trace.
   *
   *  CORRELATION ONLY. It is never read as tenant, principal or scope, and no
   *  node may derive authority from it. */
  traceContext?: TraceContext;
  /** ctx.http — host-mediated egress (RFC 0076 §B). When present, the
   *  `core.openwop.http` pack routes ALL outbound calls through `safeFetch`
   *  (delegating SSRF defense to the host) instead of its in-pack fallback. The
   *  sample provides this ONLY for runs that opted into Connections
   *  (`configurable.connections` non-empty), where `safeFetch` also injects the
   *  acting user's credential for an allow-listed, host-matched provider
   *  (ADR 0024 §4 / Option C). */
  http?: { safeFetch: HostSafeFetch };
  /** ctx.slack — Slack egress for `core.openwop.integration.slack-message`
   *  (ADR 0024 §4 Phase 3). The host resolves the run's acting human's Slack
   *  Connection and calls `chat.postMessage` with the token. No connection ⇒ a
   *  graceful `{ ok:false }`, never a throw. Type kept inline to avoid an import
   *  cycle (the adapter pulls in the broker + undici). */
  slack?: {
    postMessage(args: {
      channel: string;
      text: string;
      blocks?: unknown;
      threadTs?: string;
      broadcast?: boolean;
      workspace?: string;
      asUser?: boolean;
      idempotencyKey?: string;
    }): Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }>;
  };
  /** ctx.ads — outbound ad-platform dispatch for `feature.campaign-channels.nodes.
   *  publish-ad-variants` (ADR 0167; production payloads + LinkedIn per ADR 0223).
   *  Resolves the acting human's ad-platform Connection and creates a PAUSED campaign
   *  pipeline through the broker; fork-stable idempotent (no duplicate paid campaign
   *  on replay/fork). No connection ⇒ `{ outcome:'no_connection' }` (the node falls
   *  back to the document handoff, ADR 0166), never a throw. Inline to avoid an
   *  import cycle. */
  ads?: {
    publishAd(args: {
      platform: 'meta' | 'google' | 'tiktok' | 'linkedin';
      briefId: string;
      adAccountId: string;
      campaignName: string;
      objective?: string;
      copy: { headline: string; description?: string; bodyText?: string; ctaText?: string };
      dailyBudgetMinor?: number;
      /** REQUIRED for google (`missing_landing_url` otherwise — finalUrls is
       *  mandatory); threaded into the meta/tiktok/linkedin creative when present. */
      landingUrl?: string;
      /** Meta ONLY: the Facebook Page publishing the creative story — REQUIRED for a
       *  meta dispatch (`missing_page_id` otherwise). */
      pageId?: string;
      /** TikTok ONLY: the posting identity (`identity_type: 'CUSTOMIZED_USER'`) —
       *  REQUIRED for a tiktok dispatch (`missing_identity_id` otherwise). */
      identityId?: string;
      /** Optional media-library asset (assetId or serve token), uploaded platform-side
       *  (Meta adimages image_hash / TikTok image upload image_ids). Bytes are resolved
       *  host-side and never appear in outputs or dry-run plans. */
      mediaAssetId?: string;
      /** Preview mode: build the exact PAUSED create payloads and return them as a
       *  plan WITHOUT calling the platform — zero platform calls, nothing persisted. */
      dryRun?: boolean;
    }): Promise<
      | { outcome: 'no_connection' }
      | { outcome: 'failed'; error: string }
      // Preview (dryRun). CONSUMER CONTRACT: when `alreadyDispatched` is true a real
      // run would REUSE the recorded campaign (the `plan` would NOT execute) — gate
      // the UI on the flag, don't render the plan as "would create". `connectionReady`
      // false ⇒ the plan is valid but a real dispatch would fail closed (`no_connection`)
      // until the platform connection is wired.
      | { outcome: 'preview'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; plan: Array<{ step: string; body: Record<string, unknown> }>; alreadyDispatched?: boolean; connectionReady?: boolean; platformCampaignId?: string }
      // Spend governance (campaign gap plan §5B B3): the tenant's ad-spend policy
      // requires a human sign-off (kind 'campaign-spend' in the ONE approvals
      // inbox). Nothing was created; approve + re-run proceeds (same fork-stable key).
      | { outcome: 'requires_approval'; approvalId: string }
      | { outcome: 'published'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; platformCampaignId: string; platformAdSetId: string; platformAdId: string; reviewStatus: 'pending_review'; paused: true; reused: boolean }
    >;
    /** Read a campaign's performance metrics from the connected platform (ADR 0186
     *  slice 4a) — READ-ONLY, provider-agnostic. Graceful `no_connection`;
     *  `unsupported` for a platform without a reader (tiktok/linkedin today). */
    /** Upload a hashed member list as a platform custom audience (ADR 0217).
     *  Hashes only — never raw addresses; default require-approval gate. */
    syncAudience?(args: { platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; adAccountId: string; audienceName: string; memberHashes: string[]; membersKey: string }): Promise<
      | { outcome: 'no_connection' }
      | { outcome: 'unsupported'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin' }
      | { outcome: 'failed'; error: string }
      | { outcome: 'requires_approval'; approvalId: string }
      | { outcome: 'synced'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; platformAudienceId: string; uploaded: number }
    >;
    /** The tenant's dispatch-ledger rows (C2 sync + B5 checklist) — ids/names only. */
    listDispatches?(): Promise<Array<{
      platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; platformCampaignId: string; platformAdSetId: string; platformAdId: string;
      briefId?: string; campaignName?: string; dailyBudgetMinor?: number; adAccountId?: string; createdAt: string;
    }>>;
    getMetrics?(args: { platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; adAccountId: string; campaignId: string; window?: 'lifetime' | 'yesterday' }): Promise<
      | { outcome: 'no_connection' }
      | { outcome: 'unsupported'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin' }
      | { outcome: 'failed'; error: string }
      | { outcome: 'ok'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; metrics: { impressions: number; clicks: number; spend: number; ctr: number; cpc: number } }
    >;
    /** Set a campaign's daily budget (ADR 0186 slice 4b) — the one live-spend
     *  mutation. `dryRun` returns a preview WITHOUT calling the platform. Idempotent,
     *  never unpauses; graceful `no_connection`; `unsupported` (tiktok/linkedin today). */
    updateBudget?(args: { platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; adAccountId: string; campaignId: string; dailyBudgetMinor: number; dryRun?: boolean }): Promise<
      | { outcome: 'no_connection' }
      | { outcome: 'unsupported'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin' }
      | { outcome: 'failed'; error: string }
      | { outcome: 'requires_approval'; approvalId: string }
      | { outcome: 'preview'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; dailyBudgetMinor: number; target: string }
      | { outcome: 'updated'; platform: 'meta' | 'google' | 'tiktok' | 'linkedin'; dailyBudgetMinor: number; target: string }
    >;
  };
  /** ctx.email — email egress for `core.openwop.integration.email-send`
   *  (ADR 0024 §4 Phase 3). Resolves the acting human's email-provider Connection
   *  (api_key) for the node's `provider` and sends via its REST API. No connection
   *  ⇒ graceful `{ sent:false }`, never a throw. Inline to avoid an import cycle. */
  email?: {
    send(args: {
      from: string;
      to: string | string[];
      cc?: string | string[];
      bcc?: string | string[];
      subject: string;
      text?: string;
      html?: string;
      replyTo?: string;
      provider?: string;
      fallbackOnFailure?: boolean;
      idempotencyKey?: string;
    }): Promise<{ sent: boolean; messageId?: string; provider: string; error?: string }>;
  };
  /** ctx.messaging — host messaging surface. `sendSms` (ADR 0024 §4 Phase 3)
   *  resolves the acting human's SMS-provider Connection (v1: Twilio, basic auth)
   *  for `core.openwop.integration.sms-send`. (`dispatchEgressEnvelope` for the
   *  chat node stays unimplemented — its own surface.) No connection ⇒ graceful
   *  `{ sent:false }`, never a throw. */
  messaging?: {
    sendSms(args: { provider?: string; to: string; from: string; text: string; idempotencyKey?: string }): Promise<{ sent: boolean; sid?: string; provider: string; error?: string }>;
  };
  /** ctx.notification — push egress for `core.openwop.integration.notification-push`
   *  (ADR 0024 §4 Phase 3). Resolves the acting human's push-provider Connection
   *  (v1: Expo) for the node's `provider`. No connection ⇒ graceful `{ sent:false }`. */
  notification?: {
    push(args: { provider?: string; deviceToken: string; title: string; body: string; data?: Record<string, unknown>; idempotencyKey?: string }): Promise<{ sent: boolean; id?: string; provider: string; error?: string }>;
  };
  /** ctx.connectors — the ADR 0037 connector invoker, exposed to nodes (ADR 0076).
   *  `invoke(connectorId, request)` performs an audited, token-injected, eTLD+1-pinned
   *  egress call through the SAME broker the integration adapters use: the credential
   *  is resolved as the run's acting human, the destination is pinned to the provider's
   *  curated `apiHosts`, and a successful call stamps RFC 0079 provenance. Fails CLOSED
   *  (`connector_no_connection` / `connector_host_not_allowed` / …), never a silent
   *  no-op. Inline type to avoid an import cycle (the adapter pulls in the broker). */
  connectors?: {
    invoke(connectorId: string, request: {
      url: string;
      method?: string;
      body?: string;
      contentType?: string;
      authScheme?: 'bearer' | 'basic';
      /** Static, non-secret headers a provider protocol requires (e.g. NetSuite
       *  SuiteQL's `Prefer: transient`). The broker strips any `authorization` /
       *  `content-type` variant, so a node can't override the credential. */
      extraHeaders?: Record<string, string>;
    }): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }>;
    /** Resolve the acting human's connected provider for a capability CATEGORY
     *  ("email-calendar" / "hr" / …) — the Phase-2 binding (ADR 0186). Returns the
     *  provider id for `invoke`, or `null` when no authorized connection of that
     *  category exists, so a capability node degrades instead of hard-coding a vendor.
     *  Optional so a node tolerates an older host that exposes only `invoke`. */
    resolveForCapability?(capability: string): Promise<string | null>;
    /** All authorized providers for a category (precedence-ordered) — a node that
     *  supports a subset of a coarse category picks one it can serve (ADR 0186). */
    resolveAllForCapability?(capability: string): Promise<string[]>;
  };
  /** ctx.variables — run-scoped mutable variable bag (get/set), backed by the
   *  variables runtime. Used by launch-studio to thread step context. */
  variables?: { get(name: string): unknown; set(name: string, value: unknown): void };
  /** ctx.mcp — host-side MCP. `expose` (RFC 0020) registers the host AS a server;
   *  `invokeTool`/`readResource`/`listTools`/`serverStatus` (ADR 0030) are the
   *  OUTBOUND client — `serverId` is a `reach:'mcp'` Connections provider, called
   *  with the acting human's per-user token (ADR 0024), governance-gated (ADR
   *  0028); tool/resource output is `untrustedContent` (ADR 0027). */
  mcp?: {
    expose: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    invokeTool?(serverId: string, toolName: string, args: unknown, opts?: { timeoutMs?: number }): Promise<{ result: unknown; isError: boolean; untrustedContent: true }>;
    readResource?(serverId: string, uri: string, opts?: { timeoutMs?: number }): Promise<{ content: unknown; mimeType: string; untrustedContent: true }>;
    listTools?(serverId: string): Promise<{ tools: unknown[] }>;
    serverStatus?(serverId: string, opts?: { timeoutMs?: number }): Promise<{ available: boolean; name?: string; version?: string }>;
    /** ADR 0030 Phase 2b — bounded in-band change detection: poll the resource for
     *  a window, firing `onEvent` (untrusted content) on each detected change. No
     *  persistent connection / daemon; the node blocks for the window. */
    subscribeResource?(
      spec: { serverId: string; uri: string },
      onEvent: (event: { uri: string; content: unknown; mimeType: string; untrustedContent: true }) => void | Promise<void>,
      opts?: { durationMs?: number; pollIntervalMs?: number; maxEvents?: number },
    ): Promise<void>;
  };
  /** ctx.respondToWebhook — the `core.openwop.triggers` webhook-respond node's
   *  reply channel. The host durably records the intended HTTP reply; absent
   *  on hosts where the pack should fall back to surfacing it as node outputs. */
  respondToWebhook?(response: { status?: number; headers?: Record<string, string>; body?: unknown }): Promise<void>;
}

/** Loose-typed surface map. The concrete shape lives in
 *  `host/inMemorySurfaces.ts`; this signature only constrains that
 *  every method is async + returns a record. Tightening this would
 *  require importing the concrete `KvSurface | TableSurface | …`
 *  union here, but those types belong to the host layer, not the
 *  executor — so we use a structural shape that matches the pack
 *  delegate's call site. */
type HostSurfaceMethod = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type HostSurfaceCollection = { readonly [method: string]: HostSurfaceMethod };

export interface HostStorageSurfaces {
  kv?: HostSurfaceCollection;
  table?: HostSurfaceCollection;
  cache?: HostSurfaceCollection;
  blob?: HostSurfaceCollection;
  queue?: HostSurfaceCollection;
}
export interface HostDbSurfaces {
  sql?: HostSurfaceCollection;
  nosql?: HostSurfaceCollection;
  search?: HostSurfaceCollection;
  vector?: HostSurfaceCollection;
}
export type HostFsSurface = HostSurfaceCollection & {
  image?: HostSurfaceCollection;
  pdf?: HostSurfaceCollection;
  archive?: HostSurfaceCollection;
  ftp?: HostSurfaceCollection;
  sftp?: HostSurfaceCollection;
  ssh?: HostSurfaceCollection;
};
export type HostQueueBusSurface = HostSurfaceCollection;
export type HostObservabilitySurface = HostSurfaceCollection;

export type NodeOutcome =
  | { status: 'success'; outputs: unknown }
  | { status: 'failure'; error: { code: string; message: string }; retryable?: boolean }
  | {
      status: 'suspended';
      interrupt: {
        kind: 'approval' | 'clarification' | 'refinement' | 'cancellation' | 'external-event' | 'conversation' | 'timer' | 'tour-step' | 'walkthrough-step' | 'credential';
        data: unknown;
        resumeSchema?: Record<string, unknown>;
      };
    };

export interface NodeModule {
  typeId: string;
  version: string;
  /** Capability requirements — checked against runtimeCapabilities at register time. */
  requires?: readonly string[];
  /** Secret requirements — node manifest declares these; resolver fetches at execute time. */
  requiresSecrets?: readonly { id: string; provider: string; scope: string }[];
  /** ADR 0341 — marks a node whose execution IS an external side effect
   *  (send/write/call-out). During a replay-mode fork the executor reproduces
   *  the source run's recorded outcome instead of executing it live. Host/
   *  pack-author-owned (never workflow-author config); the executor's
   *  pattern list covers the core families when this flag is absent. */
  sideEffecting?: boolean;
  /** RFC 0031 §B. Model capabilities this NodeModule requires the active
   *  model to advertise. Distinct from `requires`, which gates on HOST
   *  capabilities — this field gates on MODEL capabilities. Spec-reserved
   *  identifiers: `structured-output`, `discriminator-enum`, `long-context`,
   *  `reasoning` (model-native thinking-tokens), `function-calling`.
   *  Host-private extensions MUST prefix with `x-host-<host>-<key>`.
   *  Empty array (or absent field) means no model-capability requirements. */
  requiredModelCapabilities?: readonly string[];
  /** RFC 0031 §B. Substitute model coordinates the host MAY use if the
   *  active model lacks the declared `requiredModelCapabilities`. When
   *  the host advertises `capabilities.modelCapabilities.substitutionSupported: true`
   *  AND can authenticate to `fallbackModel.provider`, the host substitutes
   *  and emits `model.capability.substituted`. When `substitutionSupported`
   *  is false (the reference host's current posture) OR the field is
   *  absent, the host refuses on any unmet capability. Recursive substitution
   *  is NOT permitted (RFC 0031 §"Unresolved questions" #3). */
  fallbackModel?: { provider: string; model: string };
  /** ADR 0555 P1 — pack provenance + isolation eligibility, stamped by
   *  `packs/tarballLoader.ts` at registration. ABSENT on host built-in modules,
   *  and that absence is load-bearing: it is what tells the executor this is
   *  the host's own code and never a candidate for the isolated-worker
   *  contract. */
  packOrigin?: PackNodeOrigin;
  execute(ctx: NodeContext): Promise<NodeOutcome>;
}

/** DAG edge between two nodes. Mirrors `WorkflowEdge` in
 *  `spec/v1/workflow-definition.schema.json`. */
export interface EdgeDef {
  edgeId: string;
  sourceNodeId: string;
  /** Source output port. Defaults to `'output'`. */
  sourceOutput?: string;
  targetNodeId: string;
  /** Target input port. Defaults to `'input'`. */
  targetInput?: string;
  /** Fan-in semantics for the target. Defaults to `'all_success'`. */
  triggerRule?: 'all_success' | 'any_success' | 'all_complete' | 'none_failed' | 'any_failed';
  /** Optional condition predicate evaluated against the source's output.
   *  When false, this edge contributes no input to the target (but
   *  triggerRule may still fire the target via other edges). */
  condition?: {
    path: string;
    op: 'eq' | 'neq' | 'truthy' | 'falsy' | 'exists' | 'contains';
    value?: unknown;
  };
  label?: string;
}

/** Workflow definition — stored either in the workflows table or in-memory.
 *  Accepts both the legacy linear shape (nodes only) and the spec-canonical
 *  DAG shape (nodes + edges). The executor delegates to the DAG scheduler
 *  whenever `edges` is non-empty; pure-linear runs are a degenerate case of
 *  the same scheduler with a chain of single-edge connections. */
export interface WorkflowDefinition {
  workflowId: string;
  nodes: ReadonlyArray<{
    nodeId: string;
    typeId: string;
    config?: Record<string, unknown>;
    /** Per-port input declarations from the fixture's `inputs:` block.
     *  Each entry is either:
     *   - a literal value (passed through unchanged), OR
     *   - a reference shape `{type: 'variable', variableName: string}`
     *     that the executor resolves against the run's variable bag
     *     before invoking the node (per `host/variablesRuntime.ts`).
     *  Future shapes (`{type: 'literal', value}`, `{type: 'config'}`,
     *  etc.) can be added without breaking the resolution interface. */
    inputs?: Record<string, unknown>;
    /** RFC 0065 — author hint that this terminal node's output is the
     *  workflow's canonical-deliverable artifact. Advisory; executor
     *  ignores the value. Forwarded round-trip so consuming tools
     *  (chat-surface completion cards, run-detail page, third-party
     *  hosts) can pick a primary output deterministically. */
    outputRole?: 'primary' | 'secondary';
    /** Multi-Agent Shift Phase 1 (`agent-ref.schema.json`). Optional
     *  authoring-time pin of which agent executes this node. Surfaced on
     *  `NodeContext.nodeAgent` so node modules (e.g. the conformance mock
     *  agent) can resolve the pinned `agentId`; the engine MAY override it
     *  at runtime via dispatch/orchestrator per the schema description.
     *  Also projected onto `RunSnapshot.agent` (the active-worker rotation
     *  per run-snapshot.schema.json) via `host/runAgentRuntime.ts`. */
    agent?: AgentRef;
    /** RFC 0151 §B — the node's inverse action (ADR 0554 P2). CLOSED and
     *  optional, mirroring `workflow-definition.schema.json`
     *  `WorkflowNode.compensation` field-for-field; nothing host-private may be
     *  added here, because a chain-pack node carrying an extra key would be
     *  rejected by the wire schema.
     *
     *  Its presence is the AUTHOR'S DECLARATION that this node's effect can be
     *  undone — P0 finding 3's requirement, since two of this host's senders
     *  (`network-egress` via webhook and via the broker) have a compensability
     *  the host cannot know. A node without this block owes nothing, and the
     *  host never infers otherwise. */
    compensation?: {
      nodeTypeId: string;
      inputMapping?: Record<string, unknown>;
      retry?: { maxAttempts?: number; backoffMs?: number };
      requiresApproval?: boolean;
      /** RFC 0151 §B (S36) — gates ABANDONING this inverse (§E `skip` /
       *  `terminate as uncompensated`) behind the same approval surface. Its
       *  DEFAULT is the EFFECTIVE `requiresApproval`, not `false`; resolve it
       *  through `compensationUnwind.effectiveWaiveRequiresApproval`, never by
       *  reading this field raw. Does NOT apply to `substitute`. */
      waiveRequiresApproval?: boolean;
    };
    /** RFC 0151 §B UQ4 (resolved 2026-08-16), reachable from a chain via
     *  RFC 0157 — the author states that this node's committed effect HAS NO
     *  INVERSE. OPTIONAL; absent or `false` means nothing (an undeclared
     *  compensator is still not implied, so this is NOT the negation of
     *  `compensation`). MUTUALLY EXCLUSIVE with `compensation`: a node
     *  declaring both is contradictory and is refused at registration
     *  (`validation_error`) and at chain expansion
     *  (`chain_irreversible_with_compensation`).
     *
     *  Carried so the statement survives into the registered definition. The
     *  §D consequence — a plan entry recorded `irreversible` so the rollup
     *  caps at `partial` — is RFC 0151 UQ4 unwind work that rides
     *  `compensationLedger`/`compensationUnwind`, NOT this carry. */
    irreversibleEffect?: boolean;
  }>;
  /** DAG edges. When absent or empty, the executor builds an implicit linear
   *  chain from `nodes` (back-compat path for callers that pre-date the
   *  scheduler). */
  edges?: ReadonlyArray<EdgeDef>;
  /** Input schema (informational only in this sample; real hosts validate via Ajv). */
  inputSchema?: Record<string, unknown>;
  configurableSchema?: Record<string, unknown>;
  /** Variable declarations — per `spec/v1/workflow-definition.schema.json
   *  §variables`. The runtime seeds a per-run variable bag from these
   *  defaults at run-create time (`POST /v1/runs.inputs[name]` overrides
   *  `defaultValue` per `host/variablesRuntime.ts`). Read back via
   *  `RunSnapshot.variables` on `GET /v1/runs/{runId}`. */
  variables?: ReadonlyArray<{
    name: string;
    type?: string;
    description?: string;
    required?: boolean;
    defaultValue?: unknown;
    /** RFC 0124 §Security — secret-class marking (from a chain parameter's
     *  `x-openwop-sensitive` hint). A `sensitive` variable MUST NOT carry a
     *  persisted `defaultValue` (SR-1 at-rest), is supplied per run via
     *  `configurable`, and redacts to `[REDACTED:<id>]` in `prompt.composed`. */
    sensitive?: boolean;
    /** RFC 0136 — advisory JSON-Schema `format` hint for a `type: "string"`
     *  variable (`email`, `uri`, `date`, …). PRESENTATIONAL ONLY: hosts SHOULD use
     *  it to pick a run-input affordance but MUST NOT validate against it (a
     *  mismatch never fails a run — requirement 3). Populated in deferred mode from
     *  a chain parameter's `format` (requirement 7); survives `:fork`/replay
     *  verbatim (requirement 5); orthogonal to `sensitive` (requirement 6). */
    format?: string;
  }>;
  /** `WorkflowSettings` (`workflow-definition.schema.json`) — authored,
   *  workflow-level knobs alongside `timeout`/`maxRetries`. Kept as an open map
   *  because the executor honours only the keys it implements; the RFC 0151 §B
   *  `compensation` policy is the one this host reads, and it is REFUSED at
   *  registration (`capability_required`) until the host advertises the family.
   *  Authored, never per-run: the policy schema is explicit that there is no
   *  run-options overlay, because a per-run caller who could drop a trigger
   *  would be authorizing their own unwind. */
  settings?: Record<string, unknown> & {
    compensation?: CompensationPolicy;
  };
  /** Authoring-time workflow metadata (tags, fixture annotations, …).
   *  Pass-through for the executor except for the conformance-relevant
   *  `requiresAgentId` key: when present, the run's dispatch surface
   *  is bound to that manifest agent and the executor enforces the
   *  agent's RFC 0003 §D handoff contract on run inputs before any
   *  node executes (see `executor/handoffGate.ts`). */
  metadata?: Record<string, unknown>;
}
