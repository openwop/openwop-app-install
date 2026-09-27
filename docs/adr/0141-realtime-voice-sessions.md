# ADR 0141 — Real-time voice sessions (OpenAI Realtime + Gemini Live, BYOK, tool-bridged)

**Status:** **implemented** (2026-06-25) — RT-1…RT-5 shipped + deployed (rev 00311-dnv). The
provider-governance boundary (why OpenAI is governed and Gemini is lower-assurance) is recorded in
**ADR 0142**.
**Date:** 2026-06-25
**Toggle:** rides the existing `voice` toggle (ADR 0138). A *realtime provider* being configured
(tenant BYOK) is what flips the experience from the ADR 0138 walkie-talkie to true real-time.
**Surface:** rides the ONE chat (the Voice button, ADR 0138) — host-extension
`/v1/host/openwop-app/voice/realtime/*` + a tenant **realtime provider** config (admin, BYOK) +
a per-provider browser session client. Composes ADR 0138 (the `voice` feature + per-agent voice),
ADR 0024 (BYOK / secret resolver), and the existing tool/RBAC/capability-firewall stack.

## Why this exists (and how it differs from ADR 0138)

ADR 0138 shipped a **chained, turn-based** pipeline: record an utterance over HTTP → transcribe the
buffered clip with the managed model → run it through the chat → synthesize the reply. It is
structurally a **walkie-talkie** — tap-to-talk, multi-second round trips, no live endpointing. It is
**not** a real-time conversation, and no amount of polish makes a chained-HTTP pipeline real-time.

ADR 0141 adds the **real thing**: a persistent **speech-to-speech** session with a realtime provider
(**OpenAI Realtime** or **Gemini Live**) that does the listening, the reasoning, *and* the speaking,
with built-in voice-activity detection, natural turn-taking, and interruption. The user **brings their
own key** and **selects the provider** (tenant-wide). The ADR 0138 pipeline **remains as a no-key
fallback** (the `voice` toggle still works without a realtime key).

## Decision

### Topology (key stays host-side; lowest latency)
1. The browser asks the host to open a session (`POST …/voice/realtime/session` with the scoped agent).
2. The host resolves the **tenant realtime config** (provider + `credentialRef`, BYOK), mints a
   **short-lived ephemeral token** from the stored key, and returns a `RealtimeSessionConfig`:
   `{ provider, clientSecret/token, model, voice, instructions, tools, connect: {kind, url} }`.
   The long-lived key NEVER leaves the host (only an ephemeral, scoped token does).
3. The browser connects **directly to the provider** with the token — **WebRTC** (OpenAI) /
   **WebSocket** (Gemini) — streaming mic up + audio down continuously.
4. **Tool calls bridge back through the host.** The provider's model emits a function call → the
   browser relays it to `POST …/voice/realtime/tool-call` → the host executes it through the EXISTING
   tool stack (RBAC + capability firewall ADR 0135 + HITL) → returns the result → the browser sends it
   back into the session. Tool *execution* is host-side; only the *call/return* transits the browser.

### Provider abstraction (researched against current APIs, 2026-06)
A `RealtimeProvider` interface with two adapters; the rest of the system is provider-agnostic.
- **`openai-realtime`** — `POST https://api.openai.com/v1/realtime/client_secrets` (BYOK key) → ephemeral
  client secret; browser does WebRTC; model `gpt-realtime`; audio under `session.audio`; tools +
  instructions configured server-side in the session payload.
- **`gemini-live`** — `AuthTokenService.CreateToken` (v1alpha) → ephemeral token; browser WebSocket to
  the v1alpha `BidiGenerateContent` endpoint; first message `BidiGenerateContentSetup` carries
  model + `system_instruction` + `tools`; function calls over `toolCall`/`toolResponse` messages.

### The agent's identity in a realtime session
The realtime model runs the LLM, so the agent's identity is configured INTO the session, not generated
by the chat-responder:
- **instructions** = the scoped agent's persona (the `feature.voice.agents` prompt / `agentProfile`).
- **voice** = the agent's configured voice where the provider supports it (ADR 0138 per-agent voice;
  realtime voices are provider-native).
- **tools** = the agent's allowed tools, projected to each provider's function-declaration shape; the
  host bridge enforces the same RBAC/firewall/HITL a typed turn would.

### Configuration (tenant-wide, BYOK — per the product decision)
A tenant **realtime provider** setting (admin): `{ provider: 'openai-realtime' | 'gemini-live' | 'off',
credentialRef }`. Stored host-side; the BYOK key is added on the Keys page and referenced by
`credentialRef`. `off` (default) → the ADR 0138 fallback.

## Security
- **Key isolation:** the long-lived BYOK key is resolved host-side (`secretResolver`, ADR 0024) ONLY to
  mint a short-lived ephemeral token; it is never returned to the browser.
- **Tool auth on voice:** voice-initiated tool calls run through the SAME RBAC + capability firewall
  (ADR 0135) + HITL as typed turns — a spoken "send the email" is gated identically. The realtime model
  cannot bypass host policy because execution is host-side.
  **Correction (ADR 0324, 2026-07-09):** "the SAME as typed turns" held for
  allowlist/firewall/executor but NOT for the execution *scope*: the bridge
  omitted `actingUserId`/`conversationId` (which ADR 0308/0309 later threaded
  into the chat loop only), so the deliverable tools failed closed over voice.
  The scope is now composed by the one shared composer
  (`createScopedAgentToolProvider`), with the acting user host-bound at session
  open — see ADR 0324.
- **Untrusted transcript:** the user's speech transcript carries `contentTrust:'untrusted'` (RFC 0106 §F)
  before it can drive a side effect.
- **Tenant binding / budget:** the session is tenant+agent bound; per-session duration/cost budget
  (ADR 0106) — a realtime session is metered upstream by the provider on the user's own key (BYOK), so
  host cost-governance is advisory, but the session lifetime is bounded.

## RFC gate
**Host work — no new RFC.** The realtime providers are external; the browser↔provider session + the
host tool-bridge are **host-internal** (RFC 0106 §E explicitly leaves live transport host-internal). The
`/v1/host/openwop-app/voice/realtime/*` routes are non-normative host-extensions. It rides the existing
`aiProviders.realtimeVoice` advertisement (ADR 0109/0138). **One conditional trigger:** if we add a
discoverable capability flag distinguishing chained vs speech-to-speech, that's an additive RFC 0106
amendment (steward) — avoided by keeping it host-internal.

## Phased plan (each increment verifiable with a key)
- **RT-1 (this ADR)** — the `RealtimeProvider` abstraction + 2 adapters, the tenant realtime config, and
  `POST …/voice/realtime/session` (mint token + return config). **Verify:** configure a key + provider,
  `curl` the session endpoint → a valid ephemeral token + config, or a clear error.
- **RT-2** — the host tool-execution bridge (`POST …/voice/realtime/tool-call`) through the existing
  tool/RBAC/firewall/HITL stack; tool declarations from the agent's allowed tools.
- **RT-3** — the browser realtime client (WebRTC/WS per provider), mic/audio/transcript/interruption, the
  tool-call relay, and the admin selection UI. Wired into the Voice button (realtime when configured;
  walkie-talkie fallback otherwise).

## Alternatives considered
1. **Keep iterating the chained pipeline.** Rejected — structurally turn-based; can't be real-time.
2. **Host proxies the audio (browser ↔ host ↔ provider).** Rejected for v1 — higher latency + the host
   streams audio; the ephemeral-token + browser-direct topology keeps the key host-side without proxying.
3. **One provider only.** Rejected per the product decision — both, user-selectable via BYOK.
4. **Generate the reply in the chat-responder, realtime only for I/O.** Rejected — that's the ADR 0138
   chained model (turn-based). Real-time means the provider's realtime model runs the turn; the agent's
   tools bridge back to the host.

## Open questions
1. OpenAI WebRTC vs WebSocket for the browser (WebRTC recommended for browser audio) — RT-3.
2. Gemini Live voice/model coverage for per-agent voice parity with OpenAI — RT-3.
3. HITL UX for a voice-initiated approval gate (spoken confirmation vs the interrupt card) — RT-2/RT-3.
4. Replay: a realtime session's turns are summarized into the conversation log post-hoc (the provider
   owns the live stream); exact granularity — RT-2.

## RT-4 correction — OpenAI sideband (host owns the session)

An architecture review (web-grounded against OpenAI/Gemini/LiveKit current guidance) found the
RT-2/RT-3 browser-direct + client-relay design had two blocking gaps for a governance tenant:
(#1) the firewall `seen`-set keyed on a **client-supplied** session id → the composition-aware
Capability Firewall (ADR 0135) was bypassable by rotating the id; (#2) the realtime dialogue lived
only in the provider session → **no chat/audit record** (contradicting "rides the ONE chat").

Root cause: the host did not participate in the session. Fix (OpenAI), per OpenAI's own
server-controls guidance — the **sideband**: the host **mediates the WebRTC SDP**
(`POST /voice/realtime/openai/connect`), learns the `call_id` (SDP `Location` header), and opens a
server-side WebSocket (`?call_id=…`, real BYOK key) that (a) **executes tool calls** through the
existing allowlist + firewall + executor keyed on the **host-owned `call_id`** and (b) **persists
every transcript** to the conversation. The browser keeps only the audio — it mints/holds no token,
relays no tools, and holds no session id. This retires #1 and #2 for OpenAI. The live WS is
verify-with-key; `handleSidebandEvent` is pure + unit-tested.

**Gemini** has no sideband; it stays on the constrained-token + client-relay path (lower assurance)
pending the server-mediation deep-dive. **Topology:** the sideband WS is a stateful per-instance
connection (session affinity); if the instance handling a session dies, tools/transcripts stop but
browser↔OpenAI audio continues (graceful degradation). Admin-role-gating the config PUT remains open.

## RT-5 — Gemini constrained token (option A, lower assurance)

The Gemini deep-dive (web-grounded) confirmed Gemini Live has **no sideband**, so the RT-4 fix
doesn't port: governance parity would require the host to be in the media path (server-mediation
/ a managed platform — deferred). The shippable hardening now is option A: mint a **constrained**
ephemeral token (`liveConnectConstraints` locks model + system instruction + the agent's tools
server-side), so a tampered browser can't self-grant tools or change the persona. Gemini still
terminates in the browser, so tool **execution** + **transcripts** remain client-relayed — this
hardens the *config*, not those. The admin UI **labels Gemini Live as lower assurance** (not for
governance/audit tenants; OpenAI Realtime keeps these host-side). `buildGeminiConstraint` is pure +
unit-tested; the live token mint is verify-with-key. Provider-specific-vs-unified-server-mediation
remains the open strategic call (RT-4 note).

**RT-5a — Gemini audio correction (functional).** The first Gemini client streamed `audio/webm` and never played the model audio — non-functional. Corrected to Gemini Live's actual wire: capture raw **PCM16** via Web Audio and send `realtimeInput.audio` (`audio/pcm;rate=<ctx>`); decode + schedule the model's **PCM16** from `serverContent.modelTurn.parts[].inlineData` for gapless playback; barge-in via `serverContent.interrupted`; transcription enabled in `setup`. Verify-in-browser. (OpenAI's WebRTC path needs no such fix — the codec is negotiated natively.)

**RT-6 — production correction (2026-07-02): voice mocks decoupled from the conformance seam
flag.** Every voice mock (Gemini ephemeral-token stub, OpenAI Realtime session/SDP stubs, the
`useMock` TTS path, and the deterministic `live transcript (N bytes)` STT stub in
`aiProvidersHost.transcribeStreamRef`) keyed on `OPENWOP_TEST_SEAM_ENABLED` — but production
keeps that flag **on** for the `/v1/host/sample/*` conformance seam ROUTES, so every real user
got mocked voice: the browser received the fake `auth_tokens/test_gemini` token (then failed),
and spoken audio would transcribe to the stub string. Corrected: voice mocks now key on their
own **`OPENWOP_VOICE_MOCK`** flag (tests set it; prod leaves it unset ⇒ real provider calls),
while `provider:'mock'`-guarded paths keep the seam flag as defense-in-depth (an explicit mock
provider request is never sent by the real UI). Companion frontend fix: `connect-src` in
`firebase.json` now allows `wss://generativelanguage.googleapis.com` — the Gemini Live
BidiGenerateContent WebSocket (by design browser-direct with the constrained single-use token,
RT-5) was CSP-blocked, so the arm could never connect even with a real token.

**RT-7 — Gemini token-mint wire correction (2026-07-03).** RT-6's un-mocking exposed the
verify-with-key drift on the first real mint: prod returned 502 `realtime_provider_error`. Probed
against the live API (a bad-key POST validates the payload *shape* before the key, so the request
shape is fully verifiable key-free) + the v1alpha discovery document:
- The REST path is **`POST /v1alpha/auth_tokens`** (snake_case) — the camelCase `/v1alpha/authTokens`
  404s outright.
- The body is an **`AuthToken`** resource — `{uses, expireTime?, newSessionExpireTime?, fieldMask?,
  bidiGenerateContentSetup?}`. The SDK docs' `liveConnectConstraints` is a **client-SDK abstraction**,
  not a wire field (`400 Unknown name "liveConnectConstraints" at 'auth_token'`).
- The RT-5 lock maps to **`bidiGenerateContentSetup` + empty `fieldMask`**: setup present + empty mask
  ⇒ the effective setup comes ENTIRELY from the token and the client's `setup` message is IGNORED —
  a *stronger* lock than intended, with the corollary that the token setup must carry everything the
  client sent, including `inputAudioTranscription`/`outputAudioTranscription` (RT-5a), or they are
  silently dropped. The corrected `buildGeminiConstraint` mirrors the full client setup.
- The minted token is the response's `name` (adapter already read `token ?? name` — unchanged); the
  WS connect passes it as `access_token=` (unchanged).
- `DEFAULT_MODEL` updated to the docs' current Live example (`gemini-3.1-flash-live-preview`);
  admins override per-tenant via `config.model`. Model existence remains the one verify-with-key
  residue (validated at mint/connect time by Google, surfaced through the honest 502 envelope).

**RT-7 follow-up (SHIPPED):** agent-scoped voice sessions pinned RAW tool ids
(`openwop:knowledge.search`) into the provider payloads — provider function names reject `:`/`.`
(the #578 class), so the first agent-with-tools mint/session would 400. Fixed with the #578
sanitize+reverse-map pattern at the realtime seams: `resolveAgentToolDecls` now emits
`sanitizeToolName`-ed decl names (the decls are consumed ONLY at provider egress — the Gemini token
setup + both OpenAI payloads), `buildGeminiConstraint` additionally projects each decl's parameter
schema through `toGeminiSchema` (Gemini rejects `additionalProperties`/`minLength`/… wholesale), and
the single ingress chokepoint `executeRealtimeToolCall` resolves the provider's wire name back to
the canonical allowlisted id via the pure `resolveWireToolName` (exact match wins; else
sanitized-form match; neither ⇒ default-deny) — so the allowlist, the capability firewall + its
composition seen-set, and the executor all keep operating on the SAME canonical ids typed-chat
uses. Both callback paths (the Gemini `…/tool-call` relay route and the OpenAI server-side
sideband) funnel through that chokepoint, so one mapping covers both providers.

**RT-8 — AudioWorklet capture + the live-voice waveform (2026-07-03).**
*Capture:* the Gemini mic path moved off the deprecated `ScriptProcessorNode` onto an
`AudioWorkletNode` (`pcmCaptureWorklet.js`, same 4096-sample cadence, off the main thread).
The worklet MUST ship as a real same-origin asset — Vite's small-asset inlining would emit a
`data:` URL, which `audioWorklet.addModule` loads as a script and CSP `script-src 'self'`
blocks in production; a per-file `assetsInlineLimit` exemption pins it. ScriptProcessor
survives only as the no-audioWorklet fallback (older Safari).
*Waveform:* the live conversation now renders a real-audio animation — `VoiceWaveform.tsx`, a
scrolling mirrored bar strip in the composer's live pill. Driven by analysis-only
`AnalyserNode` taps (`VoiceAudioGraph {input, output}`) surfaced through
`RealtimeCallbacks.onAudioGraph` on BOTH providers: Gemini taps the mic source + the
`GeminiPcmPlayer` playback chain (sources now route src → analyser → destination, so the tap
observes exactly what is audible); OpenAI taps mic + the remote WebRTC track on a dedicated
analysis context (playback stays on the `<audio>` element). Mic level paints `--clay` bars,
model speech `--color-info`, idle `--color-border` — whoever is louder wins the time-slot, with
a fast-attack/slow-release envelope (pure, unit-tested `audioLevels.ts`). Token colors resolve
at draw time (theme flips apply live); `prefers-reduced-motion` degrades to a non-scrolling
8 fps meter; the canvas is `aria-hidden` (the stop button carries state). Lazy-loaded from
`ChatInput` — the entry chunk stays inside the bundle budget. The walkie fallback has no live
audio graph and keeps the plain hot button (honest: no fake animation without real levels).

**RT-8a — the waveform extends to clip recording (2026-07-03).** `useAudioRecorder` now opens an
analysis-only `AudioContext` + `AnalyserNode` tap on the mic stream for the life of a recording
(guarded: where `AudioContext` is unavailable there is simply no waveform — recording itself is
unaffected; the tap closes on stop/cancel/unmount). `ChatInput`'s recording state renders the same
`VoiceWaveform` in a `.is-rec` pill with `tone="recording"` — an input-only graph, mic bars in
`--color-danger` and danger-derived pill chrome (`--danger-rule`/`--danger-wash`, the clay recipe
applied to danger) — preserving the color language: red = recording a clip, clay = in a live
conversation. No analyser ⇒ the plain hot button (no fake bars, no empty pill chrome).

**RT-9 — the Gemini Live conversation loop (2026-07-03).** The first real end-to-end session
(post RT-6/RT-7) "listened but never answered": no model speech, no transcripts, no turn
detection. Four defects, all client-side:
1. **Input rate.** Capture ran at the device rate (44.1/48 kHz) with an honest `rate=` tag —
   but the Live API requires **16 kHz** PCM16 input, so speech detection never triggered.
   The capture context now opens at 16 kHz (browsers resample internally; fallback to the
   default context if construction throws, still honestly tagged).
2. **Handshake.** Audio streamed the moment the socket opened and "live" was client-derived.
   Capture now starts on the server's **`setupComplete`** — "live" means the server said so.
   (With the RT-7 token-locked setup the client's `setup` message content is ignored, but
   sending it still drives the handshake.)
3. **Silent death.** A refused/dropped session (e.g. an invalid model in the token) just kept
   "listening". Abnormal close — or close before `setupComplete` — now surfaces the server's
   code/reason as an honest error.
4. **Transcripts had no consumer.** `onTranscript` was emitted per-fragment and dropped.
   A `TranscriptAccumulator` (pure, unit-tested) folds Gemini's incremental fragments into
   whole turns — the user's utterance flushes when the model starts answering (thread reads
   user → assistant), the model's on `turnComplete`/barge-in/teardown — and the turns surface
   as chat bubbles via `onTranscript → useRealtimeVoice → LiveVoiceController.onLiveTranscript
   → ConversationView → ChatSidebar → useChatSession.appendTranscriptTurn` (display-only
   appends riding the normal persist path — NOT sends; the realtime model already answered by
   voice, so dispatching would double-respond). Embeds omit the prop ⇒ no transcript bubbles.
Companion CSP fix: `media-src 'self' data: blob:` — the multimodal voice-clip bubble (ADR 0067
correction) renders its audio via a `data:` URL, which fell back to `default-src 'self'` and
was blocked (player showed 0:00).

**RT-9a — capture at the native rate, resample in the worklet (2026-07-03).** RT-9's forced
16 kHz `AudioContext` trips Chrome's `MediaStreamSource` rate limitation — the live session
died "as soon as I start talking". Corrected: the capture context runs at the mic's NATIVE
rate and the worklet downsamples to 16 kHz via linear interpolation (2048-sample output
chunks, 128 ms; the ScriptProcessor fallback resamples through the pure, unit-tested
`audioLevels.resamplePcm` — same algorithm, kept in step with the worklet's inline copy).
The `rate=16000` tag is now always the TRUE payload rate. Companion fix: `useRealtimeVoice`
captured session errors but `RealtimeController` never consumed them, so a server-side close
looked like a silent stop — errors now surface as a toast, so the NEXT failure names itself
(model, quota, rejected audio) instead of dying quietly.

**RT-9b — the constrained bidi endpoint (2026-07-03).** RT-9a's error surfacing immediately paid
off: the live session died with "Gemini Live closed (1000) before setup completed" — the server
accepted the socket (token valid), then closed cleanly without `setupComplete`. Web research
(the Live WebSockets API reference + the ephemeral-tokens guide + AI-dev-forum reports) pinned
it: **an ephemeral token authenticates only `v1alpha.GenerativeService.BidiGenerateContentConstrained`**;
connecting it to the plain `BidiGenerateContent` method yields exactly this silent-close
signature. One-line host fix: the `/session` seam's `connect.url` now points at the Constrained
method. Confirmed against the docs while there: the client still SENDS its `setup` message on
the constrained endpoint (the token's `bidiGenerateContentSetup` governs — the RT-7 lock; a
client-sent `systemInstruction` is ignored there, which is why ours rides in the token), and
`gemini-3.1-flash-live-preview` is a currently-listed Live model (default unchanged;
`gemini-2.5-flash-native-audio-preview-12-2025` is the documented flagship alternative if the
tenant config ever needs it).

**RT-9c — LIVE transcript rendering (2026-07-03).** With two-way voice working (RT-9b), the
transcripts only appeared as WHOLE turns after each side finished. Now they stream live:
`TranscriptAccumulator` emits an interim update on every fragment (`final:false`, growing text)
under a STABLE per-turn id, then a settling `final:true` on flush. The consumer
(`useChatSession.upsertTranscriptTurn`) UPSERTS one bubble per turn — interim updates patch the
same message (`isStreaming:true` ⇒ the live-reveal cadence), `final` settles it — instead of the
prior append-only whole-turn behavior. Turn ids are prefixed with the realtime session id so a
stop→start never collides bubbles. So your spoken words paint as you talk, and the model's reply
streams in as it speaks — the "print it live" ask. Persists via the existing session→
persistSession effect, so completed voice turns survive reload. Chain unchanged end-to-end
(`onTranscript → useRealtimeVoice → LiveVoiceController.onLiveTranscript → ConversationView →
ChatSidebar → upsertTranscriptTurn`); only the signature widened to `(text, role, turnId, final)`.
