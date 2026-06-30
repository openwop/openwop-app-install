# ADR 0109 — Real-time voice session (the RFC 0106 reference-host arm, riding the existing chat)

> **Renumbered 0108 → 0109 (2026-06-23):** a parallel session merged a different **ADR 0108**
> (`0108-media-to-text-llm.md` — whole-clip *media→text for RAG via the managed provider*, #685/#687)
> to `main` while this was in review. **Distinct surface:** that ADR is **whole-clip** transcription/OCR
> for KB ingest (extends ADR 0085); **this** ADR is **streaming, real-time** voice on the chat (RFC 0106).
> No functional overlap — only the number collided.

**Status:** **implemented** (the wire-observable host arm, P1–P4 — 2026-06-23). The full
`aiProviders.realtimeVoice` surface (transcription + synthesis streaming + semantic turnDetection +
bargeIn) is advertised and every `voice.*` event type is exercised non-vacuously: P1 stub +
P2 real transcription (#689) · P3 streaming synthesis (#691) · P4 barge-in lifecycle (#693). P5
(mic UX) is **already satisfied** by the existing `chat/ChatInput.tsx` MediaRecorder mic — see the
phased plan. Remaining = the steward-side Accept close-out (gated conformance + SDK types + §F
invariant graduation + npm publish), which drives RFC 0106 `Active → Accepted`. _(Originally
`Proposed` / planning-only; the G7 commitment was honored.)_
**Date:** 2026-06-23
**Toggle:** `voice` · default **OFF** · `bucketUnit: tenant` (a shared B2B real-time-voice
surface — every user in a workspace gets the same variant, like ADR 0084 notebooks / ADR 0086
podcasts).
**Surface:** host-extension `/v1/host/openwop-app/voice/*` (non-normative session bootstrap) +
`ctx.callTranscriber` (RFC 0106 §B) + the streaming arm of `ctx.callSpeechSynthesizer`
(RFC 0106 §C) + the `voice.*` run-event taxonomy (RFC 0106 §D) + a new `streamRef` live-handle
(RFC 0106 §B.1). Advertises `aiProviders.realtimeVoice` at `/.well-known/openwop`.

**Depends on / composes:**
- **RFC 0106** *Real-time voice session profile* — **Status: `Active`** (merged `15bc769f` /
  openwop #744), with the **steward §B/§C amendment merged** (`6f25a50e` / **openwop #745**, 2026-06-23):
  `callTranscriber` flips from a returned `AsyncIterable` to **`Promise<{ finalText, atMs, language? }>`
  resolving at `turn_commit`**, with the `voice.*` run-events as the single canonical taxonomy — adopting
  the openwop-app architect finding (replay-determinism: a node-facing `ctx` iterable is a side-channel
  off the durable log; grounded in `replay.md §"Determinism guarantees"` + the `callAI(stream:true)`
  emit-to-log idiom). §C streaming synthesis corrected the same way: `callSpeechSynthesizer({…, stream:true})`
  → `Promise` at completion, `voice.synthesis_chunk` run-events carrying **metadata only** (the C2/G8
  verdict). `Active` stayed; nothing was on the wire, so no v1.x break. This ADR is the **G7 reference-host
  arm** whose dual-witnessed pass drives `Active → Accepted`, the RFC 0105 / ADR 0086 precedent. Advertising
  `realtimeVoice` while 0106 is `Active` is honest: `Active` locks the shape and the conformance suite gates
  the 0106 scenarios behind the advertisement.
- **ADR 0085** *Audio / video source ingestion* (implemented) — the WHOLE-CLIP transcription
  precedent (`ctx.callAI` audio part, RFC 0091, advertises `input.modalities:[audio]`). This ADR
  is its **streaming** counterpart; the `streamRef → mediaRef` finalize seam (RFC 0106 §B.1) IS
  the ADR 0085 (ingest live audio) → ADR 0007 (durable media asset) flow.
- **ADR 0086** *Multi-speaker podcasts* (implemented) — wires `ctx.callSpeechSynthesizer`
  (`aiProviders.speechSynthesis: supported`). This ADR adds the **streaming arm** (`stream:true`).
- **ADR 0007** *Media Library* — stores synthesized audio + finalized stream captures as
  tenant-scoped media assets (the RFC 0055 `media-asset-url-tenant-scoped` discipline).
- **RFC 0005 / the ONE chat** (`frontend/react/src/chat/`) — the voice session **rides the
  existing conversation primitive**; see "Reuse, never recreate" below. NO new chat panel.
- **ADR 0024** *Connections / BYOK* — the credential for the streaming-ASR + streaming-TTS
  providers, resolved host-side through the existing provider/policy layer.
- **ADR 0106** *Media-generation cost governance* — the per-org transcription/TTS budget guard
  extends to the streaming path (metered the same way).

---

## Context

RFC 0106 reached `Active`, locking the wire for live full-duplex voice. The only gap to
`Accepted` is **G7**: a reference host advertising `aiProviders.realtimeVoice` and passing the
gated conformance scenarios non-vacuously, dual-witnessed (openwop-app arm + a non-steward
witness vs a pinned suite). openwop-app is the named candidate and **commits here**: the seams
already exist (ADR 0085 audio-in, ADR 0086 TTS-out, the RFC 0005 chat, the `ctx.emit`/RFC 0002
run-event surface), so the voice session is an *extension* of live surfaces, not a new system.

## Decision

openwop-app implements the RFC 0106 reference-host arm as a feature-package `src/features/voice/`,
gated by a `voice` toggle, that:

1. **Wires `ctx.callTranscriber`** (RFC 0106 §B, post-amendment) over a streaming ASR (Deepgram /
   Azure / faster-whisper, host-routed via the existing `aiProviders.supported[]`) through BYOK +
   policy. Returns a **`Promise` that resolves at `turn_commit`** with the settled final transcript;
   the interim / `speech_start` / `endpoint_candidate` / `turn_commit` parts are emitted as `voice.*`
   run-events (item 3) — one call = one turn, symmetric with `callSpeechSynthesizer`.
2. **Adds the streaming synthesis arm** to the existing `callSpeechSynthesizer` adapter
   (`stream:true` → ordered audio chunks), advertised via `realtimeVoice.synthesis: "streaming"`.
3. **Emits the `voice.*` run-event taxonomy** (`speech_start`, `transcript`, `endpoint_candidate`,
   `turn_commit`, `barge_in`, `cancelled`) on the existing run-event stream via `ctx.emit`.
4. **Mints `streamRef`** live handles for the mic source, with the `readyState` lifecycle and the
   `streamRef → mediaRef` finalize seam reusing ADR 0085 → ADR 0007.
5. **Advertises `aiProviders.realtimeVoice`** (`transcription:"streaming"`, `turnDetection`,
   `bargeIn`, `synthesis:"streaming"`) at `/.well-known/openwop`, derived from what is actually
   wired (the ADR 0085 advertise+accept-in-lockstep discipline) so the claim is never dishonest
   under `OPENWOP_REQUIRE_BEHAVIOR=true`.

### Reuse, never recreate — the voice session rides the ONE chat

Per `CLAUDE.md` ("AI chat — reuse, never recreate"), this ADR does **NOT** build a new "talk to
AI" panel. The voice session is the existing **RFC 0005 conversation** (`chat/`) with an
audio ingress/egress adapter: the mic `streamRef` feeds `callTranscriber`, the committed
`turn_commit` text enters the conversation exactly as a typed turn would, the agent's reply
streams to `callSpeechSynthesizer(stream:true)`, and barge-in maps to the existing interrupt/cancel
path. The UI is a microphone affordance on the shared **`EmbeddedChatPanel` / `ConversationView`**
(ADR 0073), scoped to a voice-capable agent pack — the ADR 0058 "chat-drivability = agent + nodes"
pattern. **No second chat system.**

## Host-implementation caveats (from the openwop-app architect review, 2026-06-23)

The pre-lock architect pass surfaced two findings. **C1 was adopted into the wire** (the steward's
§B amendment, 2026-06-23); **C2 stands as a host-implementation requirement**. Both are recorded so
the build honors the corrected shape:

- **C1 — `callTranscriber` resolves the committed turn; `voice.*` is the single canonical record
  (ADOPTED into RFC 0106 §B).** A node-facing `ctx` method returning a live `AsyncIterable` is a
  side-channel off the durable event log → `:fork` against a historical checkpoint has nothing to
  replay (`replay.md §"Determinism guarantees"` folds the durable log). **Requirement:** the host
  emits interim / `speech_start` / `endpoint_candidate` / `turn_commit` as `voice.*` run-events on
  the durable log (the **single** taxonomy — no separate iterable element, so no SSoT/replay
  ambiguity) and `callTranscriber` **resolves a `Promise` at `turn_commit`** with the committed
  turn. This is exactly the `callAI` streaming mechanism (`ai.message.chunk` deltas to the log +
  a resolved Promise, ADR 0079 §Phase 4) — the host already runs this pattern, so the corrected
  shape is *more* native than the original iterable, not less.
- **C2 — inline-base64 synthesis chunks must stay clause-sized + bounded cumulatively.** RFC 0106
  G8 locked inline-base64 chunk transport, which collides with the host's RFC 0055 256 KiB
  inline-media cap / replay-budget discipline if chunks are large or a session runs long.
  **Requirement:** the host flushes synthesis at **clause/sentence boundaries** (each chunk well
  under the 256 KiB inline cap) and enforces a per-session cumulative-event-log budget (reuse the
  ADR 0106 media cost-governance guard); past the budget, spill the audio to a tenant-scoped media
  asset `url` (ADR 0007) and carry only chunk metadata on the log.

## Security — the four RFC 0106 §F invariants the host MUST honor

The live mic is a new continuous untrusted ingress. The host MUST enforce the four §F invariants,
each extending an existing app discipline:

- **`voice-interim-not-durable`** — non-final (`isFinal:false`) transcript MUST NOT be persisted to
  durable memory / KB / replay log nor drive a side-effecting tool, until `turn_commit`. (Extends
  the ADR 0084 chat-injection-surface guard.)
- **`voice-transcript-untrusted`** — every transcript emission (interim AND final) carries
  `contentTrust:'untrusted'` + the UNTRUSTED-marker discipline (the RFC 0091 / ADR 0085 media-trust
  boundary, re-asserted per emission).
- **`voice-bargein-no-partial-leak`** — barge-in cancellation MUST NOT emit partial tool output or
  un-guardrailed partial model output; in-flight tool side effects roll back or fully complete.
- **`voice-streamref-tenant-bound`** — a `streamRef` is bound to one tenant+session, no cross-handle
  bleed, with a max-duration / max-uncommitted-audio budget (TDoS guard). Reuses the RFC 0055
  `media-asset-url-tenant-scoped` precedent.

## Phased plan (no code in this ADR)

> **As-built (2026-06-23):** P1–P4 landed the full wire-observable surface;
> P5 (mic UX) was found ALREADY PRESENT in the existing chat — see below.

- **P1 — deterministic streaming stub ✅** (#689). Over a fixture, `callTranscriber`
  emits scripted `voice.speech_start → voice.transcript(interim) → voice.endpoint_candidate
  → voice.turn_commit` and resolves its `Promise` at `turn_commit` (the corrected §B shape,
  no iterable); `voice.transcript` carries `contentTrust:'untrusted'` (§F). Proves the shape
  + the C1 durable-emission path.
- **P2 — real finite-audio transcription ✅** (#689). The non-mock `audio.url` (a host
  media-asset URL — the `streamRef → mediaRef` finalize seam) resolves tenant-scoped bytes and
  transcribes through the existing managed multimodal `callAI` audio path (RFC 0091 / ADR 0085),
  then emits the same `voice.*` turn. A non-mock `audio.streamRef` (true live streaming) is an
  honest `transcription_unsupported` — live media transport is host-internal per RFC 0106 §E.
  Advertises `realtimeVoice.transcription: "streaming"`.
- **P3 — streaming synthesis arm ✅** (#691). `callSpeechSynthesizer({stream:true})` emits
  `voice.synthesis_chunk` METADATA-ONLY run-events (bytes off the log — C2/G8) and resolves the
  whole-file Promise. Advertises `synthesis: "streaming"`.
- **P4 — barge-in lifecycle + full advertisement ✅** (#693). The `/voice/barge-in` seam
  demonstrates `voice.barge_in → voice.cancelled` with NO `voice.synthesis_chunk` after the
  cancel (the §F `voice-bargein-no-partial-leak` invariant, non-vacuous). Advertises
  `turnDetection: "semantic"` + `bargeIn: "supported"` — the host now advertises the FULL
  `realtimeVoice` surface and exercises every `voice.*` event type.
- **P5 — mic UX: ALREADY SATISFIED by the existing chat mic; nothing new built.** Voice input
  on `EmbeddedChatPanel` already ships via `chat/ChatInput.tsx` + `useAudioRecorder` (real
  `MediaRecorder`/`getUserMedia`, i18n en/es/fr/pt-BR), which attaches the recording as an
  `{type:'audio'}` ContentPart the model transcribes implicitly (RFC 0091 audio-in / ADR 0085).
  Building a second, `realtimeVoice`-driven mic would **violate `CLAUDE.md` "reuse, never recreate /
  no second chat system"** and fragment voice input for no user benefit. So the chat's voice UX is
  the existing implicit-transcription mic; the `realtimeVoice` surface (P1–P4) is the **explicit wire
  / conformance / interop contract** (`callTranscriber` + `voice.*` + the advertisement), distinct
  from the UX and complete. A true continuous-mic streaming session (live `streamRef`) remains
  host-internal per RFC 0106 §E and is not a UX we can honestly ship on a stateless host.
- **Graduation (steward-side close-out):** the host advertises `aiProviders.realtimeVoice` + the
  seams pass the gated suite non-vacuously under `OPENWOP_REQUIRE_BEHAVIOR=true`; openwop-1 lands the
  gated conformance scenarios + SDK `ctx.callTranscriber`/`streamRef` types + the three reference-impl
  →protocol §F invariant graduations + the `@openwop/openwop-conformance@1.32.0` npm publish; pair
  with a non-steward witness → drives RFC 0106 `Active → Accepted` (the RFC 0105 dual-witness pattern).

## RFC gate

This is **host work riding RFC 0106 (`Active`)** — no new RFC needed; the wire is locked and this
ADR consumes it. The host-extension `/v1/host/openwop-app/voice/*` session-bootstrap routes are
non-normative (`CLAUDE.md` host-extension rule). The G7 graduation is the explicit collaboration
with the steward (openwop crosstalk `0106`).

## Alternatives considered

1. **A bespoke voice panel / "push to talk" textarea.** Rejected — violates `CLAUDE.md` "reuse,
   never recreate"; the AiAuthorPanel precedent shows a second chat fragments + drifts. The voice
   session is the RFC 0005 conversation with an audio adapter.
2. **Defer G7 / let a non-steward host be the reference arm.** Rejected — openwop-app already holds
   the adjacent seams (ADR 0085/0086) and is the named RFC 0105 reference host; it is the cheapest,
   most honest G7 arm. Deferring strands RFC 0106 at `Active`.
3. **Leave the §B `AsyncIterable` as locked and adapt host-side.** Rejected — the architect pass
   showed it is a replay-determinism hazard (side-channel off the durable log), and the steward
   accepted the finding pre-implementation: §B is amended to `Promise`-resolves-at-`turn_commit` +
   the single `voice.*` taxonomy (C1, adopted). Because no normative surface had landed and no host
   had built the iterable, this is a free correction to an `Active` RFC's not-yet-implemented surface,
   not a v1.x wire break (`COMPATIBILITY.md`). Any *future* unworkability of the corrected shape is a
   `safety-fix` RFC conversation with the steward, not a unilateral host divergence.

## Open questions

1. Streaming ASR provider for the first live arm (Deepgram Flux vs Azure vs self-hosted
   faster-whisper) — a BYOK/cost decision, not a wire one.
2. Whether the mic `streamRef` bootstraps over a host-extension WebSocket or WebRTC (transport is
   RFC 0106-out-of-scope / host-internal) — decide at P2.
3. Telephony / multi-party voice (RFC 0101 cross-cut) — explicitly out of scope for this ADR.

---

## Follow-up action — surfacing audit (2026-06-24)

**Audit verdict:** 🟠 this ADR shipped the **wire-observable arm only** — the
`ctx.callTranscriber` / `voice.*` core plumbing + the `realtimeVoice` advert + conformance
seams. There is deliberately **no live streaming engine and no voice UI**: the user-visible
"voice" is still the existing record-a-clip mic, and a live `streamRef` honestly returns
`transcription_unsupported`. This is the intended honest boundary for this ADR, not a gap to
close here.

**Follow-up = advance ADR 0138 (Live voice mode), currently `Proposed`.** The streaming ASR
engine over `streamRef` + the `EmbeddedChatPanel` voice-mode UI belong in **0138**, riding
this ADR's `ctx.callTranscriber` / `callSpeechSynthesizer` / `voice.*` core plumbing — NOT a
retrofit here. Action: resolve 0138's open questions (ASR provider, WebSocket-vs-WebRTC
transport) and move it `Proposed → Accepted` before any live-voice UI claim.

**Boundary check:** the live arm must instantiate a `features/voice/` package that *uses* the
core plumbing (no second voice path, no named-agent special-casing) — see the
"no-parallel-architecture" rule.
