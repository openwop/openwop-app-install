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
