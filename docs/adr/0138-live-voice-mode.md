# ADR 0138 — Live voice mode (productizing the ADR 0109 real-time-voice arm as a full-duplex chat surface)

**Status:** **implemented** (P1–P3, 2026-06-25) — see the as-built table below.
**Date:** 2026-06-24 (proposed) · 2026-06-25 (implemented)

> **As-built (2026-06-25).** P1–P3 + the architecture-review gap-closure (W1–W7) landed.
>
> | Phase | Shipped | Tests |
> |---|---|---|
> | **P1** — feature-package + live `streamRef` transcription | `features/voice/` (toggle, `VoiceSession` point-get, HTTP-chunked transport buffers) + the CORE `StreamAudioResolver` inversion seam (`aiProviders/streamAudio.ts`) flipping `transcription_unsupported` → real `voice.*` turns; §F tenant-bound + byte-budget + idle-TTL | route-level + buffer unit (green) |
> | **P2** — full-duplex turn loop + §F | `/speak` (streaming TTS-out of the chat's reply, ADR 0106 budget) + `/barge-in` (`voice.barge_in → voice.cancelled`, no partial leak); reply GENERATION stays in the ONE chat | speak/barge-in route tests (green) |
> | **P3** — frontend + per-agent voice | `VoiceModeButton` + `voiceClient`; **per-agent voice** (`agentProfile.configParameters.voice`) in `/speak` + the **`AgentVoicePanel`** Voice picker; **ElevenLabs** `callSpeechSynthesizer` adapter (BYOK) | per-agent-voice e2e (green) |
>
> **Architecture-review gap-closure (W1–W7, post-`/architect`):**
> - **W1** — `/speak` resolves a BYOK `credentialRef` (ElevenLabs/OpenAI/Google now synthesize); AgentVoicePanel key picker. **W2** — the **full-duplex FE loop** (`useVoiceMode`): mic → transcript → the chat's reply, **voiced back**, with **barge-in**; `agentId` threaded so the spoken reply uses the agent's voice. **W3** — one mic (`useAudioRecorder` streaming, no second `MediaRecorder`). **W4** — AgentVoicePanel preserves governance fields. **W5** — advertisement honesty note (value unchanged; pinned by the 0109 witness). **W6** — agent voice authoritative over client overrides. **W7b** — `feature.voice.agents` persona pack.
> - **Remaining (external / un-headless-verifiable):** **W7a** — a real word-level streaming-ASR provider (**chosen: Deepgram Flux** — semantic endpointing) over a persistent WS transport, replacing the utterance-buffered floor and making `turnDetection:'semantic'` real-time; needs a key + a live verify, so not shipped as untested code. **W7c** — i18n of the new UI strings (en+es+fr+**pt-BR**, the locale owner reviews). **W7d** — the live browser pass (mic/playback/barge-in, light+dark). Steward-side: none (rides RFC 0106 `Active`).
**Toggle:** `voice` · default **OFF** · `bucketUnit: tenant` (a shared B2B real-time-voice
surface — every user in a workspace gets the same variant, like ADR 0084 notebooks /
ADR 0086 podcasts / the `voice` toggle ADR 0109's header foresaw).
**Surface:** **rides the ONE chat** (`frontend/react/src/chat/` — `EmbeddedChatPanel` /
`ConversationView` / `ChatInput`, RFC 0005 / ADR 0073); a feature-package
`src/features/voice/` (service + `routes.ts` + `feature.ts`); a host-extension
session-bootstrap route `/v1/host/openwop-app/voice/session/*` (non-normative); and a
**provider-agnostic streaming-STT adapter** behind the existing ADR 0109 `streamRef` seam.
Advertises **`aiProviders.realtimeVoice`** — the surface ADR 0109 already advertises;
this ADR makes the **live `streamRef` path** non-vacuous, not just finite audio.

## Why this exists (and how it differs from ADR 0109)

ADR 0109 shipped the **wire-observable arm** of RFC 0106: the `ctx.callTranscriber` /
`ctx.callSpeechSynthesizer({stream:true})` seams, the `voice.*` run-event taxonomy, the
`streamRef` handle, barge-in, and the honest `aiProviders.realtimeVoice` advertisement —
**and deliberately stopped there**. A live `streamRef` returns an honest
`transcription_unsupported` (`backend/typescript/src/aiProviders/aiProvidersHost.ts:344`),
the mic UX is the existing record-and-send `MediaRecorder` (RFC 0091), and 0109's stated
job was the *conformance/interop contract*, "distinct from the UX." So today the user-facing
experience is **finite record→send dictation with a text reply** — there is no live spoken
conversation.

**ADR 0138 productizes that arm into a usable full-duplex voice experience** — the
deliverable the 0109 plumbing (synthesis-streaming + barge-in) was built to support. It is a
*completion + UX* layer, not a parallel system: it wires a **real streaming-STT path** for a
live `streamRef`, a **live transport** (host-internal per RFC 0106 §E), a **full-duplex
turn loop** (the agent speaks back via the already-wired streaming-TTS arm, with barge-in),
and a **voice affordance on `EmbeddedChatPanel`** scoped to a voice-capable agent pack. Per
the user's product decision (2026-06-24), the target is **full-duplex spoken** (talk ↔ agent
speaks back), with the **ASR provider and live transport deferred to open questions** —
designed provider- and transport-agnostic behind the `streamRef` seam.

**Source PRD:** `docs/research/2026-06-24-real-time-voice-harness.md` — a real-time-voice
architecture survey. Its capability intent is adopted; its from-scratch-harness topology
(self-hosted LLM serving, gRPC mesh, LiveKit/Pipecat orchestrator) is reshaped to this host.
See *Source-PRD reconciliation* below.

**Architecture review (2026-06-24, `/architect`):** hardened pre-implementation — the
`StreamingTranscriber` is pinned to **core `aiProviders/`** (no core→feature dependency, §2 +
matrix row 1); `VoiceSession` is a **point-get, ephemeral, non-authority** record (§1); the
`realtimeVoice` advertisement is **host-capability, derived from a wired provider, not
toggle-gated** (the namespace-split + advertisement notes under Decision); and P1/P2 carry
**route-level + live-path §F tests**. No redesign — these are boundary/honesty clarifications.

## Boundaries & pre-existing-surface audit (Step 3 — proven, not asserted)

| Check | Finding |
|---|---|
| **`voice` toggle collision** | **None.** `grep "id: 'voice'"` over `backend/.../features` + `frontend/.../features` is empty — no feature-package owns it. The id is free (ADR 0109's header *proposed* it but as-built shipped as core plumbing with no toggle). |
| **`features/voice/` package** | **None** (backend or frontend). The 0109 plumbing lives in **core**, not a feature — so 0138 is the first feature-package on this surface (zero-core-edit append to `BACKEND_FEATURES`/`FRONTEND_FEATURES`). |
| **Single owners to compose (never fork)** | STT/TTS adapters + the `transcription_unsupported` code: `aiProviders/aiProvidersHost.ts` (`callTranscriber`/`callSpeechSynthesizer`, `TranscribeRequest`). The wire seams + `/voice/barge-in`: `routes/agents.ts:436–570`. The advertisement: `routes/discovery.ts:503`. The `ctx` surface: `executor/`. The chat UI: `chat/EmbeddedChatPanel.tsx` / `ConversationView.tsx` / `ChatInput.tsx` (the `useAudioRecorder` mic). |
| **The actual gap** | The **live `streamRef` path**. `audio.url` (finite media-asset) already transcribes (0109 P2); `audio.streamRef` on a non-mock call is the honest `transcription_unsupported`. 0138's core backend job is to wire a **real `StreamingTranscriber`** behind that seam. |
| **Capability honesty** | `realtimeVoice` is *already* advertised (`transcription/synthesis: streaming`, `turnDetection: semantic`, `bargeIn: supported`). 0138 makes the **live** path honor it end-to-end — the advertisement gets *more* honest, never a new claim. Under `OPENWOP_REQUIRE_BEHAVIOR=true` the gated RFC 0106 scenarios already pass via finite audio; the live arm is additive. |

## Decision & data model

openwop-app implements a **`voice` feature-package** that turns the live chat into a
full-duplex voice surface by composing — not re-deriving — the ADR 0109 seams.

1. **`VoiceSession`** (host-internal record, `DurableCollection`): `sessionId`,
   `conversationId` (the RFC 0005 conversation it drives), `agentId`, `tenantId`,
   `streamRef` + `readyState` lifecycle, `provider` (resolved from `aiProviders.supported[]`
   + BYOK), `transport`, and the per-session cumulative budget counters (§F TDoS guard,
   ADR 0106). Bootstrapped behind `POST /v1/host/openwop-app/voice/session` (non-normative
   host-extension; tenant derived from the authenticated subject, never the request body).
   **Access is a deterministic point-get by `sessionId`** — the live turn loop is a hot path,
   so reads MUST be `get(sessionId)`, never `DurableCollection.list()` (a full cross-tenant
   scan). **`VoiceSession` is ephemeral, GC-able live-audio transport/budget state keyed to a
   conversation — NOT a second conversation store.** The RFC 0005 conversation remains the
   single owner of turns; `VoiceSession` holds no turn content and is exempt from replay (a
   `:fork` replays the committed `voice.*` turns from the durable log, never re-transcribes).
2. **A provider-agnostic `StreamingTranscriber` adapter that lives in CORE `aiProviders/`**
   (the single owner of provider dispatch — `aiProvidersHost.ts`, alongside the ADR 0085/0086
   STT/TTS adapters), **NOT inside `src/features/voice/`**. The live `streamRef` flips from
   `transcription_unsupported` to a real streaming-STT path for any wired provider; it emits
   the **single canonical `voice.*` taxonomy** (`speech_start` / `transcript(interim)` /
   `endpoint_candidate` / `turn_commit`) on the durable log and **resolves the per-turn
   `Promise` at `turn_commit`** (the C1 shape — no side-channel iterable; `replay.md
   §"Determinism guarantees"`). **Boundary (architect review):** `ctx.callTranscriber` is core;
   were the adapter owned by the `voice` feature, core's live path would only resolve when the
   feature is loaded — a forbidden **core→feature** runtime dependency (`ARCHITECTURE.md
   §"Boundary discipline"`), *and* it would gate a host capability on a product toggle (wrong
   axis). So the adapter is wired through the **BYOK/`aiProviders` binding (ADR 0024)** and
   configured per operator/tenant — **decoupled from the `voice` toggle**. The `voice`
   feature-package owns **only the product surface** (session bootstrap + transport + the
   `EmbeddedChatPanel` mode + the agent pack). The provider follows the **`aiProviders`
   managed-adapter precedent (ADR 0085/0086)**, not the RFC 0095 connection-pack seam.
   Provider choice is an **open question** (below); the adapter interface is the stable seam.
3. **The full-duplex turn loop** (server-side): a committed `turn_commit` transcript enters
   the conversation **exactly as a typed turn would** (RFC 0005 — no special path); the
   agent's reply streams through the already-wired `callSpeechSynthesizer({stream:true})` →
   `voice.synthesis_chunk` metadata-only events (bytes off the log, C2) + client-side
   playback; **user speech during playback** maps to the existing `voice.barge_in →
   voice.cancelled` lifecycle (cancel in-flight synthesis, no partial leak).
4. **The transport is host-internal** (RFC 0106 §E) and lives **behind the `streamRef`
   seam** — WebSocket vs WebRTC is a build-time decision (open question); the
   session-bootstrap contract is designed to allow either without a wire change.

> **Voice HTTP namespace — the core/feature split (architect review).** The
> `/v1/host/openwop-app/voice/*` namespace is owned by **two** registrants, by design and
> without collision (disjoint sub-paths): **core `routes/agents.ts` owns the RFC 0106
> conformance seams** — `/ai/call-transcriber` (`agents.ts:557`) + `/voice/barge-in`
> (`agents.ts:589`) — and the **`voice` feature owns the product bootstrap** `/voice/session/*`.
> The wire/conformance seams stay in core (they back the advertisement + the gated suite); the
> session bootstrap is feature product surface. Do not migrate one into the other.

> **Advertisement is host-capability, not toggle-gated (architect review).** `realtimeVoice`
> is advertised always-on in core (`discovery.ts:503`) and stays **derived from runtime provider
> availability** (the ADR 0085 advertise-in-lockstep discipline) — it reflects what the *host*
> can do, independent of any tenant's `voice` product toggle. Honesty rule for P1: the live
> `transcription: "streaming"` claim must track a *wired* streaming provider, so there is no
> window where the advertisement promises streaming while every live `streamRef` still returns
> `transcription_unsupported`. The `voice` toggle gates the per-tenant **product surface**, not
> the host capability — two different axes.

### Non-functional targets (from the source PRD)

The source research (`docs/research/2026-06-24-real-time-voice-harness.md`) sets the bar that
makes voice mode feel conversational rather than merely functional — adopted here as design
SLOs, not wire requirements:

- **Latency:** ~**500–800 ms** end-of-user-speech → first-assistant-audio on the happy path;
  faster cancel on barge-in. Human turn gaps are ~100–200 ms, so a 1–2 s pause feels rude even
  with a good answer. Start TTS playback on the **first** synthesis chunk; favour TTFT-optimized
  provider settings.
- **Hybrid endpointing, not silence=done.** The PRD's recommended breakpoint policy
  (`speech_start → interim transcript → endpoint_candidate → turn_commit`, with optional
  preemptive generation) **is exactly the RFC 0106 `voice.*` taxonomy** this rides — strong
  external validation. VAD detects *presence*; a **semantic/acoustic turn layer** (or a
  provider that emits it, e.g. Deepgram Flux `utterance_end_ms`) decides *completion*. The
  `voice-interim-not-durable` §F invariant is the PRD's "committed-prefix vs editable-tail"
  transcript model: never inject the live interim into durable context; append stable text at
  `turn_commit` only.
- **Per-session observability spans** (the tuning knobs are useless without them): audio
  ingress → VAD onset → ASR interim → ASR final → `turn_commit` → LLM TTFT → token rate → TTS
  first-byte → playback start → barge-in detect → cancel propagation. The `voice.*` events are
  already the natural trace points; emit the LLM/TTS timings alongside.
- **Fast degradation, not heroic retries:** WebRTC → WebSocket-PCM fallback → text-only; on
  unstable interim ASR, keep listening rather than commit a bad early turn; on TTS stall, show
  the text reply immediately and retry/secondary-voice the speech.

### Reuse, never recreate — the voice surface rides the ONE chat

Per `CLAUDE.md` ("AI chat — reuse, never recreate") and ADR 0109's own decision: **no new
chat panel, no second mic system.** The voice affordance is a **mode on the shared
`EmbeddedChatPanel` / `ConversationView`** (ADR 0073) — a composer-level voice toggle that
opens a `VoiceSession`, streams the live transcript into the same feed, and plays the spoken
reply — scoped to a **voice-capable agent pack** (the ADR 0058 "chat-drivability = agent +
nodes" pattern). The existing `ChatInput` record-and-send mic (RFC 0091) stays as the
finite-audio path; voice mode is the *live* superset, not a fork of it.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | `src/features/voice/` (`voiceService.ts` + `routes.ts` + `feature.ts`), appended to `BACKEND_FEATURES` + `FRONTEND_FEATURES`. **Zero core route/nav edits.** Imports core (`aiProviders`, `executor` ctx, `chat` conversation surface); **core never imports it — incl. the `StreamingTranscriber`, which lives in core `aiProviders/` (Decision §2), so core's `callTranscriber` never depends on the feature being loaded.** The feature owns only the product surface (session bootstrap + transport + UI + agent pack). |
| 2 | **Toggle + admin UI** | `voice`, **default OFF**, `bucketUnit: tenant` (shared B2B surface, ADR 0015). Plain on/off first; `betaCohort`/variants available later. Server-authoritative resolution in `FeatureTogglePanel`. |
| 3 | **Workflow surface (`ctx`, ADR 0014)** | **Already present** — `ctx.callTranscriber` + `ctx.callSpeechSynthesizer({stream:true})` are ADR 0109 ctx methods, gated by the same provider/policy layer and advertised at `/.well-known/openwop`. 0138 adds **no new `ctx.<feature>`**; it makes the live arm of the existing methods real. (Honest per Step 4 row 3: this is a chat-runtime surface, not a new workflow verb.) |
| 4 | **Node pack** | **None.** Voice is `ctx`-method + chat-runtime plumbing, not workflow nodes — the same honest "no node pack" call ADR 0109 made. (A future "transcribe-this-asset" node would extend ADR 0085, not this feature.) |
| 5 | **AI-chat integration + envelopes** | **No new envelope type.** The `turn_commit` transcript enters the conversation as an ordinary user turn (RFC 0005); the session bootstrap is a host-extension REST call, not a chat envelope. |
| 6 | **Agent pack** | `feature.voice.agents` — **one** voice persona: a turn-taking, brevity-tuned agent profile (short spoken-first replies, explicit confirmations) driving the voice session via ADR 0058. Honestly the *only* AI-pack surface here. |
| 7 | **Public surface** | **None.** Voice mode is authenticated-only; the `streamRef` is tenant+session-bound (§F). No `PUBLIC_PATH_PREFIXES` entry. |
| 8 | **RBAC + isolation (ADR 0006)** | Every route toggle- + scope-gated; session open = `workspace:write`; `VoiceSession` tenant+conversation IDOR-guarded; **fail-closed**. The continuous mic is a privileged ingress — bounded by the §F budget below. |
| 9 | **Replay / fork safety** | The `voice` variant, if it influences a run, stamps `run.metadata.featureVariant` at creation, read verbatim on `:fork` (ADR 0001 discipline). The `voice.*` events are the **single durable record** (C1) — no side-channel iterable — so `:fork` against a checkpoint replays deterministically. Packs decoupled from toggle state. |
| 10 | **Frontend** | `voiceClient.ts` + a voice-mode affordance composed into `EmbeddedChatPanel`/`ConversationView` (composer toggle + live-transcript bubble + playback/barge-in mic) + `routes.tsx` registration (no standalone page — it lives *in* the chat). `ui/` cohesion + a11y (visible focus, reduced-motion, an accessible "listening/speaking" status with `aria-live`) + tokens (`/ux-review`, `DESIGN.md`). |

## Security — the four RFC 0106 §F invariants, now on a REAL continuous ingress

ADR 0109 demonstrated these on the *seam*; 0138 must enforce them on a **live, continuous,
untrusted** mic stream:

- **`voice-interim-not-durable`** — non-final (`isFinal:false`) transcript MUST NOT persist
  to memory/KB/replay nor drive a side-effecting tool until `turn_commit` (ADR 0084 guard).
- **`voice-transcript-untrusted`** — every emission (interim + final) carries
  `contentTrust:'untrusted'` + the UNTRUSTED marker (RFC 0091 / ADR 0085 boundary).
- **`voice-bargein-no-partial-leak`** — barge-in cancellation emits no partial tool/model
  output; in-flight side effects roll back or fully complete. **Adaptive, not naive** (PRD):
  classify overlapping speech into **true barge-in** (immediate cancel), **backchannel**
  ("uh-huh"/"okay" → keep playing), and **false interruption** (resume from an audio/text
  cursor) rather than stopping on any sound — a P2 quality knob over the `voice.barge_in →
  voice.cancelled` lifecycle.
- **`voice-streamref-tenant-bound`** — a `streamRef` is bound to one tenant+session, with a
  **max-duration / max-uncommitted-audio / cumulative-event-log budget** (TDoS guard) reusing
  the **ADR 0106 media cost-governance** accounting; past budget, fail-closed
  (`media_budget_exceeded`) and finalize the stream to a tenant-scoped media asset (ADR 0007).

## Phased plan (no code in this ADR)

- **P1 — feature-package + live `streamRef` transcription.** `src/features/voice/` + the
  `voice` toggle + the `VoiceSession` bootstrap route; a provider-agnostic
  `StreamingTranscriber` interface **in core `aiProviders/`** with **one** reference provider
  behind BYOK (provider TBD — open question), wiring a live `streamRef` to real streaming STT.
  Flips `transcription_unsupported` → real `voice.*` turns for the wired provider; the gated RFC
  0106 `voice-transcription-streaming` / `voice-streamref-tenant-bound` scenarios now pass on
  the **live** path, not just finite audio. **Tests:** a `createApp`+cookie-jar **route-level**
  test for the bootstrap (authz + `voice`-toggle gate + tenant binding / IDOR) — these are only
  observable at the HTTP boundary, not in a service-only test.
- **P2 — full-duplex turn loop + §F hardening.** `turn_commit` → conversation turn →
  streaming-TTS spoken reply → barge-in cancel; enforce the four §F invariants on continuous
  ingress + the per-session budget (ADR 0106). The agent now *speaks back*. **Tests:** exercise
  the §F invariants on the **live** path — `voice-interim-not-durable` on a continuous stream,
  `voice-bargein-no-partial-leak` mid-playback, `voice-streamref-tenant-bound` budget exhaustion
  (fail-closed `media_budget_exceeded`) — not just the ADR 0109 finite-audio seam tests.
- **P3 — frontend voice mode + per-agent voice.** The `EmbeddedChatPanel`/`ConversationView`
  voice affordance (composer toggle, live-transcript bubble, playback + barge-in mic, `aria-live`
  listening/speaking status) + the `feature.voice.agents` voice persona (ADR 0058). This is
  the user-facing "talk to it" experience. **Per-agent voice (2026-06-25, user ask):** the
  agent's spoken voice is configured in the **`agentProfile`** (the existing ADR 0031 agent-config
  seam — `AgentProfile.configParameters.voice = { provider, voiceId }`, set via
  `/v1/host/openwop-app/agents/:id/profile` and surfaced as a **Voice picker in the agent
  settings/workspace UI**), NOT a new per-agent voice store (which would be a parallel system).
  When a voice session is scoped to an agent, the streaming-TTS reply resolves that agent's
  `voiceId`; absent one, the host default voice. **`ElevenLabs` is wired as a new
  `callSpeechSynthesizer` provider adapter** (managed + BYOK), alongside ADR 0086's
  MiniMax/OpenAI/Google — the `aiProviders` managed-adapter precedent (finding #6), no new seam.
- **Core-app extension surface / `/.well-known`.** **No advertisement shape change** —
  `realtimeVoice` is already advertised (`discovery.ts:503`); P1–P2 make it non-vacuous for the
  live path, and the live `transcription: "streaming"` claim stays **derived from a wired
  streaming provider** (host-capability, not `voice`-toggle-gated — see the advertisement note
  above). **No node pack** (row 4); **one agent pack** (row 6); **no new envelope** (row 5);
  `ctx.callTranscriber`/`callSpeechSynthesizer` unchanged (row 3).

## RFC gate (Step 5)

**Rides RFC 0106 (`Active`) — no new RFC.** The wire (`callTranscriber` shape, the `voice.*`
taxonomy, `streamRef`, the `realtimeVoice` advertisement) is already locked and consumed by
ADR 0109. The **live transport is explicitly host-internal per RFC 0106 §E** — WebSocket /
WebRTC never touch the wire — so the `/v1/host/openwop-app/voice/session/*` bootstrap routes
are non-normative host-extensions (`CLAUDE.md` host-extension rule). Making `streamRef` truly
supported strengthens the existing honest advertisement; it adds no normative surface.

> **One conditional trigger:** if productization surfaces a need for a **wire-visible**
> session field (e.g. a normative session-handshake or a new `voice.*` event the gated suite
> must assert), that is a **`safety-fix`/additive RFC 0106 amendment** with the steward
> (the openwop crosstalk `0106` channel), authored via `/prd` — **not** a unilateral host
> divergence. The design goal is to keep everything behind §E so this never fires.

## Alternatives considered

1. **A bespoke "push-to-talk" voice panel.** Rejected — violates `CLAUDE.md` "reuse, never
   recreate" (the AiAuthorPanel precedent); fragments capabilities. Voice mode is the RFC 0005
   conversation with a live audio adapter, on `EmbeddedChatPanel`.
2. **Leave voice as finite record-and-send (status quo).** Rejected — it strands the ADR 0109
   synthesis-streaming + barge-in plumbing as never-exercised-on-the-live-path and never
   delivers the full-duplex experience the user invested in.
3. **Pick the ASR provider + transport now.** Deferred per the user's 2026-06-24 decision
   ("decide later" / "decide at build"); the `StreamingTranscriber` interface + the
   transport-behind-`streamRef` seam make both swappable without reshaping the feature.
4. **Build voice as core plumbing (no toggle), like ADR 0109.** Rejected — 0109's plumbing is
   correctly core (a wire contract), but a **user-facing product surface** with a UI, an
   agent persona, and a continuous-ingress cost/abuse profile belongs behind a `tenant` toggle
   (default OFF) so operators opt in — the ADR 0084/0086 precedent.

## Source-PRD reconciliation (real-time-voice research, 2026-06-24)

Source: `docs/research/2026-06-24-real-time-voice-harness.md`. Per the `/feature-refinement`
Scope Rule, the PRD is the design *input* and this app's architecture is the design *law* —
its capability intent is adopted; its from-scratch-harness topology is reshaped to our host.

**Adopted wholesale (the PRD validates the ADR 0109 wire we ride):**
- The **chained voice pipeline** (capture → streaming STT → LLM → streaming TTS → incremental
  playback + continuous barge-in listening) is exactly the full-duplex turn loop above.
- The **hybrid endpointing breakpoint policy** maps 1:1 onto the RFC 0106 `voice.*` taxonomy;
  the **committed-prefix / editable-tail** transcript model is our `voice-interim-not-durable`
  §F invariant; **clause-boundary TTS chunking** is our C2 requirement. (See *Non-functional
  targets*.) That a generic survey independently lands on this exact shape is strong evidence
  the wire we're consuming is right.
- The **latency SLO (500–800 ms)**, **three-state barge-in**, **per-session trace spans**, and
  **fast-degradation** posture — all folded into the design above.
- **Hybrid managed-first sourcing** ("buy STT/TTS first, internalize later") — our default:
  managed/BYOK providers via ADR 0024 (TTS already wired in ADR 0086).

**Reshaped to our architecture (where the PRD's from-scratch topology fights the host):**
- **The LLM-serving tier (vLLM / TensorRT-LLM / `llama.cpp` / PagedAttention / disaggregated
  prefill-decode / GPU scheduling) is OUT OF SCOPE.** openwop-app does not *operate* a model
  server — it routes the LLM through the existing `aiProviders` binding (managed / BYOK / and,
  for an operator-run OpenAI-compatible endpoint like vLLM, the **self-hosted-compat provider,
  ADR 0121 / RFC 0108**). So vLLM/TensorRT are an **operator's deployment choice behind the
  provider binding**, not something this feature builds. The PRD's largest section is, for us,
  someone else's concern.
- **No gRPC service mesh / separate ASR-orchestration-LLM-TTS microservices.** The PRD's
  "WebRTC at edge, gRPC inside" topology is for a green-field harness. Our "session manager"
  that owns transcript stabilization, context trimming, tool execution, cancellation, TTS
  chunking, and barge-in state **already exists** — it's the chat runtime (`runChatToolLoop` +
  the RFC 0005 conversation + the executor) plus the `VoiceSession` record. We compose it; we
  do not stand up a parallel mesh.
- **LiveKit / Pipecat are not adopted as the orchestrator.** Orchestration is the existing ONE
  chat (no second agent runtime, `CLAUDE.md`). At most, a WebRTC stack (e.g. LiveKit's) is a
  candidate **host-internal transport** *behind* the `streamRef` seam (open question), never the
  turn/tool/agent brain.
- **Transport reshaped from a top-level build item to a host-internal detail** behind the
  `streamRef` seam (RFC 0106 §E) — the PRD recommends **WebRTC** for browser live audio
  (browser-native, backpressure), which informs but does not decide our deferred open question.
- **Not always-on like ADR 0109** — a user-facing product surface with a continuous-ingress
  cost/abuse profile belongs behind a `tenant` toggle (default OFF), per matrix row 2.

**Conversation-plan corrections (carried forward):** step 3 "add a mic affordance" → a *mode on
the existing `EmbeddedChatPanel`/`ChatInput`*, not a new mic/panel (no second chat).

## Open questions

1. **Streaming ASR provider** (deferred per user). PRD menu: **Deepgram Flux/Nova-3** (purpose-
   built conversational STT — endpointing + `utterance_end_ms` + speech-start events), **Google
   Cloud STT**, **Azure Speech**, **Amazon Transcribe** (strong tail-stabilization), or
   self-hosted **`faster-whisper`+Silero** (note: raw Whisper is non-streaming, Whisper-Streaming
   ~3.3 s latency — fine for a prototype, not premium). The `StreamingTranscriber` interface must
   expose interim results, timestamps, and an endpoint signal regardless of provider. Pick the P1
   reference at build; a BYOK/cost/latency call.
2. **Live transport** (deferred per user): host-extension WebSocket vs **WebRTC** (PRD-preferred
   for browser live audio) — host-internal (§E). Design the session-bootstrap to allow either,
   with the **WebRTC → WebSocket-PCM → text** degradation ladder; decide at P1/P2.
3. **Turn-detection tuning** — semantic-endpointing thresholds, preemptive-generation timing,
   and the three-state barge-in classifier (true / backchannel / false) — a P2 UX-quality knob,
   not a wire concern.
4. **Default voice persona + voices/languages** — the shipped `feature.voice.agents` profile's
   turn-taking defaults (brevity, confirmation style) + which voices/languages ship first.
   **Resolved (2026-06-25):** the **per-agent voice is `agentProfile.configParameters.voice =
   { provider, voiceId }`** (set in agent settings, P3), and **ElevenLabs ships as a
   `callSpeechSynthesizer` adapter** (managed + BYOK) alongside ADR 0086's providers. Remaining:
   the default host voice + the curated voice-catalog the picker offers.
5. **Transcript durability/compliance** — *answered by the wire we ride:* the `voice.*` events
   are the single durable record, committed at `turn_commit` (interim never persists, §F). The
   open part is whether voice turns need extra compliance scoping beyond the existing
   conversation/run retention.
6. **Telephony / multi-party voice** (RFC 0101 cross-cut) — **explicitly out of scope** for
   this ADR, as for 0109.
